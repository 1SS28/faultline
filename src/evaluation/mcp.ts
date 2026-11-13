import { createHash, randomBytes } from 'node:crypto';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createFaultProxy, parsePlan, type Plan, type Report } from '../../packages/mcp/src/index.js';
import type { ClaudeTransport } from '../agents/anthropic.js';
import { defaultSystem, noUsage, runModelThroughProxy, type ModelRun, type Usage } from '../agents/mcp.js';
import { wilson95 } from './report.js';

// $ per million tokens (claude-api skill table, cached 2026-11-03). Haiku's cache-read price is assumed at 0.1x input.
const prices: Record<string, { input: number; output: number; cacheRead: number }> = {
  'claude-fable-5-2': { input: 8, output: 40, cacheRead: 0.2 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01 },
};
/** An estimate from published prices, or null for a model with no price on file. Five-minute cache writes cost 1.25x input. */
export function estimateCost(model: string, usage: Usage): number | null {
  const price = prices[model];
  if (!price) return null;
  return (usage.inputTokens * price.input + usage.cacheWriteTokens * price.input * 1.25 + usage.cacheReadTokens * price.cacheRead + usage.outputTokens * price.output) / 1e6;
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
  const plan = parsePlan(filled);
  // the SDK's rule: a test with no checks proves nothing
  if (!plan.checks.length) throw new Error('The plan needs at least one check on the server\'s state');
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
}
export interface McpEvaluation {
  model: string;
  /** Ends in a hash of the system prompt, the server's instructions, the task and the tool definitions, so a change to any of them is a new version. */
  agentVersion: string;
  server: string | null;
  /** The server's own guidance as the model saw it, or null if it has none or it was left out. */
  serverInstructions: string | null;
  plannedTrials: number;
  completedTrials: number;
  executionError: string | null;
  interruptedTrial: { trial: number; runId: string; usage: Usage } | null;
  summary: {
    trials: number; passed: number; passRate: number | null;
    confidence95: ReturnType<typeof wilson95> | null;
    stopReasons: Record<string, number>;
    usage: Usage; costUsd: number | null;
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
  onTrial?: (record: TrialRecord) => void; runId?: () => string;
}): Promise<McpEvaluation> {
  const { upstream, model, trials } = options;
  const template = planForRun(options.plan, placeholder);
  if (trials > 1 && !JSON.stringify(options.plan).includes(placeholder)) {
    throw new Error(`With more than one trial the plan must use ${placeholder} in its task and checks. The server keeps what earlier trials wrote, so later trials would count their leftovers.`);
  }
  const tools = (await createFaultProxy({ upstream }).listTools()).map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
  const known = new Set(tools.map(tool => tool.name));
  const unknown = [...new Set([...template.plan.faults, ...template.plan.checks].map(item => item.tool).filter(name => !known.has(name)))];
  if (unknown.length) throw new Error(`The server has no tool named ${unknown.join(', ')}. Its tools: ${[...known].join(', ')}`);

  const server = upstream.getServerVersion();
  // a real client shows the model the server's own guidance, so the test does too
  const guidance = options.serverInstructions === false ? null : upstream.getInstructions()?.trim() || null;
  const withGuidance = (system: string) => guidance ? `${system}\n\nInstructions from the ${server?.name ?? 'MCP'} server:\n${guidance}` : system;
  const hash = createHash('sha256').update(withGuidance(template.system)).update(template.task).update(JSON.stringify(tools)).digest('hex');
  const records: TrialRecord[] = [];
  let executionError: string | null = null;
  let interruptedTrial: McpEvaluation['interruptedTrial'] = null;

  for (let trial = 1; trial <= trials; trial++) {
    const runId = (options.runId ?? newRunId)();
    const { task, system, plan } = planForRun(options.plan, runId);
    const proxy = createFaultProxy({ upstream, faults: plan.faults, surface: plan.surface });
    const usage = noUsage();
    try {
      const run = await runModelThroughProxy({ proxy, transport: options.transport, model, system: withGuidance(system), task, usage,
        maxTurns: options.maxTurns, maxOutputTokens: options.maxOutputTokens, maxResultChars: options.maxResultChars });
      for (const check of plan.checks) await proxy.check(check);
      const report = proxy.report();
      const record: TrialRecord = { trial, runId, status: report.status, ...run, checks: report.checks, events: report.events, usage, costUsd: estimateCost(model, usage) };
      records.push(record);
      options.onTrial?.(record);
    } catch (error) {
      executionError = error instanceof Error ? error.message : 'Evaluation interrupted';
      interruptedTrial = { trial, runId, usage };
      break;
    }
  }

  const passed = records.filter(record => record.status === 'passed').length;
  const total = records.reduce<Usage>((sum, record) => {
    for (const key of Object.keys(sum) as Array<keyof Usage>) sum[key] += record.usage[key];
    return sum;
  }, { ...(interruptedTrial?.usage ?? noUsage()) });
  return {
    model, agentVersion: `anthropic/${model}@${hash.slice(0, 8)}`, server: server ? `${server.name} ${server.version}` : null, serverInstructions: guidance,
    plannedTrials: trials, completedTrials: records.length, executionError, interruptedTrial,
    summary: {
      trials: records.length, passed, passRate: records.length ? Math.round(passed / records.length * 10000) / 100 : null,
      confidence95: records.length ? wilson95(passed, records.length) : null,
      stopReasons: records.reduce<Record<string, number>>((counts, record) => { counts[record.stopReason] = (counts[record.stopReason] ?? 0) + 1; return counts; }, {}),
      usage: total, costUsd: estimateCost(model, total),
    },
    trials: records,
  };
}
