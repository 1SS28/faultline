export const scenarios = ['baseline', 'timeout-after-commit', 'rate-limit', 'malformed-response'] as const;
export type Scenario = typeof scenarios[number];
export const strategies = ['naive', 'resilient'] as const;
export type Strategy = typeof strategies[number];
export interface RefundRequest { orderId: string; amountCents: number; idempotencyKey?: string }
export interface Refund { id: string; orderId: string; amountCents: number; idempotencyKey?: string }
export interface TraceEvent {
  sequence: number;
  timeMs: number;
  kind: 'tool.request' | 'tool.commit' | 'tool.response' | 'fault.injected' | 'agent.retry' | 'agent.wait' | 'agent.result' | 'model.response';
  message: string;
  data: Record<string, unknown>;
}
export interface Assertion { key: string; label: string; passed: boolean; expected: string; actual: string }
export interface AgentResult { status: 'completed' | 'escalated'; refundId?: string }
export interface AgentContext {
  request: RefundRequest;
  issueRefund(request: RefundRequest): Promise<unknown>;
  wait(ms: number): Promise<void>;
  recordRetry(attempt: number, reason: string): void;
  recordModelCall(data: Record<string, unknown>): void;
}
/** Adapter contract: wrap a trusted agent's refund tool with context.issueRefund. */
export type Agent = (context: AgentContext) => Promise<AgentResult>;
export interface RunMetadata {
  billingMode?: 'fixture' | 'byok' | 'included';
  billingSimulation?: boolean;
  provider: 'fixture' | 'openai';
  model?: string;
  promptVariant?: 'baseline' | 'recovery';
  promptHash?: string;
  modelCalls?: number;
  inputTokens?: number;
  outputTokens?: number;
  maxTurns?: number;
  maxOutputTokens?: number;
  stopReason?: string;
  evaluationId?: string;
  trial?: number;
}
export interface Run {
  id: string;
  scenario: Scenario;
  agentVersion: string;
  startedAt: string;
  durationMs: number;
  status: 'passed' | 'failed';
  result: AgentResult;
  events: TraceEvent[];
  refunds: Refund[];
  assertions: Assertion[];
  metadata?: RunMetadata;
}
