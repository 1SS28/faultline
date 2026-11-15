/**
 * Faultline MCP proxy. Licensed under the Apache License, Version 2.0; see LICENSE.
 *
 * Sits between an agent and an MCP server, breaks chosen tool calls on purpose, then asks the
 * server what it really holds. See README.md.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema, ErrorCode, GetPromptRequestSchema, ListPromptsRequestSchema, ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema, ListToolsRequestSchema, ReadResourceRequestSchema, type CallToolResult, type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { createLab, faults, realClock, ToolFailure, type Check, type Fault, type Lab, type LabEvent } from 'faultline-sdk';

export const VERSION = '0.1.0';
export const faultKinds = ['timeout-after-commit', 'timeout-before-commit', 'rate-limit', 'malformed-response'] as const;
export type FaultKind = typeof faultKinds[number];
export const surfaces = ['tool-error', 'protocol-error'] as const;
/** How an injected failure reaches the agent: as a failed tool result, or as a JSON-RPC error. */
export type Surface = typeof surfaces[number];

/** One fault on one tool. `calls` counts that tool's calls from 1, and defaults to the first call. */
export interface FaultSpec {
  tool: string;
  kind: FaultKind;
  calls?: number[];
  /** For rate-limit: how long the tool stays limited. Defaults to 1000. */
  retryAfterMs?: number;
  /** For the two timeouts: the error text the agent sees. Defaults to "Request timed out". */
  message?: string;
}

/** A check on the server's own state, made with one of its read tools after the agent is done. */
export interface StateCheck {
  label: string;
  tool: string;
  args?: Record<string, unknown>;
  /** A regular expression. The check counts its matches in the text the tool returns. */
  count: string;
  min?: number;
  max?: number;
}
export const traceCounts = ['calls', 'ran', 'while-limited'] as const;
export type TraceCount = typeof traceCounts[number];

/** A check on what the agent did, read from the proxy's own trace after the agent is done. Give `count` or `readBeforeRetry`. */
export interface TraceCheck {
  label: string;
  tool: string;
  /** Only calls whose arguments include these values are looked at. */
  where?: Record<string, unknown>;
  /** What to count: every call, calls that reached the server, or calls made while an injected rate limit was still in force. */
  count?: TraceCount;
  min?: number;
  max?: number;
  /** After a call to `tool` fails, one of these tools has to return before `tool` is called again. */
  readBeforeRetry?: string[];
}
/** One call to the real server before or after the agent's session. It is outside the fault plan and the trace. */
export interface Step {
  tool: string;
  args?: Record<string, unknown>;
  /**
   * Runs the step once for each distinct match of `match` in what this read tool returns.
   * `{{match}}` in `args` becomes the first capture group, or the whole match if the pattern has none.
   */
  forEach?: { tool: string; args?: Record<string, unknown>; match: string };
}
export interface Plan { faults: FaultSpec[]; checks: StateCheck[]; trace: TraceCheck[]; setup: Step[]; cleanup: Step[]; surface: Surface }
export interface Report { status: 'passed' | 'failed' | 'unchecked'; checks: Check[]; events: LabEvent[] }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const positiveIntegers = (value: unknown): value is number[] => Array.isArray(value) && value.length > 0 && value.every(item => Number.isInteger(item) && item > 0);
function bounds(item: Record<string, unknown>, path: string): { min?: number; max?: number } {
  const bound = (name: 'min' | 'max') => {
    const value = item[name];
    if (value !== undefined && !(Number.isInteger(value) && (value as number) >= 0)) throw new Error(`${path}.${name} must be a whole number, 0 or more`);
    return value as number | undefined;
  };
  const min = bound('min'), max = bound('max');
  // with no bound, every count would pass
  if (min === undefined && max === undefined) throw new Error(`${path} needs "min", "max" or both`);
  return { min, max };
}

function steps(list: unknown, name: string): Step[] {
  if (!Array.isArray(list)) throw new Error(`"${name}" must be an array`);
  return list.map((item, index): Step => {
    const path = `${name}[${index}]`;
    if (!isRecord(item) || typeof item.tool !== 'string' || !item.tool) throw new Error(`${path} needs a "tool" name`);
    if (item.args !== undefined && !isRecord(item.args)) throw new Error(`${path}.args must be an object`);
    const step: Step = { tool: item.tool, args: item.args as Record<string, unknown> | undefined };
    const each = item.forEach;
    if (each === undefined) return step;
    if (!isRecord(each) || typeof each.tool !== 'string' || !each.tool) throw new Error(`${path}.forEach needs the "tool" that lists what to act on`);
    if (each.args !== undefined && !isRecord(each.args)) throw new Error(`${path}.forEach.args must be an object`);
    if (typeof each.match !== 'string' || !each.match) throw new Error(`${path}.forEach needs "match", a pattern that finds each item`);
    try { new RegExp(each.match); } catch { throw new Error(`${path}.forEach.match is not a valid regular expression`); }
    return { ...step, forEach: { tool: each.tool, args: each.args as Record<string, unknown> | undefined, match: each.match } };
  });
}

/** Validates a plan read from JSON or the command line. Throws an Error that says what to fix. */
export function parsePlan(input: unknown): Plan {
  if (!isRecord(input)) throw new Error('The plan must be a JSON object');
  const { faults: faultList = [], checks: checkList = [], trace: traceList = [], setup = [], cleanup = [], surface = 'tool-error' } = input;
  if (!Array.isArray(faultList) || !Array.isArray(checkList) || !Array.isArray(traceList)) throw new Error('"faults", "checks" and "trace" must be arrays');
  if (!surfaces.includes(surface as Surface)) throw new Error(`"surface" must be one of: ${surfaces.join(', ')}`);
  const plannedFaults = faultList.map((item, index): FaultSpec => {
    if (!isRecord(item) || typeof item.tool !== 'string' || !item.tool) throw new Error(`faults[${index}] needs a "tool" name`);
    if (!faultKinds.includes(item.kind as FaultKind)) throw new Error(`faults[${index}].kind must be one of: ${faultKinds.join(', ')}`);
    if (item.calls !== undefined && !positiveIntegers(item.calls)) throw new Error(`faults[${index}].calls must list call numbers, counting from 1`);
    if (item.retryAfterMs !== undefined && !(Number.isFinite(item.retryAfterMs) && (item.retryAfterMs as number) > 0)) throw new Error(`faults[${index}].retryAfterMs must be a positive number`);
    if (item.message !== undefined && typeof item.message !== 'string') throw new Error(`faults[${index}].message must be text`);
    return { tool: item.tool, kind: item.kind as FaultKind, calls: item.calls as number[] | undefined, retryAfterMs: item.retryAfterMs as number | undefined, message: item.message as string | undefined };
  });
  const plannedChecks = checkList.map((item, index): StateCheck => {
    if (!isRecord(item) || typeof item.label !== 'string' || !item.label) throw new Error(`checks[${index}] needs a "label"`);
    if (typeof item.tool !== 'string' || !item.tool) throw new Error(`checks[${index}] needs the "tool" that reads the server's state`);
    if (item.args !== undefined && !isRecord(item.args)) throw new Error(`checks[${index}].args must be an object`);
    if (typeof item.count !== 'string' || !item.count) throw new Error(`checks[${index}] needs "count", the text or pattern to count`);
    try { new RegExp(item.count); } catch { throw new Error(`checks[${index}].count is not a valid regular expression`); }
    return { label: item.label, tool: item.tool, args: item.args as Record<string, unknown> | undefined, count: item.count, ...bounds(item, `checks[${index}]`) };
  });
  const plannedTrace = traceList.map((item, index): TraceCheck => {
    const path = `trace[${index}]`;
    if (!isRecord(item) || typeof item.label !== 'string' || !item.label) throw new Error(`${path} needs a "label"`);
    if (typeof item.tool !== 'string' || !item.tool) throw new Error(`${path} needs the "tool" whose calls it looks at`);
    if (item.where !== undefined && !isRecord(item.where)) throw new Error(`${path}.where must be an object`);
    const base = { label: item.label, tool: item.tool, where: item.where as Record<string, unknown> | undefined };
    if ((item.count === undefined) === (item.readBeforeRetry === undefined)) throw new Error(`${path} needs "count" or "readBeforeRetry", and not both`);
    if (item.readBeforeRetry !== undefined) {
      const tools = item.readBeforeRetry;
      if (!Array.isArray(tools) || !tools.length || !tools.every(name => typeof name === 'string' && name)) throw new Error(`${path}.readBeforeRetry must list tool names`);
      return { ...base, readBeforeRetry: tools as string[] };
    }
    if (!traceCounts.includes(item.count as TraceCount)) throw new Error(`${path}.count must be one of: ${traceCounts.join(', ')}`);
    return { ...base, count: item.count as TraceCount, ...bounds(item, path) };
  });
  return { faults: plannedFaults, checks: plannedChecks, trace: plannedTrace, setup: steps(setup, 'setup'), cleanup: steps(cleanup, 'cleanup'), surface: surface as Surface };
}

/** Every tool a plan names, so a caller can refuse a misspelled one before the agent starts. */
export function planTools(plan: Pick<Plan, 'faults' | 'checks' | 'trace'> & Partial<Pick<Plan, 'setup' | 'cleanup'>>): string[] {
  const named = [...plan.faults, ...plan.checks, ...plan.trace].flatMap(item => [item.tool, ...('readBeforeRetry' in item ? item.readBeforeRetry ?? [] : [])]);
  const stepped = [...plan.setup ?? [], ...plan.cleanup ?? []].flatMap(step => [step.tool, ...(step.forEach ? [step.forEach.tool] : [])]);
  return [...new Set([...named, ...stepped])];
}

function fillMatch(value: unknown, match: string): unknown {
  // a value that is only the placeholder keeps a number a number, for tools that take numeric ids
  if (value === '{{match}}') return /^\d+$/.test(match) ? Number(match) : match;
  if (typeof value === 'string') return value.replaceAll('{{match}}', match);
  if (Array.isArray(value)) return value.map(item => fillMatch(item, match));
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, fillMatch(item, match)]));
  return value;
}

/**
 * Runs setup or cleanup steps against the real server, with no faults and no trace entries.
 * Returns how many calls it made. Throws on the first call that fails, naming the tool.
 */
export async function runSteps(upstream: Pick<Client, 'callTool'>, list: Step[]): Promise<number> {
  let calls = 0;
  const call = async (tool: string, args: Record<string, unknown> = {}) => {
    calls++;
    let result: CallToolResult;
    try { result = await upstream.callTool({ name: tool, arguments: args }) as CallToolResult; }
    catch (error) { throw new Error(`${tool} could not be called: ${error instanceof Error ? error.message : String(error)}`); }
    if (result.isError) throw new Error(`${tool} failed: ${textOf(result).slice(0, 200)}`);
    return result;
  };
  for (const step of list) {
    if (!step.forEach) { await call(step.tool, step.args); continue; }
    const listed = textOf(await call(step.forEach.tool, step.forEach.args));
    const found = new Set([...listed.matchAll(new RegExp(step.forEach.match, 'g'))].map(match => match[1] ?? match[0]));
    for (const value of found) await call(step.tool, fillMatch(step.args ?? {}, value) as Record<string, unknown>);
  }
  return calls;
}

/** Reads the command-line form of a fault: `tool:kind` or `tool:kind@1,3` for specific call numbers. */
export function parseFaultFlag(value: string): FaultSpec {
  const at = value.lastIndexOf('@');
  const target = at === -1 ? value : value.slice(0, at);
  const colon = target.lastIndexOf(':');
  if (colon < 1) throw new Error(`"${value}" should look like tool:kind or tool:kind@1,2`);
  const calls = at === -1 ? undefined : value.slice(at + 1).split(',').map(Number);
  return parsePlan({ faults: [{ tool: target.slice(0, colon), kind: target.slice(colon + 1), ...(calls && { calls }) }] }).faults[0]!;
}

function toFault(spec: FaultSpec): Fault {
  const when = { calls: spec.calls };
  // plain wording on purpose: a real timeout doesn't tell the agent that the outcome is unknown
  const timeout = () => new ToolFailure('TIMEOUT', spec.message ?? 'Request timed out');
  switch (spec.kind) {
    case 'timeout-after-commit': return faults.timeoutAfterCommit({ ...when, error: timeout });
    case 'timeout-before-commit': return faults.timeoutBeforeCommit({ ...when, error: timeout });
    case 'rate-limit': return faults.rateLimit({ ...when, retryAfterMs: spec.retryAfterMs });
    case 'malformed-response': return faults.malformedResponse({ ...when, replaceWith: () => ({ content: [] }) });
  }
}

/** Marks an error that came from the real server, so it is passed on instead of being mistaken for an injected one. */
class FromUpstream extends Error {
  constructor(readonly original: unknown) { super('upstream error'); }
}

function textOf(result: CallToolResult): string {
  const text = result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n');
  return text || JSON.stringify(result.structuredContent ?? result.content);
}

const describeRange = (min: number, max: number) =>
  min === max ? String(min) : max === Infinity ? `at least ${min}` : min === 0 ? `at most ${max}` : `${min} to ${max}`;

/**
 * Applies one trace check to a list of events. It needs nothing but the events, so it also works on
 * the trace saved in an earlier report.
 */
export function readTrace(spec: TraceCheck, events: LabEvent[]): { passed: boolean; expected: string; actual: string } {
  const key = (event: LabEvent) => `${event.data.tool}#${event.data.call}`;
  const keys = (list: LabEvent[]) => new Set(list.map(key));
  const requests = events.filter(event => event.kind === 'tool.request');
  const matches = (args: unknown) => Object.entries(spec.where ?? {}).every(([name, value]) => isRecord(args) && JSON.stringify(args[name]) === JSON.stringify(value));
  const own = keys(requests.filter(event => event.data.tool === spec.tool && matches((event.data.args as unknown[])[0])));
  const faulted = keys(events.filter(event => event.kind === 'fault.injected'));
  // a call turned away by a rate limit is recorded as a response with no result
  const rejected = events.filter(event => event.kind === 'tool.response' && !('response' in event.data));
  const returned = keys(events.filter(event => event.kind === 'tool.response' && 'response' in event.data && !(event.data.response as CallToolResult).isError));

  if (!spec.readBeforeRetry) {
    const found = spec.count === 'calls' ? own.size
      : spec.count === 'ran' ? events.filter(event => event.kind === 'tool.commit' && own.has(key(event))).length
      // the call that set the limit off doesn't count: the agent hadn't been told yet
      : rejected.filter(event => own.has(key(event)) && !faulted.has(key(event))).length;
    const min = spec.min ?? 0, max = spec.max ?? Infinity;
    return { passed: found >= min && found <= max, expected: describeRange(min, max), actual: String(found) };
  }

  let failed = false, unread = false, repeats = 0, blind = 0;
  for (const event of requests) {
    // a read only counts if it came back: one that failed or was faulted told the agent nothing
    if (spec.readBeforeRetry.includes(event.data.tool as string) && returned.has(key(event)) && !faulted.has(key(event))) unread = false;
    if (!own.has(key(event))) continue;
    if (failed) repeats++;
    if (failed && unread) blind++;
    failed = unread = faulted.has(key(event)) || !returned.has(key(event));
  }
  return {
    passed: blind === 0, expected: `${spec.readBeforeRetry.join(' or ')} first`,
    actual: !repeats ? 'no repeat after a failure'
      : blind ? `${blind} of ${repeats} repeat${repeats === 1 ? '' : 's'} after a failure came with no read first`
      : `${repeats} repeat${repeats === 1 ? '' : 's'} after a failure, each after a read`,
  };
}

/** Starts an MCP server as a child process and connects to it. The child gets this process's environment. */
export async function connectUpstream(command: string, args: string[] = [], options: { env?: Record<string, string>; cwd?: string } = {}): Promise<Client> {
  const env = Object.fromEntries(Object.entries({ ...process.env, ...options.env }).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  const client = new Client({ name: 'faultline-mcp-proxy', version: VERSION });
  await client.connect(new StdioClientTransport({ command, args, env, cwd: options.cwd, stderr: 'inherit' }));
  return client;
}

export function createFaultProxy(options: { upstream: Client; faults?: FaultSpec[]; surface?: Surface; lab?: Lab }) {
  const { upstream, surface = 'tool-error' } = options;
  const planned = options.faults ?? [];
  // real time by default, so a rate limit lasts as long as it says
  const lab = options.lab ?? createLab({ clock: realClock });
  const wrapped = new Map<string, (args: Record<string, unknown>) => Promise<CallToolResult>>();
  let checked = false;

  const toolFor = (name: string) => {
    let tool = wrapped.get(name);
    if (!tool) {
      const forward = async (args: Record<string, unknown>) => {
        try { return await upstream.callTool({ name, arguments: args }) as CallToolResult; }
        catch (error) { throw new FromUpstream(error); }
      };
      tool = lab.tool(name, forward, ...planned.filter(spec => spec.tool === name).map(toFault));
      wrapped.set(name, tool);
    }
    return tool;
  };

  /** Calls a tool the way the agent does: through the fault plan, and into the trace. */
  async function callTool(name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
    try {
      return await toolFor(name)(args);
    } catch (error) {
      if (error instanceof FromUpstream) throw error.original;
      const limited = error instanceof ToolFailure && error.code === 'RATE_LIMIT';
      const text = limited ? `Rate limit exceeded. Retry after ${(error as ToolFailure).retryAfterMs}ms.` : error instanceof Error ? error.message : String(error);
      if (surface === 'protocol-error') {
        // a bare error with a code: McpError would add its "MCP error" prefix twice on the way to the client
        throw Object.assign(new Error(text), { code: limited ? ErrorCode.InternalError : ErrorCode.RequestTimeout });
      }
      return { isError: true, content: [{ type: 'text', text }] };
    }
  }

  /** Every tool the server lists, across all pages. */
  async function listTools(): Promise<Tool[]> {
    const tools: Tool[] = [];
    let cursor: string | undefined;
    do {
      const page = await upstream.listTools(cursor ? { cursor } : undefined);
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    return tools;
  }

  /** Asks the real server about its state, with no faults and no trace entry, and records the answer as a check. */
  async function check(spec: StateCheck): Promise<void> {
    checked = true;
    const min = spec.min ?? 0, max = spec.max ?? Infinity;
    try {
      const result = await upstream.callTool({ name: spec.tool, arguments: spec.args ?? {} }) as CallToolResult;
      const text = textOf(result);
      const found = [...text.matchAll(new RegExp(spec.count, 'g'))].length;
      lab.check(spec.label, !result.isError && found >= min && found <= max,
        { expected: describeRange(min, max), actual: result.isError ? `${spec.tool} failed: ${text.slice(0, 200)}` : String(found) });
    } catch (error) {
      lab.check(spec.label, false, { expected: describeRange(min, max), actual: `${spec.tool} could not be called: ${error instanceof Error ? error.message : String(error)}` });
    }
  }

  /** Checks what the agent did, from the trace so far. Call it after the agent is done. */
  function checkTrace(spec: TraceCheck): void {
    checked = true;
    const { passed, ...details } = readTrace(spec, lab.result().events);
    lab.check(spec.label, passed, details);
  }

  /** Planned faults the agent never ran into, such as a write it never made. */
  function unusedFaults(): string[] {
    const fired = new Set(lab.result().events.filter(event => event.kind === 'fault.injected').map(event => `${event.data.tool}#${event.data.call}`));
    return planned.flatMap(spec => (spec.calls ?? [1]).filter(call => !fired.has(`${spec.tool}#${call}`)).map(call => `${spec.tool} call ${call} (${spec.kind})`));
  }

  /** The trace and checks so far. A run with no checks is reported as unchecked instead of passed. */
  function report(): Report {
    const result = lab.result();
    if (!checked) return { status: 'unchecked', checks: [], events: result.events };
    const unused = unusedFaults();
    // a fault that never fired tested nothing, so the checks can't count as a pass
    const fired: Check = { key: 'faults-fired', label: 'Every planned fault fired', passed: unused.length === 0, expected: 'all of them', actual: unused.length ? `never reached: ${unused.join(', ')}` : '' };
    const checks = planned.length ? [...result.checks, fired] : result.checks;
    return { status: checks.every(item => item.passed) ? 'passed' : 'failed', checks, events: result.events };
  }

  /** An MCP server that looks like the real one to the agent. Connect it to a transport. */
  function server(): Server {
    const info = upstream.getServerVersion();
    const capabilities = upstream.getServerCapabilities() ?? {};
    const proxy = new Server({ name: info?.name ?? 'faultline-mcp-proxy', version: info?.version ?? VERSION }, {
      capabilities: { tools: {}, ...(capabilities.resources && { resources: {} }), ...(capabilities.prompts && { prompts: {} }) },
      instructions: upstream.getInstructions(),
    });
    proxy.setRequestHandler(ListToolsRequestSchema, request => upstream.listTools(request.params));
    proxy.setRequestHandler(CallToolRequestSchema, request => callTool(request.params.name, request.params.arguments ?? {}));
    if (capabilities.resources) {
      proxy.setRequestHandler(ListResourcesRequestSchema, request => upstream.listResources(request.params));
      proxy.setRequestHandler(ListResourceTemplatesRequestSchema, request => upstream.listResourceTemplates(request.params));
      proxy.setRequestHandler(ReadResourceRequestSchema, request => upstream.readResource(request.params));
    }
    if (capabilities.prompts) {
      proxy.setRequestHandler(ListPromptsRequestSchema, request => upstream.listPrompts(request.params));
      proxy.setRequestHandler(GetPromptRequestSchema, request => upstream.getPrompt(request.params));
    }
    return proxy;
  }

  return { lab, upstream, callTool, listTools, check, checkTrace, report, unusedFaults, server };
}
export type FaultProxy = ReturnType<typeof createFaultProxy>;

/** Formats a report like `npm run faultline -- run`, for terminals and CI logs. */
export function formatReport(report: Report): string {
  return [
    report.status === 'unchecked' ? 'UNCHECKED (no checks were configured)' : report.status.toUpperCase(),
    ...report.events.map(event => `  ${String(event.sequence).padStart(2, '0')}  +${event.timeMs}ms  ${event.message}`),
    ...report.checks.map(item => `  ${item.passed ? '✓' : '✗'} ${item.label}${item.actual ? `: ${item.actual}` : ''}${!item.passed && item.expected ? ` (expected ${item.expected})` : ''}`),
  ].join('\n');
}
