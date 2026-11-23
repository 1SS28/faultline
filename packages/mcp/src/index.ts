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
import { createLab, faults, formatResult, realClock, ToolFailure, type Check, type Fault, type Lab, type LabEvent } from 'faultline-sdk';

export const VERSION = '0.1.0';
export const faultKinds = ['timeout-after-commit', 'timeout-before-commit', 'rate-limit', 'malformed-response', 'planted-text'] as const;
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
  /** For planted-text: what to add to the tool's real result. */
  text?: string;
  /** For planted-text: a JSON string field to add the text to, such as "body". Otherwise the text goes at the end. */
  field?: string;
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

// plan validation. every helper throws an Error that says what to fix
const fail = (message: string): never => { throw new Error(message); };
// anything that isn't an object fails on its first required field
const asRecord = (value: unknown) => isRecord(value) ? value : {};
// a misspelled field would otherwise be dropped, and the plan would run as a weaker one
function known(item: Record<string, unknown>, path: string, fields: string[]): void {
  const extra = Object.keys(item).find(name => item[name] !== undefined && !fields.includes(name));
  if (extra !== undefined) fail(`${path} has no field "${extra}". Its fields: ${fields.join(', ')}`);
}
function required(item: Record<string, unknown>, name: string, message: string): string {
  const value = item[name];
  return typeof value === 'string' && value ? value : fail(message);
}
function optionalObject(item: Record<string, unknown>, name: string, path: string): Record<string, unknown> | undefined {
  const value = item[name];
  return value === undefined || isRecord(value) ? value : fail(`${path}.${name} must be an object`);
}
function pattern(item: Record<string, unknown>, name: string, path: string, message: string): string {
  const value = required(item, name, message);
  try { new RegExp(value); } catch { fail(`${path}.${name} is not a valid regular expression`); }
  return value;
}
function bounds(item: Record<string, unknown>, path: string): { min?: number; max?: number } {
  const bound = (name: 'min' | 'max') => {
    const value = item[name];
    if (value !== undefined && !(Number.isInteger(value) && (value as number) >= 0)) fail(`${path}.${name} must be a whole number, 0 or more`);
    return value as number | undefined;
  };
  const min = bound('min'), max = bound('max');
  // with no bound, every count would pass
  if (min === undefined && max === undefined) fail(`${path} needs "min", "max" or both`);
  return { min, max };
}

function steps(list: unknown, name: string): Step[] {
  if (!Array.isArray(list)) return fail(`"${name}" must be an array`);
  return list.map((raw, index): Step => {
    const path = `${name}[${index}]`, item = asRecord(raw);
    known(item, path, ['tool', 'args', 'forEach']);
    const step: Step = { tool: required(item, 'tool', `${path} needs a "tool" name`), args: optionalObject(item, 'args', path) };
    if (item.forEach === undefined) return step;
    const each = asRecord(item.forEach), inner = `${path}.forEach`;
    known(each, inner, ['tool', 'args', 'match']);
    return { ...step, forEach: {
      tool: required(each, 'tool', `${inner} needs the "tool" that lists what to act on`),
      args: optionalObject(each, 'args', inner),
      match: pattern(each, 'match', inner, `${inner} needs "match", a pattern that finds each item`),
    } };
  });
}

// what each kind of fault takes besides tool, kind and calls
const faultFields: Record<FaultKind, string[]> = {
  'timeout-after-commit': ['message'], 'timeout-before-commit': ['message'], 'rate-limit': ['retryAfterMs'], 'malformed-response': [], 'planted-text': ['text', 'field'],
};
const planFields = ['faults', 'checks', 'trace', 'setup', 'cleanup', 'surface'];

/**
 * Validates a plan read from JSON or the command line. Throws an Error that says what to fix.
 * `also` names top-level fields the caller reads itself, such as the runner's "task".
 */
export function parsePlan(input: unknown, also: string[] = []): Plan {
  if (!isRecord(input)) return fail('The plan must be a JSON object');
  known(input, 'The plan', [...planFields, ...also]);
  const { faults: faultList = [], checks: checkList = [], trace: traceList = [], setup = [], cleanup = [], surface = 'tool-error' } = input;
  if (!Array.isArray(faultList) || !Array.isArray(checkList) || !Array.isArray(traceList)) return fail('"faults", "checks" and "trace" must be arrays');
  if (!surfaces.includes(surface as Surface)) fail(`"surface" must be one of: ${surfaces.join(', ')}`);

  const taken = new Set<string>();
  const plannedFaults = faultList.map((raw, index): FaultSpec => {
    const path = `faults[${index}]`, item = asRecord(raw);
    const tool = required(item, 'tool', `${path} needs a "tool" name`);
    const kind = faultKinds.includes(item.kind as FaultKind) ? item.kind as FaultKind : fail(`${path}.kind must be one of: ${faultKinds.join(', ')}`);
    known(item, `${path}, a ${kind} fault,`, ['tool', 'kind', 'calls', ...faultFields[kind]]);
    if (item.calls !== undefined && !positiveIntegers(item.calls)) fail(`${path}.calls must list call numbers, counting from 1`);
    if (item.retryAfterMs !== undefined && !(Number.isFinite(item.retryAfterMs) && (item.retryAfterMs as number) > 0)) fail(`${path}.retryAfterMs must be a positive number`);
    if (item.message !== undefined && typeof item.message !== 'string') fail(`${path}.message must be text`);
    // only one fault can fire on a call, so a second one there would count as fired without doing anything
    for (const call of (item.calls as number[] | undefined) ?? [1]) {
      if (taken.has(`${tool}#${call}`)) fail(`${path} is a second fault on call ${call} of ${tool}. Only one can fire on a call`);
      taken.add(`${tool}#${call}`);
    }
    const spec: FaultSpec = { tool, kind, calls: item.calls as number[] | undefined, retryAfterMs: item.retryAfterMs as number | undefined, message: item.message as string | undefined };
    if (kind !== 'planted-text') return spec;
    const text = required(item, 'text', `${path} needs "text", what to plant in the result`);
    if (item.field !== undefined && (typeof item.field !== 'string' || !item.field)) fail(`${path}.field must be a field name`);
    return { ...spec, text, field: item.field as string | undefined };
  });

  const plannedChecks = checkList.map((raw, index): StateCheck => {
    const path = `checks[${index}]`, item = asRecord(raw);
    known(item, path, ['label', 'tool', 'args', 'count', 'min', 'max']);
    return {
      label: required(item, 'label', `${path} needs a "label"`),
      tool: required(item, 'tool', `${path} needs the "tool" that reads the server's state`),
      args: optionalObject(item, 'args', path),
      count: pattern(item, 'count', path, `${path} needs "count", the text or pattern to count`),
      ...bounds(item, path),
    };
  });

  const plannedTrace = traceList.map((raw, index): TraceCheck => {
    const path = `trace[${index}]`, item = asRecord(raw);
    known(item, path, ['label', 'tool', 'where', 'count', 'min', 'max', 'readBeforeRetry']);
    const base = {
      label: required(item, 'label', `${path} needs a "label"`),
      tool: required(item, 'tool', `${path} needs the "tool" whose calls it looks at`),
      where: optionalObject(item, 'where', path),
    };
    if ((item.count === undefined) === (item.readBeforeRetry === undefined)) fail(`${path} needs "count" or "readBeforeRetry", and not both`);
    if (item.readBeforeRetry !== undefined) {
      const tools = item.readBeforeRetry;
      if (!Array.isArray(tools) || !tools.length || !tools.every(name => typeof name === 'string' && name)) return fail(`${path}.readBeforeRetry must list tool names`);
      // a call can't be the read that came before itself
      if (tools.includes(base.tool)) fail(`${path}.readBeforeRetry lists ${base.tool} itself. Name the read tools that show whether the call landed`);
      // bounds belong to "count", and would be dropped here
      known(item, path, ['label', 'tool', 'where', 'readBeforeRetry']);
      return { ...base, readBeforeRetry: tools as string[] };
    }
    if (!traceCounts.includes(item.count as TraceCount)) fail(`${path}.count must be one of: ${traceCounts.join(', ')}`);
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
  // a value that is only the placeholder becomes a number when the number is exactly that text, for tools that take numeric ids
  if (value === '{{match}}') return /^\d+$/.test(match) && String(Number(match)) === match ? Number(match) : match;
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

/** Adds text to a copy of a tool result: inside the first JSON string field called `field`, or at the end. */
function plant(result: CallToolResult, text: string, field?: string): CallToolResult {
  const content = result.content.map(block => ({ ...block }));
  const block = content.find(item => item.type === 'text');
  let planted = false;
  if (field && block?.type === 'text' && isJson(block.text)) {
    // spliced into the text as the server wrote it: parsing and printing it again would change long numbers and spacing
    const name = JSON.stringify(field).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const found = new RegExp(`${name}\\s*:\\s*"(?:[^"\\\\]|\\\\.)*`).exec(block.text);
    if (found) {
      const end = found.index + found[0].length;
      block.text = block.text.slice(0, end) + JSON.stringify(text).slice(1, -1) + block.text.slice(end);
      planted = true;
    }
  }
  if (!planted) {
    if (block?.type === 'text') block.text += text;
    else content.push({ type: 'text', text });
  }
  // a client may show the model the structured result instead of the text, so the same field gets the same text there
  let done = false;
  const visit = (value: unknown): unknown => {
    if (done || typeof value !== 'object' || value === null) return value;
    if (Array.isArray(value)) return value.map(visit);
    return Object.fromEntries(Object.entries(value).map(([name, item]) => {
      if (!done && name === field && typeof item === 'string') { done = true; return [name, item + text]; }
      return [name, visit(item)];
    }));
  };
  return { ...result, content, ...(field && isRecord(result.structuredContent) && { structuredContent: visit(result.structuredContent) as Record<string, unknown> }) };
}
const isJson = (text: string) => { try { JSON.parse(text); return true; } catch { return false; } };

function toFault(spec: FaultSpec): Fault {
  const when = { calls: spec.calls };
  // plain wording on purpose: a real timeout doesn't tell the agent that the outcome is unknown
  const timeout = () => new ToolFailure('TIMEOUT', spec.message ?? 'Request timed out');
  switch (spec.kind) {
    case 'timeout-after-commit': return faults.timeoutAfterCommit({ ...when, error: timeout });
    case 'timeout-before-commit': return faults.timeoutBeforeCommit({ ...when, error: timeout });
    case 'rate-limit': return faults.rateLimit({ ...when, retryAfterMs: spec.retryAfterMs });
    case 'malformed-response': return faults.malformedResponse({ ...when, replaceWith: () => ({ content: [] }) });
    // the call runs and its real result comes back, with the text added
    case 'planted-text': return { ...faults.malformedResponse({ ...when, replaceWith: result => plant(result as CallToolResult, spec.text ?? '', spec.field) }), label: spec.kind };
  }
}

/** Marks what the real server said, so it reaches the agent as it was instead of being mistaken for an injected failure. */
class FromUpstream extends Error {
  /** `refused` is a result the server marked as an error. Otherwise `original` is what the call threw. */
  constructor(readonly original: unknown, readonly refused?: CallToolResult) {
    super(refused ? textOf(refused) : original instanceof Error ? original.message : String(original));
  }
}

function textOf(result: CallToolResult): string {
  const text = result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n');
  return text || JSON.stringify(result.structuredContent ?? result.content);
}

const describeRange = (min: number, max: number) =>
  min === max ? String(min) : max === Infinity ? `at least ${min}` : min === 0 ? `at most ${max}` : `${min} to ${max}`;

/**
 * Applies one trace check to a list of events. It needs nothing but the events, so it also works on
 * the trace saved in an earlier report. Events are read in order, so a result only counts as known
 * to the agent from the moment it came back.
 */
export function readTrace(spec: TraceCheck, events: LabEvent[]): { passed: boolean; expected: string; actual: string } {
  const key = (event: LabEvent) => `${event.data.tool}#${event.data.call}`;
  const matches = (args: unknown) => Object.entries(spec.where ?? {}).every(([name, value]) => isRecord(args) && JSON.stringify(args[name]) === JSON.stringify(value));
  const own = new Set(events.filter(event => event.kind === 'tool.request' && event.data.tool === spec.tool && matches((event.data.args as unknown[])[0])).map(key));
  // a result the agent could use: it came back, and the server didn't call it an error
  const returned = (event: LabEvent) => event.kind === 'tool.response' && 'response' in event.data && !(event.data.response as CallToolResult).isError;
  // a call turned away by a rate limit is recorded with how long was left
  const turnedAway = (event: LabEvent) => event.kind === 'tool.response' && 'retryAfterMs' in event.data;

  if (!spec.readBeforeRetry) {
    let found = 0;
    if (spec.count === 'calls') found = own.size;
    else if (spec.count === 'ran') found = events.filter(event => event.kind === 'tool.commit' && own.has(key(event))).length;
    else {
      // a call counts only if a rejection had already come back when it was made. the call that set
      // the limit off, and calls made together with it, were made before the agent had been told
      let told = false;
      const knew = new Set<string>();
      for (const event of events) {
        if (event.data.tool !== spec.tool) continue;
        if (event.kind === 'tool.request') { if (told) knew.add(key(event)); }
        else if (turnedAway(event)) { if (knew.has(key(event)) && own.has(key(event))) found++; told = true; }
        // the limit is over once a call gets through
        else if (event.kind === 'tool.commit') told = false;
      }
    }
    const min = spec.min ?? 0, max = spec.max ?? Infinity;
    return { passed: found >= min && found <= max, expected: describeRange(min, max), actual: String(found) };
  }

  let failed = false, unread = false, repeats = 0, blind = 0;
  for (const event of events) {
    const mine = own.has(key(event));
    if (mine && event.kind === 'tool.request') {
      if (failed) repeats++;
      if (failed && unread) blind++;
      failed = false;
    } else if (mine && (event.kind === 'fault.injected' || (event.kind === 'tool.response' && !returned(event)))) {
      // from here the agent knows the call failed, and nothing it read before this says whether it landed
      failed = unread = true;
    } else if (returned(event) && spec.readBeforeRetry.includes(event.data.tool as string)) unread = false;
  }
  return {
    passed: blind === 0, expected: `${spec.readBeforeRetry.join(' or ')} first`,
    actual: !repeats ? 'no repeat after a failure'
      : blind ? `${blind} of ${repeats} repeat${repeats === 1 ? '' : 's'} after a failure came with no read first`
      : `${repeats} repeat${repeats === 1 ? '' : 's'} after a failure, each after a read`,
  };
}

/** The environment a server is started with: this process's, plus `env`, minus the names in `without`. */
export function serverEnv(base: Record<string, string | undefined>, options: { env?: Record<string, string>; without?: string[] } = {}): Record<string, string> {
  return Object.fromEntries(Object.entries({ ...base, ...options.env })
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && !options.without?.includes(entry[0])));
}

/**
 * Starts an MCP server as a child process and connects to it. The child gets this process's environment,
 * which is usually where its own credentials are. Name in `without` anything it has no business seeing.
 */
export async function connectUpstream(command: string, args: string[] = [], options: { env?: Record<string, string>; without?: string[]; cwd?: string } = {}): Promise<Client> {
  const env = serverEnv(process.env, options);
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

  const toolFor = (name: string) => {
    let tool = wrapped.get(name);
    if (!tool) {
      const forward = async (args: Record<string, unknown>) => {
        let result: CallToolResult;
        try { result = await upstream.callTool({ name, arguments: args }) as CallToolResult; }
        catch (error) { throw new FromUpstream(error); }
        // a call the server refused changed nothing, so no fault is spent on it and it isn't counted as a write
        if (result.isError) throw new FromUpstream(undefined, result);
        return result;
      };
      tool = lab.tool(name, forward, ...planned.filter(spec => spec.tool === name).map(toFault));
      wrapped.set(name, tool);
    }
    return tool;
  };
  // wrapped up front, so the lab knows about a fault on a tool the agent never calls
  for (const spec of planned) toolFor(spec.tool);

  /** Calls a tool the way the agent does: through the fault plan, and into the trace. */
  async function callTool(name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
    try {
      return await toolFor(name)(args);
    } catch (error) {
      if (error instanceof FromUpstream) {
        if (error.refused) return error.refused;
        throw error.original;
      }
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
    const { passed, ...details } = readTrace(spec, lab.result().events);
    lab.check(spec.label, passed, details);
  }

  /** The trace and checks so far. A run with no checks is reported as unchecked instead of passed. */
  function report(): Report {
    const { checks, events: raw } = lab.result();
    const plantedOn = new Set(planned.filter(spec => spec.kind === 'planted-text').flatMap(spec => (spec.calls ?? [1]).map(call => `${spec.tool}#${call}`)));
    // the SDK words every replaced result as malformed, which is wrong for one that is intact with text added
    const events = raw.map(event => event.kind === 'fault.injected' && plantedOn.has(`${event.data.tool}#${event.data.call}`)
      ? { ...event, message: `${event.data.tool} returned its result with text planted in it` } : event);
    // the lab adds two checks of its own: that anything was checked, and that every planned fault fired.
    // with only those, nothing was checked, so there is nothing to pass or fail
    if (checks.every(item => item.key === 'has-checks' || item.key === 'faults-fired')) return { status: 'unchecked', checks: [], events };
    return { status: checks.every(item => item.passed) ? 'passed' : 'failed', checks, events };
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

  return { lab, upstream, callTool, listTools, check, checkTrace, report, unusedFaults: lab.unfired, server };
}
export type FaultProxy = ReturnType<typeof createFaultProxy>;

/** Formats a report like `npm run faultline -- run`, for terminals and CI logs. */
export function formatReport(report: Report): string {
  if (report.status !== 'unchecked') return formatResult({ ...report, status: report.status });
  return formatResult({ ...report, status: 'failed' }).replace('FAILED', 'UNCHECKED (no checks were configured)');
}
