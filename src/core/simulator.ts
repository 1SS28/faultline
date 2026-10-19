import type { Refund, RefundRequest, Scenario, TraceEvent } from './types.js';

export class ToolFailure extends Error {
  constructor(public readonly code: 'TIMEOUT' | 'RATE_LIMIT', message: string, public readonly retryAfterMs = 0) {
    super(message);
    this.name = 'ToolFailure';
  }
}

export class ToolBudgetExhausted extends Error {
  constructor() { super('Tool-call budget exhausted'); this.name = 'ToolBudgetExhausted'; }
}

/** In-memory service state belongs to exactly one run. It never calls a payment provider. */
export class RefundSimulator {
  readonly events: TraceEvent[] = [];
  readonly refunds: Refund[] = [];
  nowMs = 0;
  calls = 0;
  private faultInjected = false;
  private availableAt = 0;
  constructor(readonly scenario: Scenario, readonly maxCalls = 5) {}

  record(kind: TraceEvent['kind'], message: string, data: Record<string, unknown> = {}) {
    this.events.push({ sequence: this.events.length + 1, timeMs: this.nowMs, kind, message, data: structuredClone(data) });
  }
  async wait(ms: number) {
    if (!Number.isFinite(ms) || ms < 0 || ms > 60_000) throw new Error('Invalid simulated wait');
    this.record('agent.wait', `Wait ${ms}ms before retrying`, { durationMs: ms });
    this.nowMs += ms;
  }
  async issueRefund(request: RefundRequest): Promise<unknown> {
    this.calls++;
    this.record('tool.request', 'issue_refund requested', { ...request, attempt: this.calls });
    if (this.calls > this.maxCalls) throw new ToolBudgetExhausted();
    if (!request.orderId || !Number.isSafeInteger(request.amountCents) || request.amountCents <= 0) {
      throw new Error('Invalid refund request');
    }
    if (this.scenario === 'rate-limit') {
      if (!this.faultInjected) {
        this.faultInjected = true;
        this.availableAt = this.nowMs + 1000;
        this.record('fault.injected', 'Refund service rate-limited; retry after 1000ms', { code: 'RATE_LIMIT', retryAfterMs: 1000 });
      }
      if (this.nowMs < this.availableAt) {
        this.record('tool.response', '429 Too Many Requests', { retryAfterMs: this.availableAt - this.nowMs });
        throw new ToolFailure('RATE_LIMIT', 'Rate limited', this.availableAt - this.nowMs);
      }
    }
    const existing = request.idempotencyKey
      ? this.refunds.find(refund => refund.idempotencyKey === request.idempotencyKey)
      : undefined;
    if (existing && (existing.orderId !== request.orderId || existing.amountCents !== request.amountCents)) {
      throw new Error('Idempotency key reused with different arguments');
    }
    const refund = existing ?? { id: `refund_${this.refunds.length + 1}`, ...request };
    if (!existing) {
      this.refunds.push(refund);
      this.record('tool.commit', 'Refund committed to service ledger', { ...refund });
    }
    if (!this.faultInjected && this.scenario === 'timeout-after-commit') {
      this.faultInjected = true;
      this.record('fault.injected', 'Response lost after the refund committed', { code: 'TIMEOUT' });
      throw new ToolFailure('TIMEOUT', 'Connection timed out; outcome unknown');
    }
    if (!this.faultInjected && this.scenario === 'malformed-response') {
      this.faultInjected = true;
      this.record('fault.injected', 'Refund response is missing its ID and status', {});
      this.record('tool.response', 'Malformed response returned', { body: { accepted: true } });
      return { accepted: true };
    }
    const response = { status: 'succeeded', refundId: refund.id, amountCents: refund.amountCents };
    this.record('tool.response', existing ? 'Original refund returned for the same idempotency key' : 'Refund confirmed', { ...response, deduplicated: !!existing });
    return response;
  }
}
