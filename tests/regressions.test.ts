import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Scenario } from '../src/core/types.js';
import { connectDatabase, type Database } from '../src/db/database.js';
import { RunStore } from '../src/db/store.js';

let db: Database;
let store: RunStore;
let clock = 0;
before(async () => {
  db = await connectDatabase({ memory: true });
  store = new RunStore(db); await store.migrate();
});
beforeEach(async () => {
  await db.query('TRUNCATE billing_trials, job_attempts, jobs, trace_events, refunds, assertions, runs');
  clock = Date.parse('2026-11-01T00:00:00Z');
});
after(async () => { await db?.close(); });

/** Saves one run per outcome, each a minute after the last. */
async function record(agentVersion: string, scenario: Scenario, outcomes: Array<'passed' | 'failed'>) {
  for (const status of outcomes) {
    clock += 60_000;
    await store.save({
      id: crypto.randomUUID(), scenario, agentVersion, startedAt: new Date(clock).toISOString(), durationMs: 1,
      status, result: { status: 'completed' }, events: [], refunds: [], assertions: [],
    });
  }
}

test('a version that passes less often than the one before it is flagged', async () => {
  await record('claude/v1', 'timeout-after-commit', ['passed', 'passed']);
  await record('claude/v2', 'timeout-after-commit', ['passed', 'failed']);
  assert.deepEqual(await store.regressions(), [{
    scenario: 'timeout-after-commit', previousVersion: 'claude/v1', agentVersion: 'claude/v2',
    previousPassRate: 100, previousRuns: 2, passRate: 50, runs: 2,
  }]);
});

test('equal or better versions are not flagged, and a first version has nothing to compare with', async () => {
  await record('claude/v1', 'rate-limit', ['failed']);
  await record('claude/v1', 'baseline', ['passed']);
  await record('claude/v2', 'rate-limit', ['passed']);
  await record('claude/v2', 'baseline', ['passed']);
  await record('claude/v2', 'malformed-response', ['failed']);
  assert.deepEqual(await store.regressions(), []);
});

test('versions are ordered by their first run anywhere, not their first run of each scenario', async () => {
  await record('claude/v1', 'baseline', ['passed']);
  await record('claude/v2', 'rate-limit', ['failed']);
  // v1 reaches this scenario after v2 does, but v1 is still the older version.
  await record('claude/v1', 'rate-limit', ['passed']);
  const [regression] = await store.regressions();
  assert.equal(regression?.previousVersion, 'claude/v1');
  assert.equal(regression?.agentVersion, 'claude/v2');
});

test('each scenario compares with the last version that ran it', async () => {
  await record('claude/v1', 'baseline', ['passed']);
  await record('claude/v2', 'rate-limit', ['passed']);
  await record('claude/v3', 'baseline', ['failed']);
  const regressions = await store.regressions();
  assert.equal(regressions.length, 1);
  assert.equal(regressions[0]?.previousVersion, 'claude/v1');
});
