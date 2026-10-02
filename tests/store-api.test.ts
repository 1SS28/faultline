import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { connectDatabase, type Database } from '../src/db/database.js';
import { RunStore } from '../src/db/store.js';
import { runScenario } from '../src/core/runner.js';
import { createApp } from '../src/api/app.js';

let db: Database;
let store: RunStore;
let app: ReturnType<typeof createApp>;
before(async () => {
  db = await connectDatabase({ memory: true });
  store = new RunStore(db);
  await store.migrate();
  app = createApp(store);
});
after(async () => { await app?.close(); await db?.close(); });

test('SQL stores and reconstructs the execution evidence', async () => {
  const run = await runScenario({ scenario: 'timeout-after-commit', strategy: 'resilient' });
  await store.save(run);
  const saved = await store.get(run.id);
  assert.ok(saved);
  assert.deepEqual(saved.events, run.events);
  assert.deepEqual(saved.refunds, run.refunds);
  assert.equal(saved.status, 'passed');
  assert.equal(saved.assertions.length, 4);
});
test('a child-row failure rolls back the whole run', async () => {
  const run = await runScenario({ scenario: 'baseline', strategy: 'resilient' });
  run.events.push(run.events[0]!); // Duplicate (run_id, sequence) violates the evidence constraint.
  await assert.rejects(() => store.save(run));
  assert.equal(await store.get(run.id), undefined);
});
test('API executes, persists, and retrieves an actual failed run', async () => {
  const response = await app.inject({ method: 'POST', url: '/api/runs', payload: { scenario: 'timeout-after-commit', strategy: 'naive' } });
  assert.equal(response.statusCode, 201);
  const run = response.json();
  assert.equal(run.status, 'failed');
  assert.equal(run.refunds.length, 2);
  const read = await app.inject({ method: 'GET', url: response.headers.location as string });
  assert.equal(read.statusCode, 200);
  assert.deepEqual(read.json().events, run.events);
});
test('API rejects unknown scenarios and invalid IDs', async () => {
  assert.equal((await app.inject({ method: 'POST', url: '/api/runs', payload: { scenario: 'arbitrary-code', strategy: 'naive' } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'GET', url: '/api/runs/not-a-uuid' })).statusCode, 400);
  assert.equal((await app.inject({ method: 'GET', url: `/api/runs/${randomUUID()}` })).statusCode, 404);
});
test('SQL summary reports evidence-based pass rates', async () => {
  const summary = await store.summary();
  const row = summary.find(row => row.agentVersion === 'fixture/naive/v1' && row.scenario === 'timeout-after-commit');
  assert.ok(row);
  assert.equal(row.failures, 1);
  assert.equal(row.passRate, 0);
});
