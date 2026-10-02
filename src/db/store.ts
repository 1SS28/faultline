import { readFile } from 'node:fs/promises';
import type { Database, Sql } from './database.js';
import type { Run } from '../core/types.js';

export class RunStore {
  constructor(readonly db: Database) {}
  async migrate() {
    const sql = (await Promise.all(['001_initial.sql', '002_jobs.sql', '003_run_metadata.sql', '004_billing.sql'].map(name => readFile(new URL(`../../sql/${name}`, import.meta.url), 'utf8')))).join('\n');
    await this.db.transaction(async tx => {
      // Initial migration contains no procedural blocks or semicolons inside literals.
      for (const statement of sql.split(';').filter(statement => statement.trim())) await tx.query(statement);
    });
  }
  async save(run: Run, transaction?: Sql) {
    const write = async (tx: Sql) => {
      await tx.query('INSERT INTO runs(id,scenario,agent_version,started_at,duration_ms,status,result,metadata) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        [run.id, run.scenario, run.agentVersion, run.startedAt, run.durationMs, run.status, JSON.stringify(run.result), JSON.stringify(run.metadata ?? {})]);
      for (const event of run.events) await tx.query('INSERT INTO trace_events VALUES ($1,$2,$3,$4,$5,$6)',
        [run.id, event.sequence, event.timeMs, event.kind, event.message, JSON.stringify(event.data)]);
      for (const refund of run.refunds) await tx.query('INSERT INTO refunds VALUES ($1,$2,$3,$4,$5)',
        [run.id, refund.id, refund.orderId, refund.amountCents, refund.idempotencyKey ?? null]);
      for (const assertion of run.assertions) await tx.query('INSERT INTO assertions VALUES ($1,$2,$3,$4,$5,$6)',
        [run.id, assertion.key, assertion.label, assertion.passed, assertion.expected, assertion.actual]);
    };
    if (transaction) await write(transaction);
    else await this.db.transaction(write);
  }
  async get(id: string): Promise<Run | undefined> {
    const { rows: [row] } = await this.db.query('SELECT * FROM runs WHERE id = $1', [id]);
    if (!row) return undefined;
    const [events, refunds, assertions] = await Promise.all([
      this.db.query('SELECT sequence, time_ms AS "timeMs", kind, message, data FROM trace_events WHERE run_id = $1 ORDER BY sequence', [id]),
      this.db.query('SELECT id, order_id AS "orderId", amount_cents AS "amountCents", idempotency_key AS "idempotencyKey" FROM refunds WHERE run_id = $1 ORDER BY id', [id]),
      this.db.query('SELECT key, label, passed, expected, actual FROM assertions WHERE run_id = $1 ORDER BY key', [id]),
    ]);
    return {
      id: String(row.id), scenario: row.scenario as Run['scenario'], agentVersion: String(row.agent_version),
      startedAt: new Date(row.started_at as string).toISOString(), durationMs: Number(row.duration_ms),
      metadata: row.metadata as Run['metadata'],
      status: row.status as Run['status'], result: row.result as Run['result'],
      events: events.rows as unknown as Run['events'],
      refunds: refunds.rows.map(refund => ({ ...refund, idempotencyKey: refund.idempotencyKey ?? undefined })) as unknown as Run['refunds'],
      assertions: assertions.rows as unknown as Run['assertions'],
    };
  }
  async list(limit = 20) {
    return (await this.db.query(`SELECT id, scenario, agent_version AS "agentVersion", started_at AS "startedAt",
      duration_ms AS "durationMs", status, metadata FROM runs ORDER BY started_at DESC, id DESC LIMIT $1`, [limit])).rows;
  }
  async summary() {
    return (await this.db.query(`SELECT agent_version AS "agentVersion", scenario, COUNT(*)::int AS runs,
      COUNT(*) FILTER (WHERE status = 'failed')::int AS failures,
      ROUND(100.0 * COUNT(*) FILTER (WHERE status = 'passed') / COUNT(*), 1)::float AS "passRate"
      FROM runs GROUP BY agent_version, scenario ORDER BY agent_version, scenario`)).rows;
  }
}
