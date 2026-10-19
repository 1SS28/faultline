import test from 'node:test';
import assert from 'node:assert/strict';
import { createOpenAIAgent, type ModelResponse, type ModelTransport } from '../src/agents/openai.js';
import { runAgent, runScenario } from '../src/core/runner.js';
import { summarizeTrials } from '../src/evaluation/report.js';

function response(name: string, args: object, sequence: number): ModelResponse {
  return { id: `response_${sequence}`, status: 'completed', output: [{ type: 'function_call', call_id: `call_${sequence}`, name, arguments: JSON.stringify(args) }], usage: undefined };
}
function message(text: string, sequence: number, status: ModelResponse['status'] = 'completed', reason?: 'max_output_tokens' | 'content_filter'): ModelResponse {
  return { id: `response_${sequence}`, status, incomplete_details: reason ? { reason } : null, usage: undefined,
    output: [{ type: 'message', id: `message_${sequence}`, role: 'assistant', status: status === 'incomplete' ? 'incomplete' : 'completed', content: [{ type: 'output_text', text, annotations: [] }] }] };
}
function replay(responses: ModelResponse[], observed: unknown[] = []): ModelTransport {
  let next = 0;
  return async request => {
    observed.push(structuredClone(request));
    const result = responses[next++];
    assert.ok(result, 'Adapter requested an unexpected extra model call');
    return result;
  };
}
function scripted(steps: Array<[string, object]>, observed: unknown[] = []): ModelTransport {
  return replay(steps.map(([name, args], index) => response(name, args, index + 1)), observed);
}
const refundArgs = { orderId: 'order_demo_001', amountCents: 12900, idempotencyKey: 'stable-key' };
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
test('a text-only turn gets a protocol reminder instead of being scored as an escalation', async () => {
  const observed: any[] = [];
  const adapter = createOpenAIAgent({ model: 'test-model', promptVariant: 'baseline', transport: replay([
    message('I will issue the refund now.', 1), response('issue_refund', refundArgs, 2), response('finish', { status: 'completed', refundId: 'refund_1' }, 3),
  ], observed) });
  const run = await runAgent('baseline', 'test-agent', adapter.agent);
  assert.equal(run.status, 'passed');
  assert.equal(adapter.metadata.stopReason, 'finish_tool');
  assert.equal(adapter.metadata.textOnlyTurns, 1);
  const reminder = observed[1].input.at(-1);
  assert.equal(reminder.role, 'user');
  // The baseline prompt must not receive recovery advice through the harness.
  assert.doesNotMatch(reminder.content, /idempot|retr|timeout/i);
  assert.ok(run.events.some(event => event.kind === 'model.response' && event.data.textOnly === true));
});
test('a model that never calls a tool exhausts its budget and the report can see why', async () => {
  const adapter = createOpenAIAgent({ model: 'test-model', promptVariant: 'baseline', maxTurns: 2, transport: replay([message('Thinking.', 1), message('Still thinking.', 2)]) });
  const run = await runAgent('baseline', 'test-agent', adapter.agent);
  assert.equal(run.result.status, 'escalated');
  assert.equal(adapter.metadata.stopReason, 'turn_budget_exhausted');
  assert.equal(adapter.metadata.textOnlyTurns, 2);
});
test('hitting the output cap continues the loop, and a complete tool call in a truncated turn still runs', async () => {
  const observed: any[] = [];
  const adapter = createOpenAIAgent({ model: 'test-model', promptVariant: 'baseline', transport: replay([
    message('Let me work through', 1, 'incomplete', 'max_output_tokens'),
    { ...response('issue_refund', refundArgs, 2), status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } },
    response('finish', { status: 'completed', refundId: 'refund_1' }, 3),
  ], observed) });
  const run = await runAgent('baseline', 'test-agent', adapter.agent);
  assert.equal(run.status, 'passed');
  assert.equal(run.refunds.length, 1);
  assert.equal(adapter.metadata.truncatedTurns, 2);
  assert.equal(adapter.metadata.textOnlyTurns, 0);
  assert.match(observed[1].input.at(-1).content, /output limit/);
});
test('provider-side stops abort the trial instead of counting as agent escalations', async () => {
  const cases: Array<[ModelResponse, string]> = [
    [{ ...message('', 1), status: 'failed' }, 'provider_failed'],
    [message('', 1, 'incomplete', 'content_filter'), 'provider_content_filter'],
  ];
  for (const [result, reason] of cases) {
    const adapter = createOpenAIAgent({ model: 'test-model', promptVariant: 'baseline', transport: replay([result]) });
    await assert.rejects(runAgent('baseline', 'test-agent', adapter.agent), new RegExp(reason));
    assert.equal(adapter.metadata.stopReason, reason);
  }
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
test('live summaries break out stop reasons so an exhausted budget is not read as escalation', async () => {
  const runs = await Promise.all([1, 2, 3].map(() => runScenario({ scenario: 'baseline', strategy: 'resilient' })));
  runs.forEach((run, index) => { run.metadata = { provider: 'openai', model: 'test-model', stopReason: index ? 'finish_tool' : 'turn_budget_exhausted', textOnlyTurns: 1 }; });
  const report = summarizeTrials(runs)[0]!;
  assert.deepEqual(report.stopReasons, { turn_budget_exhausted: 1, finish_tool: 2 });
  assert.equal(report.textOnlyTurns, 3);
  const fixture = summarizeTrials([await runScenario({ scenario: 'baseline', strategy: 'resilient' })])[0]!;
  assert.equal(fixture.stopReasons, null);
});
test('an OpenAI agent that keeps calling a spent tool stops at the tool budget, not the turn budget', async () => {
  const unkeyed = { orderId: 'order_demo_001', amountCents: 12900, idempotencyKey: null };
  const adapter = createOpenAIAgent({ model: 'test-model', promptVariant: 'baseline', maxTurns: 12,
    transport: scripted([1, 2, 3, 4, 5, 6].map(() => ['issue_refund', unkeyed] as [string, object])) });
  const run = await runAgent('baseline', 'test-agent', adapter.agent);
  assert.equal(adapter.metadata.stopReason, 'tool_budget_exhausted');
  assert.equal(adapter.metadata.modelCalls, 6);
  assert.equal(run.refunds.length, 5);
});
