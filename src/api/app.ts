import Fastify from 'fastify';
import { runScenario } from '../core/runner.js';
import { scenarios, strategies, type Scenario, type Strategy } from '../core/types.js';
import type { RunStore } from '../db/store.js';
import { JobStore, IdempotencyConflict } from '../jobs/store.js';

export function createApp(store: RunStore) {
  const jobs = new JobStore(store.db, store);
  const app = Fastify({ logger: false, bodyLimit: 16_384 });
  app.get('/health', async () => {
    await store.db.query('SELECT 1');
    return { status: 'ok', mode: 'local-fixture' };
  });
  app.get('/api/scenarios', async () => ({ scenarios, strategies, fixture: true }));
  app.post<{ Body: { scenario: Scenario; strategy: Strategy } }>('/api/runs', {
    schema: { body: {
      type: 'object', additionalProperties: false, required: ['scenario', 'strategy'],
      properties: { scenario: { type: 'string', enum: [...scenarios] }, strategy: { type: 'string', enum: [...strategies] } },
    } },
  }, async (request, reply) => {
    const run = await runScenario(request.body);
    await store.save(run);
    return reply.code(201).header('Location', `/api/runs/${run.id}`).send(run);
  });
  app.post<{ Body: { scenario: Scenario; strategy: Strategy }; Headers: { 'idempotency-key'?: string } }>('/api/jobs', {
    schema: {
      headers: { type: 'object', properties: { 'idempotency-key': { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9_.:-]+$' } } },
      body: { type: 'object', additionalProperties: false, required: ['scenario', 'strategy'], properties: {
        scenario: { type: 'string', enum: [...scenarios] }, strategy: { type: 'string', enum: [...strategies] },
      } },
    },
  }, async (request, reply) => {
    try {
      const { job, created } = await jobs.enqueue(request.body, request.headers['idempotency-key']);
      return reply.code(created ? 202 : 200).header('Location', `/api/jobs/${job.id}`).send(job);
    } catch (error) {
      if (error instanceof IdempotencyConflict) return reply.code(409).send({ error: error.message });
      throw error;
    }
  });
  app.get('/api/jobs', async () => ({ jobs: await jobs.list() }));
  app.get<{ Params: { id: string } }>('/api/jobs/:id', {
    schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } } },
  }, async (request, reply) => {
    const job = await jobs.get(request.params.id);
    return job ?? reply.code(404).send({ error: 'Job not found' });
  });
  app.get('/api/runs', async () => ({ runs: await store.list(50) }));
  app.get<{ Params: { id: string } }>('/api/runs/:id', {
    schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } } },
  }, async (request, reply) => {
    const run = await store.get(request.params.id);
    return run ?? reply.code(404).send({ error: 'Run not found' });
  });
  app.get('/api/summary', async () => ({ summary: await store.summary() }));
  return app;
}
