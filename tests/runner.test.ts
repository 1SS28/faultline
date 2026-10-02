import test from 'node:test';
import assert from 'node:assert/strict';
import { runAgent, runScenario } from '../src/core/runner.js';
import { scenarios } from '../src/core/types.js';
import { RefundSimulator } from '../src/core/simulator.js';

test('a lost acknowledgement causes the naive agent to refund twice', async () => {
  const run = await runScenario({ scenario: 'timeout-after-commit', strategy: 'naive' });
  assert.equal(run.status, 'failed');
  assert.equal(run.refunds.length, 2);
  assert.equal(run.refunds.reduce((sum, refund) => sum + refund.amountCents, 0), 25800);
  assert.equal(run.assertions.find(assertion => assertion.key === 'at-most-one-refund')?.passed, false);
  const commit = run.events.find(event => event.kind === 'tool.commit')!;
  const fault = run.events.find(event => event.kind === 'fault.injected')!;
  assert.ok(commit.sequence < fault.sequence, 'commit precedes response loss');
});
for (const scenario of scenarios) {
  test(`resilient fixture recovers from ${scenario} without duplicate side effects`, async () => {
    const run = await runScenario({ scenario, strategy: 'resilient' });
    assert.equal(run.status, 'passed');
    assert.equal(run.refunds.length, 1);
    assert.equal(run.result.refundId, run.refunds[0]!.id);
    assert.ok(run.assertions.every(assertion => assertion.passed));
  });
}
test('baseline passes for both fixtures, avoiding a permanently failing comparison', async () => {
  assert.equal((await runScenario({ scenario: 'baseline', strategy: 'naive' })).status, 'passed');
});
test('unverified success is detected even if the ledger has one refund', async () => {
  const run = await runScenario({ scenario: 'malformed-response', strategy: 'naive' });
  assert.equal(run.refunds.length, 1);
  assert.equal(run.assertions.find(assertion => assertion.key === 'confirmed-success')?.passed, false);
});
test('rate-limit recovery respects retry-after while immediate retries fail', async () => {
  const broken = await runScenario({ scenario: 'rate-limit', strategy: 'naive' });
  const fixed = await runScenario({ scenario: 'rate-limit', strategy: 'resilient' });
  assert.equal(broken.status, 'failed');
  assert.equal(broken.refunds.length, 0);
  assert.equal(fixed.events.find(event => event.kind === 'tool.commit')!.timeMs, 1000);
});
test('simulated service rejects an idempotency key reused with different input', async () => {
  const simulator = new RefundSimulator('baseline');
  await simulator.issueRefund({ orderId: 'one', amountCents: 100, idempotencyKey: 'same' });
  await assert.rejects(() => simulator.issueRefund({ orderId: 'two', amountCents: 100, idempotencyKey: 'same' }), /different arguments/);
  assert.equal(simulator.refunds.length, 1);
});
test('each run starts with an isolated ledger', async () => {
  const runs = await Promise.all(Array.from({ length: 5 }, () => runScenario({ scenario: 'baseline', strategy: 'resilient' })));
  assert.equal(new Set(runs.map(run => run.id)).size, 5);
  assert.ok(runs.every(run => run.refunds.length === 1 && run.refunds[0]!.id === 'refund_1'));
});

test('a refund for the wrong order cannot satisfy the success assertion', async () => {
  const run = await runAgent('baseline', 'fixture/wrong-order/v1', async context => {
    const response = await context.issueRefund({ ...context.request, orderId: 'wrong-order' }) as { refundId: string };
    return { status: 'completed', refundId: response.refundId };
  });
  assert.equal(run.status, 'failed');
  assert.equal(run.assertions.find(assertion => assertion.key === 'confirmed-success')?.passed, false);
});
