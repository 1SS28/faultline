import { runScenario } from '../core/runner.js';
import { scenarios, strategies, type Scenario, type Strategy } from '../core/types.js';
import type { Executor } from './executor.js';
import type { JobStore } from './store.js';
import type { Job, JobInput } from './types.js';
import { JobWorker } from './worker.js';

/** The job isn't finished. The queue should deliver the message again later. */
export class RetryLater extends Error {}

/** Runs fixtures in the current process, for hosts that already isolate each invocation, such as AWS Lambda. */
export const executeInProcess: Executor = input => runScenario(input);

export function parseJobInput(body: string): JobInput {
  const input: unknown = JSON.parse(body);
  if (typeof input !== 'object' || input === null) throw new Error('A job message must be a JSON object');
  const { scenario, strategy } = input as Record<string, unknown>;
  if (!scenarios.includes(scenario as Scenario) || !strategies.includes(strategy as Strategy)) {
    throw new Error(`Unsupported scenario or strategy. Scenarios: ${scenarios.join(', ')}. Strategies: ${strategies.join(', ')}.`);
  }
  return { scenario: scenario as Scenario, strategy: strategy as Strategy };
}

const finished = (job: Job) => job.status === 'completed' || job.status === 'errored';

/** The idempotency key of the job created for a queue message, so the message ID can find it later. */
export const deliveryKey = (messageId: string) => `message:${messageId}`;

/**
 * Handles one message from an at-least-once queue such as SQS. The message ID becomes the job's
 * idempotency key, so a message delivered twice finds the job it already created instead of
 * running the fixture again.
 */
export async function processDelivery(jobs: JobStore, input: JobInput, messageId: string, execute = executeInProcess): Promise<Job> {
  const { job } = await jobs.enqueue(input, deliveryKey(messageId));
  if (!finished(job)) {
    const claim = await jobs.claim(30_000, job.id);
    if (claim) await new JobWorker(jobs, execute).process(claim);
  }
  const current = await jobs.get(job.id);
  if (!current) throw new Error(`Job ${job.id} no longer exists`);
  // Either queued for a retry or running under another delivery's lease.
  if (!finished(current)) throw new RetryLater(`Job ${job.id} is ${current.status}${current.error ? `: ${current.error}` : ''}`);
  const { history: _history, ...result } = current;
  return result;
}
