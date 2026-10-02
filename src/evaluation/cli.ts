import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { scenarios, strategies, type Run, type RunMetadata, type Scenario, type Strategy } from '../core/types.js';
import { runAgent, runScenario } from '../core/runner.js';
import { createOpenAIAgent, openAITransport } from '../agents/openai.js';
import { connectDatabase } from '../db/database.js';
import { RunStore } from '../db/store.js';
import { summarizeTrials } from './report.js';

const { values } = parseArgs({ options: {
  provider: { type: 'string', default: 'fixture' }, scenario: { type: 'string', default: 'all' },
  agent: { type: 'string', default: 'resilient' }, prompt: { type: 'string', default: 'recovery' },
  model: { type: 'string' }, trials: { type: 'string', default: '1' },
  'max-turns': { type: 'string', default: '6' }, 'max-output-tokens': { type: 'string', default: '1024' },
  'accept-costs': { type: 'boolean', default: false }, help: { type: 'boolean', default: false },
} });
if (values.help) {
  console.log('Faultline evaluation\n  npm run evaluate -- --provider fixture --agent resilient --trials 3\n  npm run evaluate -- --provider openai --model MODEL --scenario timeout-after-commit --trials 1 --accept-costs\n\nLive calls require OPENAI_API_KEY and explicit --accept-costs. --prompt baseline|recovery.\nLimits: 1-20 trials per scenario; --max-turns 1-12; --max-output-tokens 128-4096 per call.');
  process.exit(0);
}
const trials = Number(values.trials), maxTurns = Number(values['max-turns']), maxOutputTokens = Number(values['max-output-tokens']);
if (!['fixture', 'openai'].includes(values.provider!)) throw new Error('Provider must be fixture or openai');
if (!strategies.includes(values.agent as Strategy)) throw new Error('Agent must be naive or resilient');
if (!['baseline', 'recovery'].includes(values.prompt!)) throw new Error('Prompt must be baseline or recovery');
if (!Number.isInteger(trials) || trials < 1 || trials > 20) throw new Error('Trials must be 1-20');
if (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 12) throw new Error('max-turns must be 1-12');
if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 128 || maxOutputTokens > 4096) throw new Error('max-output-tokens must be 128-4096');
if (values.scenario !== 'all' && !scenarios.includes(values.scenario as Scenario)) throw new Error('Unknown scenario');
const live = values.provider === 'openai';
const model = values.model ?? process.env.OPENAI_MODEL;
if (live && (!values['accept-costs'] || !process.env.OPENAI_API_KEY || !model)) throw new Error('Live evaluation requires OPENAI_API_KEY, an explicit model, and --accept-costs. No model request was sent.');
const transport = live ? openAITransport(process.env.OPENAI_API_KEY!) : undefined;
const selected = values.scenario === 'all' ? scenarios : [values.scenario as Scenario];
const evaluationId = randomUUID();
const db = await connectDatabase({ url: process.env.DATABASE_URL, directory: process.env.FAULTLINE_DATA_DIR });
const runs: Run[] = [];
let executionError: string | undefined;
let interruptedTrial: { scenario: Scenario; trial: number; metadata: RunMetadata } | null = null;
const startedAt = new Date().toISOString();
try {
  const store = new RunStore(db); await store.migrate();
  console.log(`${values.provider} evaluation: ${selected.length * trials} trial(s), at most ${live ? selected.length * trials * maxTurns : 0} model calls.`);
  for (const scenario of selected) for (let trial = 1; trial <= trials; trial++) {
    let run: Run;
    if (transport) {
      const adapter = createOpenAIAgent({ model: model!, promptVariant: values.prompt as 'baseline' | 'recovery', transport, maxTurns, maxOutputTokens });
      interruptedTrial = { scenario, trial, metadata: adapter.metadata };
      run = await runAgent(scenario, `openai/${model}/${values.prompt}`, adapter.agent);
      run.metadata = { ...adapter.metadata, evaluationId, trial };
    } else {
      run = await runScenario({ scenario, strategy: values.agent as Strategy });
      run.metadata = { provider: 'fixture', evaluationId, trial };
    }
    await store.save(run); runs.push(run); interruptedTrial = null;
    console.log(`${scenario} [${trial}/${trials}] ${run.status.toUpperCase()} ${run.id}`);
  }
} catch (error) {
  executionError = error instanceof Error ? error.message : 'Evaluation interrupted';
  console.error(executionError);
} finally {
  await db.close();
  await mkdir('.faultline/evaluations', { recursive: true });
  const report = { evaluationId, provider: values.provider, model: live ? model : null, startedAt,
    plannedTrials: selected.length * trials, completedTrials: runs.length, executionError: executionError ?? null,
    interruptedTrial, summary: summarizeTrials(runs), runs };
  await writeFile(`.faultline/evaluations/${evaluationId}.json`, JSON.stringify(report, null, 2));
  console.table(report.summary.map(({ confidence95, failedAssertions, ...row }) => row));
  console.log(`Report: .faultline/evaluations/${evaluationId}.json`);
  process.exitCode = executionError || runs.some(run => run.status === 'failed') ? 1 : 0;
}
