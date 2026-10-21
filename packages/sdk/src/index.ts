/**
 * Faultline SDK. Licensed under the Apache License, Version 2.0; see LICENSE.
 *
 * Fault injection for your own agent's tools. Wrap the functions your agent calls with `lab.tool`,
 * run the agent, then record checks against your service's own state. See README.md.
 */

/** The error a fault throws unless you configure your own. `retryAfterMs` is set on rate limits. */
export class ToolFailure extends Error {
  constructor(public readonly code: 'TIMEOUT' | 'RATE_LIMIT', message: string, public readonly retryAfterMs = 0) {
    super(message);
    this.name = 'ToolFailure';
  }
}

export interface LabEvent {
  sequence: number;
  timeMs: number;
  kind: 'tool.request' | 'tool.commit' | 'tool.response' | 'fault.injected' | 'agent.wait';
  message: string;
  data: Record<string, unknown>;
}
export interface Check { key: string; label: string; passed: boolean; expected: string; actual: string }

export interface Clock { now(): number; sleep(ms: number): Promise<void> }

/** Simulated time: waits advance the clock instantly, so a test with a one-second backoff runs in microseconds. */
export function virtualClock(): Clock {
  let time = 0;
  return { now: () => time, sleep: async ms => { time += ms; } };
}
export const realClock: Clock = { now: () => Math.round(performance.now()), sleep: ms => new Promise(resolve => setTimeout(resolve, ms)) };

type When = { calls?: number[] };
type ErrorFactory = { error?: () => Error };
export type Fault =
  | { kind: 'timeout-after-commit' | 'timeout-before-commit'; calls: number[]; error?: () => Error }
  | { kind: 'rate-limit'; calls: number[]; retryAfterMs: number; error?: () => Error }
  | { kind: 'malformed-response'; calls: number[]; replaceWith: (result: unknown) => unknown };

/** Each fault applies to the listed call numbers of one tool, counting from 1. The default is the first call. */
export const faults = {
  /** The call runs and changes your service, then the caller gets a timeout. Retrying without an idempotency key repeats the side effect. */
  timeoutAfterCommit: (options: When & ErrorFactory = {}): Fault => ({ kind: 'timeout-after-commit', calls: options.calls ?? [1], error: options.error }),
  /** The call fails before it reaches your service. Retrying is safe, and giving up is a missed task. */
  timeoutBeforeCommit: (options: When & ErrorFactory = {}): Fault => ({ kind: 'timeout-before-commit', calls: options.calls ?? [1], error: options.error }),
  /** The service rejects calls until `retryAfterMs` has passed on the lab's clock. */
  rateLimit: (options: When & ErrorFactory & { retryAfterMs?: number } = {}): Fault => ({ kind: 'rate-limit', calls: options.calls ?? [1], retryAfterMs: options.retryAfterMs ?? 1000, error: options.error }),
  /** The call runs, but the caller gets `replaceWith(result)` instead of the real result. The default drops the whole result. */
  malformedResponse: (options: When & { replaceWith?: (result: unknown) => unknown } = {}): Fault => ({ kind: 'malformed-response', calls: options.calls ?? [1], replaceWith: options.replaceWith ?? (() => ({})) }),
};

export interface LabResult { status: 'passed' | 'failed'; checks: Check[]; events: LabEvent[] }

function snapshot(value: unknown): Record<string, unknown> {
  try { return structuredClone({ value }); } catch { return { value: String(value) }; }
}

export function createLab(options: { clock?: Clock } = {}) {
  const clock = options.clock ?? virtualClock();
  const events: LabEvent[] = [];
  const checks: Check[] = [];
  const executions = new Map<string, number>();
  const record = (kind: LabEvent['kind'], message: string, data: Record<string, unknown> = {}) => {
    events.push({ sequence: events.length + 1, timeMs: clock.now(), kind, message, data });
  };

  return {
    clock,
    /** Returns a function with the same signature as `fn` that injects the given faults. Bind methods first: `lab.tool('send', client.send.bind(client))`. */
    tool<A extends unknown[], R>(name: string, fn: (...args: A) => R | Promise<R>, ...plan: Fault[]): (...args: A) => Promise<R> {
      let calls = 0;
      let availableAt = -Infinity;
      let limit: Extract<Fault, { kind: 'rate-limit' }> | undefined;
      return async (...args: A): Promise<R> => {
        const call = ++calls;
        record('tool.request', `${name} called`, { tool: name, call, args: snapshot(args).value });
        const fault = plan.find(item => item.calls.includes(call));
        const fail = (factory: (() => Error) | undefined, fallback: () => Error): never => { throw factory ? factory() : fallback(); };
        if (fault?.kind === 'rate-limit') {
          limit = fault;
          availableAt = clock.now() + fault.retryAfterMs;
          record('fault.injected', `${name} rate-limited; retry after ${fault.retryAfterMs}ms`, { tool: name, call, retryAfterMs: fault.retryAfterMs });
        }
        if (clock.now() < availableAt) {
          const retryAfterMs = availableAt - clock.now();
          record('tool.response', `${name} rejected: rate limited`, { tool: name, call, retryAfterMs });
          // Every call inside the window is rejected, with the error the active rate limit was configured to throw.
          return fail(limit?.error, () => new ToolFailure('RATE_LIMIT', 'Rate limited', retryAfterMs));
        }
        if (fault?.kind === 'timeout-before-commit') {
          record('fault.injected', `${name} timed out before reaching the service`, { tool: name, call });
          return fail(fault.error, () => new ToolFailure('TIMEOUT', 'Connection timed out; outcome unknown'));
        }
        const result = await fn(...args);
        executions.set(name, (executions.get(name) ?? 0) + 1);
        record('tool.commit', `${name} ran against the service`, { tool: name, call });
        if (fault?.kind === 'timeout-after-commit') {
          record('fault.injected', `${name} ran, but its response was lost`, { tool: name, call });
          return fail(fault.error, () => new ToolFailure('TIMEOUT', 'Connection timed out; outcome unknown'));
        }
        if (fault?.kind === 'malformed-response') {
          const replaced = fault.replaceWith(result);
          record('fault.injected', `${name} returned a malformed response`, { tool: name, call, response: snapshot(replaced).value });
          return replaced as R;
        }
        record('tool.response', `${name} returned`, { tool: name, call, response: snapshot(result).value });
        return result;
      };
    },
    /** Waits on the lab's clock. Agents that should honour Retry-After call this instead of setTimeout. */
    async wait(ms: number) {
      record('agent.wait', `Wait ${ms}ms`, { durationMs: ms });
      await clock.sleep(ms);
    },
    /** How many times a wrapped tool actually reached your function (faulted calls that never ran are not counted). */
    ran: (name: string) => executions.get(name) ?? 0,
    /** Records a check. Base it on your service's own records, not on what the agent reports. */
    check(label: string, passed: boolean, details: { expected?: string; actual?: string } = {}) {
      checks.push({ key: `check-${checks.length + 1}`, label, passed, expected: details.expected ?? '', actual: details.actual ?? '' });
    },
    result(): LabResult {
      // A test with no checks proves nothing, so it fails rather than passing by default.
      const all = checks.length ? [...checks] : [{ key: 'has-checks', label: 'The test recorded at least one check', passed: false, expected: '1 or more checks', actual: '0' }];
      return { status: all.every(check => check.passed) ? 'passed' : 'failed', checks: all, events: [...events] };
    },
  };
}
export type Lab = ReturnType<typeof createLab>;

/** Formats a result like `npm run faultline -- run`, for readable test failures and CI logs. */
export function formatResult(result: LabResult): string {
  return [
    result.status.toUpperCase(),
    ...result.events.map(event => `  ${String(event.sequence).padStart(2, '0')}  +${event.timeMs}ms  ${event.message}`),
    ...result.checks.map(check => `  ${check.passed ? '✓' : '✗'} ${check.label}${check.actual ? `: ${check.actual}` : ''}${!check.passed && check.expected ? ` (expected ${check.expected})` : ''}`),
  ].join('\n');
}
