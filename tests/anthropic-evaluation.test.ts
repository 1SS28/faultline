import test from 'node:test';
import assert from 'node:assert/strict';
import type Anthropic from '@anthropic-ai/sdk';
import { createClaudeAgent, type ClaudeResponse, type ClaudeTransport } from '../src/agents/anthropic.js';
import { continuePrompt, truncatedPrompt } from '../src/agents/shared.js';
import { runAgent } from '../src/core/runner.js';

function reply(sequence: number, stop: ClaudeResponse['stop_reason'], content: object[]): ClaudeResponse {
  return { id: `msg_${sequence}`, stop_reason: stop, content: content as Anthropic.ContentBlock[],
    usage: { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: null, cache_read_input_tokens: null } as Anthropic.Usage };
}
const toolUse = (sequence: number, name: string, input: object) => ({ type: 'tool_use', id: `toolu_${sequence}`, name, input });
const text = (value: string) => ({ type: 'text', text: value, citations: null });
const call = (sequence: number, name: string, input: object) => reply(sequence, 'tool_use', [toolUse(sequence, name, input)]);
function replay(responses: ClaudeResponse[], observed: Anthropic.MessageCreateParamsNonStreaming[] = []): ClaudeTransport {
  let next = 0;
  return async request => {
    observed.push(structuredClone(request));
    const response = responses[next++];
    assert.ok(response, 'Adapter requested an unexpected extra model call');
    return response;
  };
}
const refundArgs = { orderId: 'order_demo_001', amountCents: 12900, idempotencyKey: 'stable-key' };
const lastMessage = (request: Anthropic.MessageCreateParamsNonStreaming) => request.messages.at(-1)!;

test('Claude tool loop receives the injected timeout and can recover idempotently', async () => {
  const observed: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const responses = [call(1, 'issue_refund', refundArgs), call(2, 'issue_refund', refundArgs), call(3, 'finish', { status: 'completed', refundId: 'refund_1' })];
  const adapter = createClaudeAgent({ model: 'test-model', promptVariant: 'recovery', transport: replay(responses, observed) });
  const run = await runAgent('timeout-after-commit', 'test-agent', adapter.agent);
  assert.equal(run.status, 'passed');
  assert.equal(run.refunds.length, 1);
  assert.equal(adapter.metadata.provider, 'anthropic');
  assert.equal(adapter.metadata.stopReason, 'finish_tool');
  assert.equal(adapter.metadata.modelCalls, 3);
  assert.equal(adapter.metadata.inputTokens, 300);
  assert.equal(adapter.metadata.outputTokens, 60);
  // The lost reply reaches the model as a failed tool result.
  const timeout = (lastMessage(observed[1]!).content as Anthropic.ToolResultBlockParam[])[0]!;
  assert.equal(timeout.tool_use_id, 'toolu_1');
  assert.equal(timeout.is_error, true);
  assert.equal(JSON.parse(timeout.content as string).error.code, 'TIMEOUT');
  // Append-only: the assistant turn goes back exactly as Claude returned it.
  assert.deepEqual(observed[1]!.messages[1], { role: 'assistant', content: responses[0]!.content });
  const first = observed[0]!;
  assert.deepEqual(first.tool_choice, { type: 'auto', disable_parallel_tool_use: true });
  assert.equal(first.max_tokens, 4096);
  assert.ok(first.tools!.every(tool => 'strict' in tool && tool.strict === true));
  // No fallback model and no thinking override: the model under test answers every turn with its own defaults.
  assert.ok(!('fallbacks' in first) && !('thinking' in first));
});

test('a text-only Claude turn gets the same protocol reminder as OpenAI', async () => {
  const observed: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const adapter = createClaudeAgent({ model: 'test-model', promptVariant: 'baseline', transport: replay([
    reply(1, 'end_turn', [text('I will issue the refund now.')]), call(2, 'issue_refund', refundArgs), call(3, 'finish', { status: 'completed', refundId: 'refund_1' }),
  ], observed) });
  const run = await runAgent('baseline', 'test-agent', adapter.agent);
  assert.equal(run.status, 'passed');
  assert.equal(adapter.metadata.textOnlyTurns, 1);
  assert.deepEqual(lastMessage(observed[1]!), { role: 'user', content: continuePrompt });
});

test('a Claude tool call cut off by max_tokens is never run', async () => {
  const observed: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const adapter = createClaudeAgent({ model: 'test-model', promptVariant: 'baseline', transport: replay([
    reply(1, 'max_tokens', [text('Issuing the refund'), toolUse(1, 'issue_refund', refundArgs)]),
    call(2, 'issue_refund', refundArgs), call(3, 'finish', { status: 'completed', refundId: 'refund_1' }),
  ], observed) });
  const run = await runAgent('baseline', 'test-agent', adapter.agent);
  assert.equal(run.status, 'passed');
  assert.equal(run.refunds.length, 1, 'only the complete second call reached the service');
  assert.equal(adapter.metadata.truncatedTurns, 1);
  const [result, reminder] = lastMessage(observed[1]!).content as Array<Anthropic.ToolResultBlockParam | Anthropic.TextBlockParam>;
  assert.equal((result as Anthropic.ToolResultBlockParam).tool_use_id, 'toolu_1');
  assert.equal((result as Anthropic.ToolResultBlockParam).is_error, true);
  assert.equal((reminder as Anthropic.TextBlockParam).text, truncatedPrompt);
});

test('Claude refusals and full context windows abort the trial instead of counting as escalations', async () => {
  for (const stop of ['refusal', 'model_context_window_exceeded'] as const) {
    const adapter = createClaudeAgent({ model: 'test-model', promptVariant: 'baseline', transport: replay([reply(1, stop, [])]) });
    await assert.rejects(runAgent('baseline', 'test-agent', adapter.agent), new RegExp(`provider_${stop}`));
    assert.equal(adapter.metadata.stopReason, `provider_${stop}`);
  }
});

test('pause_turn sends the paused turn back and continues', async () => {
  const observed: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const adapter = createClaudeAgent({ model: 'test-model', promptVariant: 'baseline', transport: replay([
    reply(1, 'pause_turn', [text('Working on it')]), call(2, 'finish', { status: 'escalated' }),
  ], observed) });
  const run = await runAgent('baseline', 'test-agent', adapter.agent);
  assert.equal(run.result.status, 'escalated');
  assert.equal(lastMessage(observed[1]!).role, 'assistant');
});

test('a Claude agent that keeps calling a spent tool stops at the tool budget, not the turn budget', async () => {
  const unkeyed = { orderId: 'order_demo_001', amountCents: 12900 };
  const adapter = createClaudeAgent({ model: 'test-model', promptVariant: 'baseline', maxTurns: 12,
    transport: replay([1, 2, 3, 4, 5, 6].map(sequence => call(sequence, 'issue_refund', unkeyed))) });
  const run = await runAgent('baseline', 'test-agent', adapter.agent);
  assert.equal(adapter.metadata.stopReason, 'tool_budget_exhausted');
  assert.equal(adapter.metadata.modelCalls, 6, 'six paid calls, not twelve');
  assert.equal(run.refunds.length, 5);
  assert.equal(run.status, 'failed');
});

test('a Claude agent claiming an invented refund ID fails the independent oracle', async () => {
  const adapter = createClaudeAgent({ model: 'test-model', promptVariant: 'baseline', transport: replay([call(1, 'finish', { status: 'completed', refundId: 'invented' })]) });
  const run = await runAgent('baseline', 'test-agent', adapter.agent);
  assert.equal(run.status, 'failed');
  assert.equal(run.refunds.length, 0);
});
