import { runScenario } from '../../src/core/runner';
import type { Run, Scenario, Strategy, TraceEvent } from '../../src/core/types';

export const authorizedCents = 12900;
export const money = (cents: number) => '$' + (cents / 100).toFixed(2);

export const agents: Array<{ key: Strategy; name: string }> = [
  { key: 'naive', name: 'Naive agent' },
  { key: 'resilient', name: 'Careful agent' },
];

// Stories describe what the built-in agents do in each scenario. tests/runner.test.ts pins the behavior they rely on.
export const scenarios: Array<{ key: Scenario; name: string; question: string; stories: Record<Strategy, string> }> = [
  { key: 'timeout-after-commit', name: 'Lost reply', question: 'The refund goes through, but the reply never arrives. Does the agent retry without paying twice?',
    stories: { naive: 'The refund went through but the reply was lost. It tried again and refunded the customer a second time.', resilient: 'Same lost reply. It retried with the same request ID, so the service returned the first refund instead of making a new one.' } },
  { key: 'rate-limit', name: 'Rate limit', question: 'The service asks the agent to wait one second. Does it wait?',
    stories: { naive: 'It retried three times without waiting, got blocked every time, and gave up.', resilient: 'It waited the second it was asked to, and the refund went through.' } },
  { key: 'malformed-response', name: 'Broken reply', question: 'The refund goes through, but the reply has no confirmation number. Does the agent check?',
    stories: { naive: 'It reported success with no confirmation number to back it up.', resilient: 'It noticed the missing confirmation, asked again with the same request ID, and got the original refund back.' } },
  { key: 'baseline', name: 'Nothing breaks', question: 'Everything works normally. Both agents should finish the same task.',
    stories: { naive: 'Nothing went wrong, so it refunded once and finished.', resilient: 'Nothing went wrong, so it refunded once and finished.' } },
];

export type Pair = Record<Strategy, Run>;
export async function runBoth(scenario: Scenario): Promise<Pair> {
  const [naive, resilient] = await Promise.all([runScenario({ scenario, strategy: 'naive' }), runScenario({ scenario, strategy: 'resilient' })]);
  return { naive, resilient };
}

export function describe(event: TraceEvent, duplicate: boolean): string {
  const d = event.data as Record<string, unknown>;
  switch (event.kind) {
    case 'tool.request': return d.idempotencyKey ? `Attempt ${d.attempt}, request ID ${d.idempotencyKey}` : `Attempt ${d.attempt}, no request ID`;
    case 'tool.commit': return `${money(Number(d.amountCents))} paid out${duplicate ? ' again' : ''}`;
    case 'fault.injected': return 'Injected fault';
    case 'tool.response':
      if (d.status === 'succeeded') return d.deduplicated ? 'Same refund returned, no new payment' : `Confirmation ${d.refundId}`;
      return d.retryAfterMs ? `Wait ${d.retryAfterMs} ms` : 'No confirmation number';
    case 'agent.wait': return `${d.durationMs} ms of simulated time`;
    default: return '';
  }
}
