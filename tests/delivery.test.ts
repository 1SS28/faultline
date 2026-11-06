import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { runScenario } from '../src/core/runner.js';
import { connectDatabase, type Database } from '../src/db/database.js';
import { RunStore } from '../src/db/store.js';
import { parseJobInput, processDelivery, RetryLater } from '../src/jobs/delivery.js';
import type { Executor } from '../src/jobs/executor.js';
import { JobStore } from '../src/jobs/store.js';

let db: Database;
let jobs: JobStore;
let runs: RunStore;
const input = { scenario: 'timeout-after-commit', strategy: 'naive' } as const;
before(async () => {
  db = await connectDatabase({ memory: true });
  runs = new RunStore(db); await runs.migrate(); jobs = new JobStore(db, runs);
});
beforeEach(async () => { await db.query('TRUNCATE billing_trials, job_attempts, jobs, trace_events, refunds, assertions, runs'); });
after(async () => { await db?.close(); });

test('a message delivered twice runs the fixture once', async () => {
  const first = await processDelivery(jobs, input, 'message-1');
  const again = await processDelivery(jobs, input, 'message-1');
  assert.equal(first.status, 'completed');
  assert.equal(again.id, first.id);
  assert.equal(again.runId, first.runId);
  assert.equal((await runs.list()).length, 1);
  // The naive agent refunds twice when the reply is lost, so the run itself fails.
  assert.equal((await runs.get(first.runId!))!.status, 'failed');
});

test('a crashed execution retries on later deliveries, then ends as errored', async () => {
  const crash: Executor = async () => { throw new Error('fixture crashed'); };
  for (let attempt = 1; attempt < 3; attempt++) {
    await assert.rejects(() => processDelivery(jobs, input, 'message-2', crash), RetryLater);
    // Skip the retry backoff instead of waiting for it.
    await db.query('UPDATE jobs SET available_at = now()');
  }
  const job = await processDelivery(jobs, input, 'message-2', crash);
  assert.equal(job.status, 'errored');
  assert.equal(job.attempts, 3);
  assert.equal(job.error, 'fixture crashed');
});

test('a duplicate that arrives mid-run waits for the first delivery', async () => {
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const running = new Promise<void>(resolve => { started = resolve; });
  const slow: Executor = async job => { started(); await gate; return runScenario(job); };
  const first = processDelivery(jobs, input, 'message-3', slow);
  await running;
  await assert.rejects(() => processDelivery(jobs, input, 'message-3'), RetryLater);
  release();
  assert.equal((await first).status, 'completed');
  assert.equal((await runs.list()).length, 1);
});

test('claiming by ID leaves older queued jobs alone', async () => {
  const older = (await jobs.enqueue(input)).job;
  const newer = (await jobs.enqueue(input)).job;
  assert.equal((await jobs.claim(30_000, newer.id))?.job.id, newer.id);
  assert.equal((await jobs.get(older.id))!.status, 'queued');
});

test('messages must name a known scenario and strategy', () => {
  assert.deepEqual(parseJobInput('{"scenario":"rate-limit","strategy":"resilient"}'), { scenario: 'rate-limit', strategy: 'resilient' });
  assert.throws(() => parseJobInput('{"scenario":"rate-limit"}'), /Unsupported/);
  assert.throws(() => parseJobInput('null'), /JSON object/);
  assert.throws(() => parseJobInput('not json'), SyntaxError);
});
