import type { SQSBatchResponse, SQSEvent } from 'aws-lambda';
import { parseJobInput, processDelivery, RetryLater } from '../../src/jobs/delivery.js';
import { reuseStores } from './database.mjs';

const stores = reuseStores();

export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const { jobs } = await stores();
  const batchItemFailures: SQSBatchResponse['batchItemFailures'] = [];
  for (const record of event.Records) {
    try {
      const job = await processDelivery(jobs, parseJobInput(record.body), record.messageId);
      const run = job.runId ? await jobs.runs.get(job.runId) : undefined;
      console.log(JSON.stringify({
        messageId: record.messageId, jobId: job.id, job: job.status, attempts: job.attempts, error: job.error ?? undefined,
        runId: job.runId ?? undefined, run: run?.status, failedChecks: run?.assertions.filter(check => !check.passed).map(check => check.label),
      }));
    } catch (error) {
      // Reporting only this message as failed lets SQS retry it without redelivering the rest of the batch.
      batchItemFailures.push({ itemIdentifier: record.messageId });
      const log = error instanceof RetryLater ? console.warn : console.error;
      log(JSON.stringify({ messageId: record.messageId, retry: true, error: error instanceof Error ? error.message : String(error) }));
    }
  }
  return { batchItemFailures };
}
