import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { connectUpstream } from '../../packages/mcp/src/index.js';
import { anthropicTransport } from '../agents/anthropic.js';
import { evaluateMcp, planForRun } from './mcp.js';

const help = `Faultline MCP evaluation: run a Claude model against a real MCP server with a fault injected

  npm run evaluate:mcp -- --plan plan.json --model MODEL --trials 3 --accept-costs -- <server command> [server args...]

The plan is the proxy's plan (packages/mcp/README.md) plus "task", what to ask the model, and an optional "system" prompt.
Write {{run}} in the task and checks: each trial replaces it with a fresh id, so trials on one account don't collide.

Needs ANTHROPIC_API_KEY, an explicit model, and --accept-costs. Tool calls reach the real server, so use a test account.
Limits: 1-20 trials; --max-turns 1-20 (default 10); --max-output-tokens 512-16000 per call (default 8192).`;

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  plan: { type: 'string' }, model: { type: 'string' }, trials: { type: 'string', default: '1' },
  'max-turns': { type: 'string', default: '10' }, 'max-output-tokens': { type: 'string', default: '8192' },
  'accept-costs': { type: 'boolean', default: false }, help: { type: 'boolean', default: false },
} });
if (values.help) {
  console.log(help);
  process.exit(0);
}
const fail = (message: string): never => {
  console.error(`${message}\n\n${help}`);
  process.exit(2);
};
const trials = Number(values.trials), maxTurns = Number(values['max-turns']), maxOutputTokens = Number(values['max-output-tokens']);
const [command, ...args] = positionals;
if (!values.plan) fail('Give a plan file with --plan');
if (!command) fail('Give the server command after "--"');
if (!Number.isInteger(trials) || trials < 1 || trials > 20) fail('Trials must be 1-20');
if (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 20) fail('max-turns must be 1-20');
if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 512 || maxOutputTokens > 16_000) fail('max-output-tokens must be 512-16000');
const model = values.model ?? process.env.ANTHROPIC_MODEL;
const apiKey = process.env.ANTHROPIC_API_KEY;
if (!values['accept-costs'] || !apiKey || !model) fail('Live evaluation requires ANTHROPIC_API_KEY, an explicit model, and --accept-costs. No model request was sent.');

let plan: unknown;
try {
  plan = JSON.parse(await readFile(values.plan!, 'utf8'));
  planForRun(plan, 'check');
} catch (error) {
  fail(`Could not use ${values.plan}: ${error instanceof Error ? error.message : String(error)}`);
}

const upstream = await connectUpstream(command!, args);
const id = randomUUID();
const startedAt = new Date().toISOString();
const dollars = (cost: number | null) => cost === null ? 'no price on file' : `$${cost.toFixed(4)}`;
console.log(`MCP evaluation: ${trials} trial(s) of ${model}, at most ${trials * maxTurns} model calls. Tool calls reach the real server, so use a test account.`);
try {
  // thinking on a long tool list can take longer than the refund scenarios' 30 seconds
  const evaluation = await evaluateMcp({ upstream, plan, transport: anthropicTransport(apiKey!, 120_000), model: model!, trials, maxTurns, maxOutputTokens,
    onTrial: record => {
      console.log(`[${record.trial}/${trials}] ${record.status.toUpperCase()} (${record.stopReason})  ${record.toolCalls.map(call => call.tool + (call.failed ? '!' : '')).join(' > ') || 'no tool calls'}  ${dollars(record.costUsd)}`);
      for (const check of record.checks.filter(item => !item.passed)) console.log(`      ✗ ${check.label}: ${check.actual}${check.expected ? ` (expected ${check.expected})` : ''}`);
    } });
  await mkdir('.faultline/evaluations', { recursive: true });
  const path = `.faultline/evaluations/mcp-${id}.json`;
  await writeFile(path, JSON.stringify({ evaluationId: id, startedAt, serverCommand: [command, ...args].join(' '), ...evaluation }, null, 2));
  const { summary } = evaluation;
  if (evaluation.executionError) console.error(`Interrupted on trial ${evaluation.interruptedTrial?.trial}: ${evaluation.executionError}`);
  if (summary.confidence95) console.log(`${summary.passed}/${summary.trials} passed (95% Wilson interval ${Math.round(summary.confidence95.lower * 100)}-${Math.round(summary.confidence95.upper * 100)}%)  ${evaluation.agentVersion}`);
  console.log(`Model calls ${summary.usage.modelCalls}, input ${summary.usage.inputTokens + summary.usage.cacheReadTokens + summary.usage.cacheWriteTokens} tokens (${summary.usage.cacheReadTokens} from cache), output ${summary.usage.outputTokens}, about ${dollars(summary.costUsd)}`);
  console.log(`Report: ${path}`);
  process.exitCode = evaluation.executionError || summary.passed < summary.trials ? 1 : 0;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
} finally {
  await upstream.close().catch(() => undefined);
}
