import OpenAI from 'openai';
import type { FunctionTool, Response, ResponseCreateParamsNonStreaming, ResponseInputItem } from 'openai/resources/responses/responses';
import type { Agent, AgentResult, RunMetadata } from '../core/types.js';
import { continuePrompt, runToolCall, setUpTrial, taskFor, toolDescriptions, truncatedPrompt, type PromptVariant } from './shared.js';

export type { PromptVariant } from './shared.js';
export type ModelResponse = Pick<Response, 'id' | 'output' | 'usage' | 'status'> & Partial<Pick<Response, 'incomplete_details'>>;
export type ModelTransport = (request: ResponseCreateParamsNonStreaming, signal: AbortSignal) => Promise<ModelResponse>;
// OpenAI strict mode requires every property in `required`, so optional fields are nullable instead.
const tools: FunctionTool[] = [
  { type: 'function', name: 'issue_refund', description: toolDescriptions.issue_refund, strict: true,
    parameters: { type: 'object', additionalProperties: false, properties: { orderId: { type: 'string' }, amountCents: { type: 'integer' }, idempotencyKey: { type: ['string', 'null'] } }, required: ['orderId', 'amountCents', 'idempotencyKey'] } },
  { type: 'function', name: 'wait', description: toolDescriptions.wait, strict: true,
    parameters: { type: 'object', additionalProperties: false, properties: { milliseconds: { type: 'integer' } }, required: ['milliseconds'] } },
  { type: 'function', name: 'finish', description: toolDescriptions.finish, strict: true,
    parameters: { type: 'object', additionalProperties: false, properties: { status: { type: 'string', enum: ['completed', 'escalated'] }, refundId: { type: ['string', 'null'] } }, required: ['status', 'refundId'] } },
];

export function openAITransport(apiKey: string): ModelTransport {
  const client = new OpenAI({ apiKey, maxRetries: 0, timeout: 30_000 });
  return async (request, signal) => {
    try { return await client.responses.create(request, { signal }); }
    catch (error) {
      // Do not persist request headers, provider payloads, or credentials in reports.
      if (signal.aborted) throw new Error('Model execution deadline exceeded');
      if (error instanceof OpenAI.APIError) throw new Error(`Model request failed (HTTP ${error.status ?? 'unknown'})`);
      throw new Error('Model request could not be completed');
    }
  };
}

export function createOpenAIAgent(options: {
  model: string; promptVariant: PromptVariant; transport: ModelTransport;
  maxTurns?: number; maxOutputTokens?: number; timeoutMs?: number;
}): { agent: Agent; metadata: RunMetadata } {
  const { instructions, metadata, maxTurns, maxOutputTokens } = setUpTrial({ ...options, provider: 'openai', defaultOutputTokens: 1024 });
  let used = false;
  const agent: Agent = async context => {
    if (used) throw new Error('Create a fresh adapter for each trial');
    used = true;
    const signal = AbortSignal.timeout(options.timeoutMs ?? 120_000);
    const input: ResponseInputItem[] = [{ role: 'user', content: taskFor(context) }];
    const finish = (reason: string, result: AgentResult = { status: 'escalated' }) => { metadata.stopReason = reason; return result; };
    for (let turn = 0; turn < maxTurns; turn++) {
      signal.throwIfAborted();
      const response = await options.transport({
        model: options.model, instructions, tools, input, store: false,
        include: ['reasoning.encrypted_content'], parallel_tool_calls: false,
        max_output_tokens: maxOutputTokens,
      }, signal);
      metadata.modelCalls!++;
      metadata.inputTokens! += response.usage?.input_tokens ?? 0;
      metadata.outputTokens! += response.usage?.output_tokens ?? 0;
      const calls = response.output.filter(item => item.type === 'function_call');
      // Hitting our own output cap is agent behavior under test. Any other unfinished status is the provider's and must not be scored as an escalation.
      const truncated = response.status === 'incomplete' && response.incomplete_details?.reason === 'max_output_tokens';
      context.recordModelCall({ responseId: response.id, model: options.model, turn: turn + 1, status: response.status ?? 'unknown', tools: calls.map(call => call.name),
        ...(truncated ? { truncated: true } : {}), ...(!calls.length && !truncated ? { textOnly: true } : {}),
        inputTokens: response.usage?.input_tokens ?? 0, outputTokens: response.usage?.output_tokens ?? 0 });
      if (response.status !== 'completed' && !truncated) {
        metadata.stopReason = `provider_${response.status === 'incomplete' ? response.incomplete_details?.reason ?? 'incomplete' : response.status ?? 'unknown'}`;
        throw new Error(`Model response ended as ${metadata.stopReason}`);
      }
      if (calls.length > 1) return finish('unexpected_parallel_tools');
      if (truncated) metadata.truncatedTurns!++;
      // Preserve reasoning/output items in the conversation, without writing hidden reasoning to traces.
      input.push(...response.output as ResponseInputItem[]);
      if (!calls.length) {
        if (!truncated) metadata.textOnlyTurns!++;
        input.push({ role: 'user', content: truncated ? truncatedPrompt : continuePrompt });
        continue;
      }
      const call = calls[0]!;
      let args: unknown;
      try { args = JSON.parse(call.arguments); } catch { args = undefined; }
      const outcome = await runToolCall(context, call.name, args);
      if ('result' in outcome) return finish('finish_tool', outcome.result);
      if ('budgetExhausted' in outcome) return finish('tool_budget_exhausted');
      input.push({ type: 'function_call_output', call_id: call.call_id, output: JSON.stringify(outcome.output) });
    }
    return finish('turn_budget_exhausted');
  };
  return { agent, metadata };
}
