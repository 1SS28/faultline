import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { connectDatabase, type Database } from '../../src/db/database.js';
import { RunStore } from '../../src/db/store.js';
import { processDelivery } from '../../src/jobs/delivery.js';
import { JobStore } from '../../src/jobs/store.js';
import { createHandler } from '../functions/api.mjs';

let db: Database;
let jobs: JobStore;
let handler: ReturnType<typeof createHandler>;
before(async () => {
  db = await connectDatabase({ memory: true });
  const runs = new RunStore(db);
  await runs.migrate();
  jobs = new JobStore(db, runs);
  handler = createHandler(async () => ({ runs, jobs }));
});
after(async () => { await db?.close(); });

const get = async (resource: string, id?: string) => {
  const response = await handler({ httpMethod: 'GET', resource, path: resource, pathParameters: id ? { id } : null } as unknown as APIGatewayProxyEvent);
  return { status: response.statusCode, body: JSON.parse(response.body) };
};

test('a job is found by the ID POST /jobs returned, with its run', async () => {
  const messageId = crypto.randomUUID();
  await processDelivery(jobs, { scenario: 'timeout-after-commit', strategy: 'resilient' }, messageId);
  const { status, body } = await get('/jobs/{id}', messageId);
  assert.equal(status, 200);
  assert.equal(body.job.status, 'completed');
  assert.equal(body.run.status, 'passed');
  assert.equal((await get('/runs/{id}', body.job.runId)).body.id, body.job.runId);
});

test('a job still in the queue is not found yet', async () => {
  const { status, body } = await get('/jobs/{id}', crypto.randomUUID());
  assert.equal(status, 404);
  assert.match(body.error, /waiting in the queue/);
});

test('lists and the summary read from the database', async () => {
  assert.ok((await get('/runs')).body.runs.length >= 1);
  assert.ok(Array.isArray((await get('/summary')).body.summary));
});

test('IDs must be UUIDs and unknown routes are 404s', async () => {
  assert.equal((await get('/runs/{id}', 'not-a-uuid')).status, 400);
  assert.equal((await get('/nothing')).status, 404);
});

test('a database failure returns a 500 without details', async () => {
  const broken = createHandler(async () => { throw new Error('password authentication failed'); });
  const response = await broken({ httpMethod: 'GET', resource: '/runs', path: '/runs', pathParameters: null } as unknown as APIGatewayProxyEvent);
  assert.equal(response.statusCode, 500);
  assert.doesNotMatch(response.body, /password/);
});
