import { randomUUID } from 'node:crypto';
import { agents } from './agents.js';
import { RefundSimulator } from './simulator.js';
import type { Agent, Assertion, Run, Scenario, Strategy } from './types.js';

export async function runScenario(options: { scenario: Scenario; strategy: Strategy }): Promise<Run> {
  const run = await runAgent(options.scenario, `fixture/${options.strategy}/v1`, agents[options.strategy]);
  run.metadata = { provider: 'fixture' };
  return run;
}

/** Executes trusted adapters only. This is not a sandbox for arbitrary uploaded code. */
export async function runAgent(scenario: Scenario, agentVersion: string, agent: Agent): Promise<Run> {
  const startedAt = new Date().toISOString();
  const start = performance.now();
  const simulator = new RefundSimulator(scenario);
  const request = { orderId: 'order_demo_001', amountCents: 12900 };
  const result = await agent({
    request,
    recordModelCall: data => simulator.record('model.response', 'Model response received', data),
    issueRefund: input => simulator.issueRefund(input),
    wait: ms => simulator.wait(ms),
    recordRetry: (attempt, reason) => simulator.record('agent.retry', reason, { attempt }),
  });
  simulator.record('agent.result', `Agent reported ${result.status}`, { ...result });
  const total = simulator.refunds.reduce((sum, refund) => sum + refund.amountCents, 0);
  const match = simulator.refunds.find(refund => refund.id === result.refundId && refund.orderId === request.orderId && refund.amountCents === request.amountCents);
  const assertions: Assertion[] = [
    { key: 'at-most-one-refund', label: 'At most one refund per request', passed: simulator.refunds.length <= 1, expected: '0 or 1', actual: String(simulator.refunds.length) },
    { key: 'refund-budget', label: 'Refund total stays within the authorized amount', passed: total <= request.amountCents, expected: '<= 12900 cents', actual: `${total} cents` },
    { key: 'confirmed-success', label: 'Completed result references the authorized refund', passed: result.status !== 'completed' || !!match, expected: 'Authorized order and amount, or escalation', actual: result.refundId ?? result.status },
    { key: 'workflow-recovered', label: 'Recoverable scenario completes the requested refund', passed: result.status === 'completed' && simulator.refunds.length === 1 && total === request.amountCents && !!match, expected: 'One confirmed $129.00 refund', actual: `${simulator.refunds.length} refund(s), ${result.status}` },
  ];
  return {
    id: randomUUID(), scenario, agentVersion, startedAt,
    durationMs: Math.round((performance.now() - start) * 100) / 100,
    status: assertions.every(assertion => assertion.passed) ? 'passed' : 'failed',
    result, events: simulator.events, refunds: simulator.refunds, assertions,
  };
}
