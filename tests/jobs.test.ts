import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectDatabase, type Database } from '../src/db/database.js';
import { RunStore } from '../src/db/store.js';
import { JobStore, IdempotencyConflict, LeaseLost } from '../src/jobs/store.js';
import { JobWorker } from '../src/jobs/worker.js';
import { executeFixture } from '../src/jobs/executor.js';
import { runScenario } from '../src/core/runner.js';
import { createApp } from '../src/api/app.js';

let db: Database;
let jobs: JobStore;
let runs: RunStore;
const input = { scenario: 'timeout-after-commit', strategy: 'resilient' } as const;
before(async () => {
  db = await connectDatabase({ memory: true });
  runs = new RunStore(db); await runs.migrate(); jobs = new JobStore(db, runs);
});
beforeEach(async () => { await db.query('TRUNCATE billing_trials, job_attempts, jobs, trace_events, refunds, assertions, runs'); });
after(async () => { await db?.close(); });

test('duplicate submissions share one job; changed input with the same key is rejected', async () => {
  const results = await Promise.all([jobs.enqueue(input, 'request-1'), jobs.enqueue(input, 'request-1')]);
  assert.equal(results[0]!.job.id, results[1]!.job.id);
  assert.equal(results.filter(result => result.created).length, 1);
  await assert.rejects(() => jobs.enqueue({ ...input, strategy: 'naive' }, 'request-1'), IdempotencyConflict);
  assert.equal((await jobs.list()).length, 1);
});
test('only one worker claims an eligible job', async () => {
  await jobs.enqueue(input);
  const claims = await Promise.all([jobs.claim(), jobs.claim(), jobs.claim()]);
  assert.equal(claims.filter(Boolean).length, 1);
  const claimed = claims.find(Boolean)!;
  assert.equal(claimed.job.attempts, 1);
  assert.equal((await jobs.get(claimed.job.id))!.history.length, 1);
});
test('expired workers are replaced, and stale completion cannot create orphan evidence', async () => {
  const { job } = await jobs.enqueue(input);
  const old = (await jobs.claim())!;
  await db.query("UPDATE jobs SET lease_until = now() - interval '1 second' WHERE id = $1", [job.id]);
  const next = (await jobs.claim())!;
  assert.notEqual(next.token, old.token);
  assert.equal(next.job.attempts, 2);
  const staleRun = await runScenario(input);
  await assert.rejects(() => jobs.complete(old, staleRun), LeaseLost);
  assert.equal(await runs.get(staleRun.id), undefined);
  assert.equal(await jobs.renew(old), false);
  const validRun = await runScenario(input);
  await jobs.complete(next, validRun);
  const saved = (await jobs.get(job.id))!;
  assert.equal(saved.status, 'completed');
  assert.deepEqual(saved.history.map(attempt => attempt.status), ['expired', 'completed']);
  assert.equal(saved.runId, validRun.id);
});
test('completing a job twice stores only one run', async () => {
  const { job } = await jobs.enqueue(input);
  const claim = (await jobs.claim())!;
  await jobs.complete(claim, await runScenario(input));
  await assert.rejects(async () => jobs.complete(claim, await runScenario(input)), LeaseLost);
  assert.equal((await runs.list()).length, 1);
  assert.equal((await jobs.get(job.id))!.status, 'completed');
});
test('result and completed job state roll back together if evidence is invalid', async () => {
  const { job } = await jobs.enqueue(input);
  const claim = (await jobs.claim())!;
  const run = await runScenario(input); run.events.push(run.events[0]!);
  await assert.rejects(() => jobs.complete(claim, run));
  assert.equal(await runs.get(run.id), undefined);
  assert.equal((await jobs.get(job.id))!.status, 'running');
});
test('execution errors retry with a bound and retain every attempt', async () => {
  const { job } = await jobs.enqueue(input);
  for (let attempt = 1; attempt <= 3; attempt++) {
    const claim = (await jobs.claim())!;
    assert.equal(claim.job.attempts, attempt);
    assert.equal(await jobs.fail(claim, `crash ${attempt}`, 0), true);
  }
  assert.equal(await jobs.claim(), undefined);
  const saved = (await jobs.get(job.id))!;
  assert.equal(saved.status, 'errored');
  assert.equal(saved.error, 'crash 3');
  assert.deepEqual(saved.history.map(attempt => attempt.status), ['errored', 'errored', 'errored']);
});
test('backoff prevents immediate retry and an expired final attempt becomes terminal', async () => {
  const { job } = await jobs.enqueue(input);
  const first = (await jobs.claim())!;
  await jobs.fail(first, 'temporary outage', 60_000);
  assert.equal(await jobs.claim(), undefined);
  await db.query("UPDATE jobs SET available_at = now(), max_attempts = 2 WHERE id = $1", [job.id]);
  await jobs.claim();
  await db.query("UPDATE jobs SET lease_until = now() - interval '1 second' WHERE id = $1", [job.id]);
  assert.equal(await jobs.claim(), undefined);
  const saved = (await jobs.get(job.id))!;
  assert.equal(saved.status, 'errored');
  assert.equal(saved.history[1]!.status, 'expired');
});
test('real worker executes a failed fixture without treating a test failure as infrastructure failure', async () => {
  const { job } = await jobs.enqueue({ ...input, strategy: 'naive' });
  const worker = new JobWorker(jobs);
  assert.equal(await worker.tick(), true);
  const completed = (await jobs.get(job.id))!;
  assert.equal(completed.status, 'completed');
  assert.equal(completed.attempts, 1);
  assert.equal((await runs.get(completed.runId!))!.status, 'failed');
});
test('fixture subprocess has a real wall-clock deadline', async () => {
  await assert.rejects(() => executeFixture(input, new AbortController().signal, 1), /deadline/);
});
test('worker records an execution error and requeues for retry', async () => {
  const { job } = await jobs.enqueue(input);
  const worker = new JobWorker(jobs, async () => { throw new Error('Fixture process crashed'); });
  await worker.tick();
  const result = (await jobs.get(job.id))!;
  assert.equal(result.status, 'queued');
  assert.equal(result.history[0]!.status, 'errored');
  assert.equal(result.history[0]!.error, 'Fixture process crashed');
});
test('job API accepts work without executing it and preserves idempotency', async () => {
  const app = createApp(runs);
  try {
    const request = { method: 'POST' as const, url: '/api/jobs', payload: input, headers: { 'idempotency-key': 'api-job' } };
    const response = await app.inject(request);
    assert.equal(response.statusCode, 202);
    assert.equal(response.json().status, 'queued');
    assert.equal((await runs.list()).length, 0);
    const duplicate = await app.inject(request);
    assert.equal(duplicate.statusCode, 200);
    assert.equal(duplicate.json().id, response.json().id);
    const conflict = await app.inject({ ...request, payload: { ...input, strategy: 'naive' } });
    assert.equal(conflict.statusCode, 409);
    const status = await app.inject({ method: 'GET', url: response.headers.location as string });
    assert.equal(status.statusCode, 200);
    assert.deepEqual(status.json().history, []);
  } finally { await app.close(); }
});
test('queued jobs survive closing and reopening disk-backed PostgreSQL', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'faultline-jobs-'));
  let disk: Database | undefined;
  try {
    disk = await connectDatabase({ directory });
    await new RunStore(disk).migrate();
    const { job } = await new JobStore(disk).enqueue(input);
    await disk.close(); disk = undefined;
    disk = await connectDatabase({ directory });
    const recovered = new JobStore(disk);
    assert.equal((await recovered.get(job.id))!.status, 'queued');
    assert.equal((await recovered.claim())!.job.id, job.id);
  } finally { await disk?.close(); await rm(directory, { recursive: true, force: true }); }
});
