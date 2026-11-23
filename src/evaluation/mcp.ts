import { createHash, randomBytes } from 'node:crypto';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createFaultProxy, parsePlan, planTools, runSteps, type Plan, type Report } from '../../packages/mcp/src/index.js';
import type { ClaudeTransport } from '../agents/anthropic.js';
import { defaultSystem, noUsage, runModelThroughProxy, type ModelRun, type Usage } from '../agents/mcp.js';
import { readAfterFault, reviewAnswer, type AnswerReview, type Finding } from './answers.js';
import { wilson95 } from './report.js';

interface Rate { input: number; output: number; cacheRead: number }
// $ per million tokens (claude-api skill, cached 2026-11-03)
const prices: Record<string, Rate & { longPrompt?: Rate }> = {
  'claude-fable-5-2': { input: 8, output: 40, cacheRead: 0.2 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1 },
  // haiku bills a call whose prompt passes 100,000 tokens at five times the price
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, longPrompt: { input: 0.5, output: 2.5, cacheRead: 0.05 } },
};
/** An estimate from published prices, or null for a model with no price on file. Five-minute cache writes cost 1.25x input. */
export function estimateCost(model: string, usage: Usage): number | null {
  const price = prices[model];
  if (!price) return null;
  // one long prompt prices the whole total at the higher rate: prompts only grow within a trial, and a limit should err high
  const rate = usage.longPromptCalls ? price.longPrompt ?? price : price;
  return (usage.inputTokens * rate.input + usage.cacheWriteTokens * rate.input * 1.25 + usage.cacheReadTokens * rate.cacheRead + usage.outputTokens * rate.output) / 1e6;
}

const placeholder = '{{run}}';
export const newRunId = () => `fl${randomBytes(4).toString('hex')}`;

/** Fills `{{run}}` everywhere in the plan with one trial's id, then validates it. */
export function planForRun(raw: unknown, runId: string): { task: string; system: string; plan: Plan } {
  const filled: unknown = JSON.parse(JSON.stringify(raw ?? null).replaceAll(placeholder, runId));
  if (typeof filled !== 'object' || filled === null || Array.isArray(filled)) throw new Error('The plan must be a JSON object');
  const { task, system = defaultSystem } = filled as Record<string, unknown>;
  if (typeof task !== 'string' || !task.trim()) throw new Error('The plan needs a "task": what to ask the model to do');
  if (typeof system !== 'string' || !system.trim()) throw new Error('"system" must be text');
  const plan = parsePlan(filled, ['task', 'system']);
  // the SDK's rule: a test with no checks proves nothing
  if (!plan.checks.length && !plan.trace.length) throw new Error('The plan needs at least one check, on the server\'s state or on the trace');
  return { task, system, plan };
}

export interface TrialRecord extends ModelRun {
  trial: number;
  runId: string;
  status: Report['status'];
  checks: Report['checks'];
  events: Report['events'];
  usage: Usage;
  costUsd: number | null;
  /** What the final answer claimed, set against the evidence. `null` when no judge was asked. It never changes `status`. */
  answer: AnswerReview | null;
}
export interface McpEvaluation {
  model: string;
  /** The task as the plan wrote it, with `{{run}}` still in place. */
  task: string;
  /** Ends in a hash of everything the model saw: system prompt, server instructions, task and tool definitions. */
  agentVersion: string;
  server: string | null;
  /** The server's own guidance as the model saw it, or null if it has none or it was left out. */
  serverInstructions: string | null;
  plannedTrials: number;
  /** The cost limit the run was given, or null. */
  maxCostUsd: number | null;
  completedTrials: number;
  executionError: string | null;
  interruptedTrial: { trial: number; runId: string; usage: Usage } | null;
  summary: {
    trials: number; passed: number; passRate: number | null;
    confidence95: ReturnType<typeof wilson95> | null;
    stopReasons: Record<string, number>;
    usage: Usage; costUsd: number | null;
    /** Answers that disagreed with what happened. The judge's calls are costed here, apart from the model under test. */
    answers: { judge: string; reviewed: number; unreviewed: number; findings: Record<Finding, number>; usage: Usage; costUsd: number | null } | null;
  };
  trials: TrialRecord[];
}

/**
 * Runs a model against a real MCP server through the fault proxy, several times. Each trial gets a fresh
 * proxy, so call numbers start again, and a fresh `{{run}}` id, so trials on one account don't collide.
 * A provider failure stops the evaluation and is never scored as the model's behaviour.
 */
export async function evaluateMcp(options: {
  upstream: Client; plan: unknown; transport: ClaudeTransport; model: string; trials: number;
  maxTurns: number; maxOutputTokens: number; maxResultChars?: number; serverInstructions?: boolean;
  /** A second model that reads each final answer. It sees the task and the answer, never the trace or the server's state. */
  judge?: { model: string; transport: ClaudeTransport };
  /** Stops before a model call once the estimated spend, judge included, has reached this many dollars. */
  maxCostUsd?: number;
  onTrial?: (record: TrialRecord) => void; runId?: () => string;
}): Promise<McpEvaluation> {
  const { upstream, model, trials } = options;
  const template = planForRun(options.plan, placeholder);
  if (trials > 1) {
    const uses = (value: unknown) => JSON.stringify(value ?? null).includes(placeholder);
    const { checks, trace, faults, setup, cleanup } = template.plan;
    // a label doesn't count: what a check counts has to differ from trial to trial
    const perTrial = checks.length ? checks.some(check => uses(check.count) || uses(check.args))
      : uses(template.task) || uses(faults) || uses(setup) || uses(cleanup) || uses(trace.map(check => check.where));
    if (!perTrial) throw new Error(`With more than one trial the plan must use ${placeholder} in ${checks.length ? 'what a state check counts or asks for' : 'its task'}. The server keeps what earlier trials wrote, so a later trial could pass on their leftovers.`);
  }
  const listed = await createFaultProxy({ upstream }).listTools();
  const tools = listed.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
  // the server's own word for which tools only read
  const readOnly = new Set(listed.filter(tool => tool.annotations?.readOnlyHint).map(tool => tool.name));
  const judgeUsage = noUsage();
  const known = new Set(tools.map(tool => tool.name));
  const unknown = planTools(template.plan).filter(name => !known.has(name));
  if (unknown.length) throw new Error(`The server has no tool named ${unknown.join(', ')}. Its tools: ${[...known].join(', ')}`);

  const server = upstream.getServerVersion();
  // a real client shows the model the server's own guidance, so the test does too
  const guidance = options.serverInstructions === false ? null : upstream.getInstructions()?.trim() || null;
  const withGuidance = (system: string) => guidance ? `${system}\n\nInstructions from the ${server?.name ?? 'MCP'} server:\n${guidance}` : system;
  // an estimate needs a price, and a limit that can't be enforced would be worse than none
  const unpriced = [model, ...(options.judge ? [options.judge.model] : [])].find(name => estimateCost(name, noUsage()) === null);
  if (options.maxCostUsd !== undefined && unpriced) throw new Error(`There is no price on file for ${unpriced}, so a cost limit can't be enforced`);
  const hash = createHash('sha256').update(withGuidance(template.system)).update(template.task).update(JSON.stringify(tools)).digest('hex');
  const records: TrialRecord[] = [];
  let executionError: string | null = null;
  let interruptedTrial: McpEvaluation['interruptedTrial'] = null;

  for (let trial = 1; trial <= trials; trial++) {
    const runId = (options.runId ?? newRunId)();
    const { task, system, plan } = planForRun(options.plan, runId);
    const proxy = createFaultProxy({ upstream, faults: plan.faults, surface: plan.surface });
    const usage = noUsage();
    const spent = () => records.reduce((sum, record) => sum + (record.costUsd ?? 0), 0) + (estimateCost(model, usage) ?? 0)
      + (options.judge ? estimateCost(options.judge.model, judgeUsage) ?? 0 : 0);
    const withinBudget = () => {
      if (options.maxCostUsd !== undefined && spent() >= options.maxCostUsd) throw new Error(`Stopped at the cost limit of $${options.maxCostUsd}, with about $${spent().toFixed(4)} spent`);
    };
    try {
      try { await runSteps(upstream, plan.setup); }
      catch (error) { throw new Error(`Setup failed: ${error instanceof Error ? error.message : String(error)}`); }
      const run = await runModelThroughProxy({ proxy, transport: options.transport, model, system: withGuidance(system), task, usage, beforeCall: withinBudget,
        maxTurns: options.maxTurns, maxOutputTokens: options.maxOutputTokens, maxResultChars: options.maxResultChars });
      for (const check of plan.checks) await proxy.check(check);
      for (const check of plan.trace) proxy.checkTrace(check);
      const report = proxy.report();
      // state checks are recorded first, ahead of trace checks and the fault check
      const stateOk = plan.checks.length ? report.checks.slice(0, plan.checks.length).every(check => check.passed) : null;
      // the judge is paid for too, so it isn't asked once the limit has been reached
      const answer = !options.judge ? null
        : options.maxCostUsd !== undefined && spent() >= options.maxCostUsd ? { claims: null, findings: [], error: 'Not reviewed: the cost limit was reached first' }
        : await reviewAnswer({ ...options.judge, task, answer: run.finalText, usage: judgeUsage, evidence: { stateOk, readAfterFault: readAfterFault(report.events, readOnly) } });
      const record: TrialRecord = { trial, runId, status: report.status, ...run, checks: report.checks, events: report.events, usage, costUsd: estimateCost(model, usage), answer };
      records.push(record);
      options.onTrial?.(record);
    } catch (error) {
      executionError = error instanceof Error ? error.message : 'Evaluation interrupted';
      interruptedTrial = { trial, runId, usage };
    }
    // also after a trial that was cut short, so a stopped run doesn't leave its writes behind
    try { await runSteps(upstream, plan.cleanup); }
    catch (error) { executionError ??= `Cleanup failed after trial ${trial}: ${error instanceof Error ? error.message : String(error)}`; }
    // leftovers would be counted by the next trial, so a failed cleanup ends the run too
    if (executionError) break;
  }

  const passed = records.filter(record => record.status === 'passed').length;
  const total = records.reduce<Usage>((sum, record) => {
    for (const key of Object.keys(sum) as Array<keyof Usage>) sum[key] += record.usage[key];
    return sum;
  }, { ...(interruptedTrial?.usage ?? noUsage()) });
  // trial by trial, so one trial on the higher rate doesn't reprice the rest
  const costUsd = estimateCost(model, noUsage()) === null ? null
    : records.reduce((sum, record) => sum + (record.costUsd ?? 0), 0) + (interruptedTrial ? estimateCost(model, interruptedTrial.usage) ?? 0 : 0);
  const reviews = records.flatMap(record => record.answer ? [record.answer] : []);
  const count = (finding: Finding) => reviews.filter(review => review.findings.includes(finding)).length;
  const answers = options.judge ? {
    judge: options.judge.model, reviewed: reviews.filter(review => review.claims).length, unreviewed: reviews.filter(review => !review.claims).length,
    findings: { 'claimed-success': count('claimed-success'), 'claimed-check': count('claimed-check'), 'denied-success': count('denied-success') },
    usage: judgeUsage, costUsd: estimateCost(options.judge.model, judgeUsage),
  } : null;
  return {
    model, task: template.task, agentVersion: `anthropic/${model}@${hash.slice(0, 8)}`, server: server ? `${server.name} ${server.version}` : null, serverInstructions: guidance,
    plannedTrials: trials, maxCostUsd: options.maxCostUsd ?? null, completedTrials: records.length, executionError, interruptedTrial,
    summary: {
      trials: records.length, passed, passRate: records.length ? Math.round(passed / records.length * 10000) / 100 : null,
      confidence95: records.length ? wilson95(passed, records.length) : null,
      stopReasons: records.reduce<Record<string, number>>((counts, record) => { counts[record.stopReason] = (counts[record.stopReason] ?? 0) + 1; return counts; }, {}),
      usage: total, costUsd, answers,
    },
    trials: records,
  };
}
