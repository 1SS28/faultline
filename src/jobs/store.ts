import { randomUUID } from 'node:crypto';
import type { Database } from '../db/database.js';
import { RunStore } from '../db/store.js';
import type { Run } from '../core/types.js';
import type { Claim, Job, JobDetail, JobInput } from './types.js';

export class IdempotencyConflict extends Error {}
export class LeaseLost extends Error {}
const fields = `id, scenario, strategy, status, attempts, max_attempts AS "maxAttempts",
  created_at AS "createdAt", updated_at AS "updatedAt", run_id AS "runId", error`;
function asJob(row: Record<string, unknown>): Job {
  return { ...row, createdAt: new Date(row.createdAt as string).toISOString(), updatedAt: new Date(row.updatedAt as string).toISOString() } as unknown as Job;
}

export class JobStore {
  constructor(readonly db: Database, readonly runs = new RunStore(db)) {}
  async enqueue(input: JobInput, idempotencyKey?: string): Promise<{ job: Job; created: boolean }> {
    return this.db.transaction(async tx => {
      const { rows: [inserted] } = await tx.query(`INSERT INTO jobs(id, scenario, strategy, idempotency_key)
        VALUES ($1,$2,$3,$4) ON CONFLICT (idempotency_key) DO NOTHING RETURNING ${fields}`,
        [randomUUID(), input.scenario, input.strategy, idempotencyKey ?? null]);
      if (inserted) return { job: asJob(inserted), created: true };
      const { rows: [existing] } = await tx.query(`SELECT ${fields} FROM jobs WHERE idempotency_key = $1`, [idempotencyKey]);
      if (!existing || existing.scenario !== input.scenario || existing.strategy !== input.strategy) {
        throw new IdempotencyConflict('This idempotency key was already used for a different test configuration.');
      }
      return { job: asJob(existing), created: false };
    });
  }
  async get(id: string): Promise<JobDetail | undefined> {
    // One transaction gives job state and attempt history a coherent serialized view in local mode.
    return this.db.transaction(async tx => {
      const { rows: [row] } = await tx.query(`SELECT ${fields} FROM jobs WHERE id = $1 FOR SHARE`, [id]);
      if (!row) return undefined;
      const { rows } = await tx.query(`SELECT attempt, status, started_at AS "startedAt", finished_at AS "finishedAt", error
        FROM job_attempts WHERE job_id = $1 ORDER BY attempt`, [id]);
      return { ...asJob(row), history: rows.map(row => ({
        attempt: Number(row.attempt), status: row.status as JobDetail['history'][number]['status'],
        startedAt: new Date(row.startedAt as string).toISOString(),
        finishedAt: row.finishedAt ? new Date(row.finishedAt as string).toISOString() : null,
        error: row.error as string | null,
      })) };
    });
  }
  async list(limit = 50): Promise<Job[]> {
    return (await this.db.query(`SELECT ${fields} FROM jobs ORDER BY created_at DESC, id DESC LIMIT $1`, [limit])).rows.map(asJob);
  }
  async claim(leaseMs = 30_000): Promise<Claim | undefined> {
    if (!Number.isInteger(leaseMs) || leaseMs < 100 || leaseMs > 300_000) throw new Error('Invalid lease duration');
    return this.db.transaction(async tx => {
      // Exhausted worker crashes must reach a terminal state, even with no other ready jobs.
      await tx.query(`WITH exhausted AS (
        UPDATE jobs SET status = 'errored', lease_token = NULL, lease_until = NULL,
          error = 'Worker lease expired; retry budget exhausted', updated_at = now()
        WHERE status = 'running' AND lease_until <= now() AND attempts >= max_attempts
        RETURNING id, attempts
      ) UPDATE job_attempts SET status = 'expired', finished_at = now(), error = 'Worker lease expired'
        FROM exhausted WHERE job_attempts.job_id = exhausted.id AND job_attempts.attempt = exhausted.attempts`);
      const { rows: [candidate] } = await tx.query(`SELECT id, status, attempts FROM jobs
        WHERE attempts < max_attempts AND ((status = 'queued' AND available_at <= now()) OR (status = 'running' AND lease_until <= now()))
        ORDER BY created_at, id LIMIT 1 FOR UPDATE SKIP LOCKED`);
      if (!candidate) return undefined;
      if (candidate.status === 'running') await tx.query(`UPDATE job_attempts SET status = 'expired', finished_at = now(),
        error = 'Worker lease expired' WHERE job_id = $1 AND attempt = $2`, [candidate.id, candidate.attempts]);
      const token = randomUUID();
      const { rows: [row] } = await tx.query(`UPDATE jobs SET status = 'running', attempts = attempts + 1,
        lease_token = $2, lease_until = now() + $3 * interval '1 millisecond', updated_at = now(), error = NULL
        WHERE id = $1 RETURNING ${fields}`, [candidate.id, token, leaseMs]);
      await tx.query(`INSERT INTO job_attempts(job_id, attempt, lease_token, status) VALUES ($1,$2,$3,'running')`,
        [candidate.id, row!.attempts, token]);
      return { job: asJob(row!), token };
    });
  }
  async renew(claim: Claim, leaseMs = 30_000): Promise<boolean> {
    const { rows } = await this.db.query(`UPDATE jobs SET lease_until = now() + $3 * interval '1 millisecond', updated_at = now()
      WHERE id = $1 AND lease_token = $2 AND status = 'running' AND lease_until > now() RETURNING id`, [claim.job.id, claim.token, leaseMs]);
    return rows.length === 1;
  }
  async complete(claim: Claim, run: Run): Promise<void> {
    await this.db.transaction(async tx => {
      const { rows } = await tx.query(`SELECT id FROM jobs WHERE id = $1 AND lease_token = $2
        AND status = 'running' AND lease_until > now() FOR UPDATE`, [claim.job.id, claim.token]);
      if (!rows.length) throw new LeaseLost('Worker no longer owns this job');
      if (run.scenario !== claim.job.scenario || run.agentVersion !== `fixture/${claim.job.strategy}/v1`) {
        throw new Error('Execution result does not match the claimed job');
      }
      await this.runs.save(run, tx);
      await tx.query(`UPDATE jobs SET status = 'completed', run_id = $3, lease_token = NULL, lease_until = NULL,
        updated_at = now(), error = NULL WHERE id = $1 AND lease_token = $2`, [claim.job.id, claim.token, run.id]);
      await tx.query(`UPDATE job_attempts SET status = 'completed', finished_at = now() WHERE lease_token = $1`, [claim.token]);
    });
  }
  async fail(claim: Claim, error: string, backoffMs = 1000): Promise<boolean> {
    return this.db.transaction(async tx => {
      const { rows } = await tx.query(`UPDATE jobs SET
        status = CASE WHEN attempts >= max_attempts THEN 'errored' ELSE 'queued' END,
        available_at = now() + $4 * interval '1 millisecond', lease_token = NULL, lease_until = NULL,
        error = $3, updated_at = now()
        WHERE id = $1 AND lease_token = $2 AND status = 'running' AND lease_until > now() RETURNING id`,
        [claim.job.id, claim.token, error.slice(0, 2000), backoffMs]);
      if (!rows.length) return false;
      await tx.query(`UPDATE job_attempts SET status = 'errored', finished_at = now(), error = $2 WHERE lease_token = $1`, [claim.token, error.slice(0, 2000)]);
      return true;
    });
  }
}
