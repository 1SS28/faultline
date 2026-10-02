import test from 'node:test';
import assert from 'node:assert/strict';
import { createOpenAIAgent, type ModelResponse, type ModelTransport } from '../src/agents/openai.js';
import { runAgent, runScenario } from '../src/core/runner.js';
import { summarizeTrials } from '../src/evaluation/report.js';

function response(name: string, args: object, sequence: number): ModelResponse {
  return { id: `response_${sequence}`, status: 'completed', output: [{ type: 'function_call', call_id: `call_${sequence}`, name, arguments: JSON.stringify(args) }], usage: undefined };
}
function scripted(steps: Array<[string, object]>, observed: unknown[] = []): ModelTransport {
  let next = 0;
  return async request => {
    observed.push(structuredClone(request));
    const step = steps[next++];
    assert.ok(step, 'Adapter requested an unexpected extra model call');
    return response(step[0], step[1], next);
  };
}
test('model tool loop receives the injected timeout and can recover idempotently', async () => {
  const observed: any[] = [];
  const args = { orderId: 'order_demo_001', amountCents: 12900, idempotencyKey: 'stable-key' };
  const adapter = createOpenAIAgent({ model: 'test-model', promptVariant: 'recovery', transport: scripted([
    ['issue_refund', args], ['issue_refund', args], ['finish', { status: 'completed', refundId: 'refund_1' }],
  ], observed) });
  const run = await runAgent('timeout-after-commit', 'test-agent', adapter.agent);
  assert.equal(run.status, 'passed');
  assert.equal(run.refunds.length, 1);
  assert.equal(adapter.metadata.modelCalls, 3);
  assert.equal(adapter.metadata.stopReason, 'finish_tool');
  const timeoutOutput = observed[1].input.find((item: any) => item.type === 'function_call_output');
  assert.equal(JSON.parse(timeoutOutput.output).error.code, 'TIMEOUT');
  assert.ok(observed.every(item => item.store === false && item.parallel_tool_calls === false && item.max_output_tokens === 1024));
  assert.equal(run.events.filter(event => event.kind === 'model.response').length, 3);
});
test('a model claiming an invented refund ID fails the independent oracle', async () => {
  const adapter = createOpenAIAgent({ model: 'test-model', promptVariant: 'baseline', transport: scripted([
    ['finish', { status: 'completed', refundId: 'invented' }],
  ]) });
  const run = await runAgent('baseline', 'test-agent', adapter.agent);
  assert.equal(run.status, 'failed');
  assert.equal(run.refunds.length, 0);
});
test('model-call budget stops a non-finishing agent', async () => {
  const adapter = createOpenAIAgent({ model: 'test-model', promptVariant: 'baseline', maxTurns: 2, transport: scripted([
    ['wait', { milliseconds: 1 }], ['wait', { milliseconds: 1 }],
  ]) });
  const run = await runAgent('baseline', 'test-agent', adapter.agent);
  assert.equal(run.result.status, 'escalated');
  assert.equal(adapter.metadata.stopReason, 'turn_budget_exhausted');
  assert.equal(adapter.metadata.modelCalls, 2);
});
test('invalid model arguments never commit a refund', async () => {
  const adapter = createOpenAIAgent({ model: 'test-model', promptVariant: 'baseline', transport: scripted([
    ['issue_refund', { orderId: 'order_demo_001', amountCents: '12900', idempotencyKey: null }],
    ['finish', { status: 'escalated', refundId: null }],
  ]) });
  const run = await runAgent('baseline', 'test-agent', adapter.agent);
  assert.equal(run.refunds.length, 0);
});
test('trial summaries separate scenarios and omit statistical intervals for fixtures', async () => {
  const runs = await Promise.all([
    runScenario({ scenario: 'baseline', strategy: 'naive' }),
    runScenario({ scenario: 'timeout-after-commit', strategy: 'naive' }),
    runScenario({ scenario: 'timeout-after-commit', strategy: 'naive' }),
  ]);
  const summary = summarizeTrials(runs);
  assert.equal(summary.length, 2);
  const failures = summary.find(row => row.scenario === 'timeout-after-commit')!;
  assert.equal(failures.trials, 2);
  assert.equal(failures.passRate, 0);
  assert.equal(failures.failedAssertions['at-most-one-refund'], 2);
  assert.equal(failures.confidence95, null);
});
test('live trial interval does not imply certainty after one passing trial', async () => {
  const run = await runScenario({ scenario: 'baseline', strategy: 'resilient' });
  run.metadata = { provider: 'openai', model: 'test-model' };
  const report = summarizeTrials([run])[0]!;
  assert.equal(report.passRate, 100);
  assert.ok(report.confidence95!.lower < 0.3);
  assert.ok(report.confidence95!.upper <= 1);
});
