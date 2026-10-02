import { ToolFailure } from './simulator.js';
import type { Agent, Strategy } from './types.js';

function confirmed(value: unknown): value is { status: 'succeeded'; refundId: string } {
  return typeof value === 'object' && value !== null && 'status' in value && value.status === 'succeeded'
    && 'refundId' in value && typeof value.refundId === 'string' && value.refundId.length > 0;
}

/** Deliberately flawed fixture: retries without a stable key; trusts any non-error response. */
export const naive: Agent = async context => {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await context.issueRefund(context.request);
      return { status: 'completed', refundId: confirmed(response) ? response.refundId : undefined };
    } catch (error) {
      if (attempt === 3) break;
      context.recordRetry(attempt + 1, error instanceof Error ? error.message : 'Unknown error');
    }
  }
  return { status: 'escalated' };
};

/** Stable key, schema validation, bounded retries, and Retry-After handling. */
export const resilient: Agent = async context => {
  const request = { ...context.request, idempotencyKey: `refund:${context.request.orderId}:full` };
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await context.issueRefund(request);
      if (confirmed(response)) return { status: 'completed', refundId: response.refundId };
      if (attempt < 3) context.recordRetry(attempt + 1, 'Response was not a valid refund confirmation');
    } catch (error) {
      if (!(error instanceof ToolFailure)) throw error;
      if (attempt === 3) break;
      context.recordRetry(attempt + 1, error.message);
      if (error.code === 'RATE_LIMIT') await context.wait(error.retryAfterMs);
    }
  }
  return { status: 'escalated' };
};
export const agents: Record<Strategy, Agent> = { naive, resilient };
