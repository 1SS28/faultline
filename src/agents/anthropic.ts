import Anthropic from '@anthropic-ai/sdk';
import type { Agent, AgentResult, RunMetadata } from '../core/types.js';
import { continuePrompt, runToolCall, setUpTrial, taskFor, toolDescriptions, truncatedPrompt, type PromptVariant } from './shared.js';

export type ClaudeResponse = Pick<Anthropic.Message, 'id' | 'content' | 'stop_reason' | 'usage'>;
export type ClaudeTransport = (request: Anthropic.MessageCreateParamsNonStreaming, signal: AbortSignal) => Promise<ClaudeResponse>;
// Claude strict mode allows optional properties, so idempotencyKey and refundId are simply left out of `required`.
const tools: Anthropic.Tool[] = [
  { name: 'issue_refund', description: toolDescriptions.issue_refund, strict: true,
    input_schema: { type: 'object', additionalProperties: false, properties: { orderId: { type: 'string' }, amountCents: { type: 'integer' }, idempotencyKey: { type: 'string' } }, required: ['orderId', 'amountCents'] } },
  { name: 'wait', description: toolDescriptions.wait, strict: true,
    input_schema: { type: 'object', additionalProperties: false, properties: { milliseconds: { type: 'integer' } }, required: ['milliseconds'] } },
  { name: 'finish', description: toolDescriptions.finish, strict: true,
    input_schema: { type: 'object', additionalProperties: false, properties: { status: { type: 'string', enum: ['completed', 'escalated'] }, refundId: { type: 'string' } }, required: ['status'] } },
];

export function anthropicTransport(apiKey: string): ClaudeTransport {
  const client = new Anthropic({ apiKey, maxRetries: 0, timeout: 30_000 });
  return async (request, signal) => {
    try { return await client.messages.create(request, { signal }); }
    catch (error) {
      // Do not persist request headers, provider payloads, or credentials in reports.
      if (signal.aborted) throw new Error('Model execution deadline exceeded');
      if (error instanceof Anthropic.APIError) throw new Error(`Model request failed (HTTP ${error.status ?? 'unknown'})`);
      throw new Error('Model request could not be completed');
    }
  };
}

/**
 * Runs Claude against the simulated refund tools with the same prompt, tools and checks as the OpenAI adapter.
 * Refusal fallbacks are deliberately not enabled: a fallback would answer with a different model than the one under test.
 */
export function createClaudeAgent(options: {
  model: string; promptVariant: PromptVariant; transport: ClaudeTransport;
  maxTurns?: number; maxOutputTokens?: number; timeoutMs?: number;
}): { agent: Agent; metadata: RunMetadata } {
  // Current Claude models think by default and thinking counts toward max_tokens, so the default cap is higher than OpenAI's.
  const { instructions, metadata, maxTurns, maxOutputTokens } = setUpTrial({ ...options, provider: 'anthropic', defaultOutputTokens: 4096 });
  let used = false;
  const agent: Agent = async context => {
    if (used) throw new Error('Create a fresh adapter for each trial');
    used = true;
    const signal = AbortSignal.timeout(options.timeoutMs ?? 120_000);
    // Append-only: assistant turns go back exactly as returned, which keeps thinking blocks valid across turns.
    const messages: Anthropic.MessageParam[] = [{ role: 'user', content: taskFor(context) }];
    const finish = (reason: string, result: AgentResult = { status: 'escalated' }) => { metadata.stopReason = reason; return result; };
    for (let turn = 0; turn < maxTurns; turn++) {
      signal.throwIfAborted();
      const response = await options.transport({
        model: options.model, max_tokens: maxOutputTokens, system: instructions, tools, messages,
        tool_choice: { type: 'auto', disable_parallel_tool_use: true },
      }, signal);
      const usage = response.usage;
      const inputTokens = usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
      metadata.modelCalls!++;
      metadata.inputTokens! += inputTokens;
      metadata.outputTokens! += usage.output_tokens;
      const calls = response.content.filter((block): block is Anthropic.ToolUseBlock => block.type === 'tool_use');
      const truncated = response.stop_reason === 'max_tokens';
      context.recordModelCall({ responseId: response.id, model: options.model, turn: turn + 1, stopReason: response.stop_reason ?? 'unknown', tools: calls.map(call => call.name),
        ...(truncated ? { truncated: true } : {}), ...(!calls.length && !truncated ? { textOnly: true } : {}),
        inputTokens, outputTokens: usage.output_tokens });
      const stop = response.stop_reason;
      // A refusal or a full context window is the provider stopping the run, not the agent choosing to escalate.
      if (stop === 'refusal' || stop === 'model_context_window_exceeded' || stop === null) {
        metadata.stopReason = `provider_${stop ?? 'unknown'}`;
        throw new Error(`Model response ended as ${metadata.stopReason}`);
      }
      if (calls.length > 1) return finish('unexpected_parallel_tools');
      messages.push({ role: 'assistant', content: response.content });
      if (stop === 'pause_turn') continue;
      if (truncated) {
        // A tool call cut off by max_tokens may be incomplete, so it is never run. Each one still needs a result before the next request.
        metadata.truncatedTurns!++;
        messages.push({ role: 'user', content: [
          ...calls.map(call => ({ type: 'tool_result' as const, tool_use_id: call.id, is_error: true, content: 'Not run: the response hit the output limit before this call was complete.' })),
          { type: 'text' as const, text: truncatedPrompt },
        ] });
        continue;
      }
      if (!calls.length) {
        metadata.textOnlyTurns!++;
        messages.push({ role: 'user', content: continuePrompt });
        continue;
      }
      const call = calls[0]!;
      const outcome = await runToolCall(context, call.name, call.input);
      if ('result' in outcome) return finish('finish_tool', outcome.result);
      if ('budgetExhausted' in outcome) return finish('tool_budget_exhausted');
      messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: call.id, content: JSON.stringify(outcome.output), ...(outcome.isError ? { is_error: true } : {}) }] });
    }
    return finish('turn_budget_exhausted');
  };
  return { agent, metadata };
}
