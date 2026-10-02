import type { Database, Sql } from '../db/database.js';
import { RunStore } from '../db/store.js';
import type { Run } from '../core/types.js';

export type FundingMode = 'fixture' | 'byok' | 'included';
export class BillingError extends Error {}
export class InsufficientCredits extends BillingError {}
export interface ReservationInput {
  id: string; mode: FundingMode; planned: number; simulated: boolean;
  config: Record<string, unknown>;
}
const accountId = 'local-demo';

/** Single local prototype account. Customer identity must come from auth before hosting. */
export class BillingStore {
  constructor(readonly db: Database, readonly runs = new RunStore(db)) {}
  private async lock(tx: Sql) {
    const { rows: [account] } = await tx.query('SELECT * FROM billing_accounts WHERE id = $1 FOR UPDATE', [accountId]);
    if (!account) throw new BillingError('Billing account is not initialized');
    return account;
  }
  private async entry(tx: Sql, reference: string, kind: string, available: number, reserved: number, consumed: number, reservation?: string) {
    await tx.query(`INSERT INTO billing_ledger(account_id,reference,kind,available_delta,reserved_delta,consumed_delta,reservation_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7)`, [accountId, reference, kind, available, reserved, consumed, reservation ?? null]);
  }
  async reserve(input: ReservationInput) {
    if (!Number.isInteger(input.planned) || input.planned < 1 || input.planned > 80) throw new BillingError('Batch size must be 1-80');
    if (!['fixture', 'byok', 'included'].includes(input.mode)) throw new BillingError('Invalid funding mode');
    return this.db.transaction(async tx => {
      const account = await this.lock(tx);
      const { rows: [existing] } = await tx.query(`SELECT *, config = $2::jsonb AS same_config FROM billing_reservations WHERE id = $1`, [input.id, JSON.stringify(input.config)]);
      if (existing) {
        if (existing.account_id !== accountId || existing.mode !== input.mode || existing.planned !== input.planned || existing.simulated !== input.simulated || !existing.same_config) throw new BillingError('Reservation ID already has a different configuration');
        return;
      }
      const credits = input.mode === 'included' ? input.planned : 0;
      if (Number(account.available) < credits) throw new InsufficientCredits(`This batch needs ${credits} credits; ${account.available} are available. Use your own key or reduce the batch.`);
      await tx.query(`INSERT INTO billing_reservations(id,account_id,mode,simulated,planned,config) VALUES ($1,$2,$3,$4,$5,$6)`,
        [input.id, accountId, input.mode, input.simulated, input.planned, JSON.stringify(input.config)]);
      await tx.query('UPDATE billing_accounts SET available = available - $2, reserved = reserved + $2 WHERE id = $1', [accountId, credits]);
      await this.entry(tx, `${input.id}:reserve`, 'reserve', -credits, credits, 0, input.id);
    });
  }
  /** Saving evidence and consuming the reserved credit are one atomic operation. */
  async recordTrial(id: string, run: Run) {
    await this.db.transaction(async tx => {
      await this.lock(tx);
      const { rows: [reservation] } = await tx.query('SELECT * FROM billing_reservations WHERE id = $1 AND account_id = $2 FOR UPDATE', [id, accountId]);
      if (!reservation) throw new BillingError('Reservation not found');
      const { rows: [receipt] } = await tx.query('SELECT reservation_id FROM billing_trials WHERE run_id = $1', [run.id]);
      if (receipt) {
        if (receipt.reservation_id !== id) throw new BillingError('Run already belongs to another reservation');
        return;
      }
      if (reservation.state !== 'open' || Number(reservation.completed) >= Number(reservation.planned)) throw new BillingError('Reservation is closed or fully consumed');
      if (!reservation.simulated && ((reservation.mode === 'fixture') !== (run.metadata?.provider === 'fixture'))) throw new BillingError('Run provider does not match funding mode');
      const credits = reservation.mode === 'included' ? 1 : 0;
      const billedRun: Run = { ...run, metadata: { ...run.metadata!, billingMode: reservation.mode as FundingMode, billingSimulation: Boolean(reservation.simulated) } };
      await this.runs.save(billedRun, tx);
      await tx.query('INSERT INTO billing_trials VALUES ($1,$2,$3,$4)', [run.id, id, run.metadata?.inputTokens ?? 0, run.metadata?.outputTokens ?? 0]);
      await tx.query('UPDATE billing_reservations SET completed = completed + 1 WHERE id = $1', [id]);
      await tx.query('UPDATE billing_accounts SET reserved = reserved - $2, consumed = consumed + $2 WHERE id = $1', [accountId, credits]);
      await this.entry(tx, `${run.id}:trial`, 'trial', 0, -credits, credits, id);
    });
  }
  async settle(id: string) {
    await this.db.transaction(async tx => {
      await this.lock(tx);
      const { rows: [reservation] } = await tx.query('SELECT * FROM billing_reservations WHERE id = $1 AND account_id = $2 FOR UPDATE', [id, accountId]);
      if (!reservation) throw new BillingError('Reservation not found');
      if (reservation.state === 'closed') return;
      const unused = reservation.mode === 'included' ? Number(reservation.planned) - Number(reservation.completed) : 0;
      await tx.query('UPDATE billing_accounts SET available = available + $2, reserved = reserved - $2 WHERE id = $1', [accountId, unused]);
      await tx.query("UPDATE billing_reservations SET state = 'closed' WHERE id = $1", [id]);
      await this.entry(tx, `${id}:release`, 'release', unused, -unused, 0, id);
    });
  }
  async summary() {
    return this.db.transaction(async tx => {
      const account = await this.lock(tx);
      const { rows: ledger } = await tx.query(`SELECT l.id, l.kind, l.available_delta AS "availableDelta", l.reserved_delta AS "reservedDelta",
        l.consumed_delta AS "consumedDelta", l.created_at AS "createdAt", r.mode, r.simulated
        FROM billing_ledger l LEFT JOIN billing_reservations r ON r.id = l.reservation_id
        WHERE l.account_id = $1 ORDER BY l.id DESC LIMIT 30`, [accountId]);
      const { rows: reservations } = await tx.query(`SELECT id, mode, simulated, planned, completed, state FROM billing_reservations WHERE account_id = $1 AND state = 'open' ORDER BY created_at`, [accountId]);
      const { rows: usage } = await tx.query(`SELECT r.mode, r.simulated, COUNT(*)::int AS trials, SUM(t.input_tokens)::float AS "inputTokens", SUM(t.output_tokens)::float AS "outputTokens"
        FROM billing_trials t JOIN billing_reservations r ON r.id = t.reservation_id WHERE r.account_id = $1 GROUP BY r.mode,r.simulated`, [accountId]);
      return { testMode: true, account, ledger, reservations, usage };
    });
  }
}
