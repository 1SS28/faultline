import { mkdir, writeFile } from 'node:fs/promises';
import { runScenario } from './core/runner.js';
import { scenarios, strategies, type Run, type Scenario, type Strategy } from './core/types.js';
import { connectDatabase } from './db/database.js';
import { RunStore } from './db/store.js';

function display(run: Run) {
  console.log(`\n${run.status.toUpperCase()}  ${run.agentVersion} · ${run.scenario}`);
  console.log(`Run ${run.id}`);
  for (const event of run.events) console.log(`  ${String(event.sequence).padStart(2, '0')}  +${event.timeMs}ms  ${event.message}`);
  for (const assertion of run.assertions) console.log(`  ${assertion.passed ? '✓' : '✗'} ${assertion.label}: ${assertion.actual}`);
  console.log(`  Ledger: ${run.refunds.length} refund(s), $${(run.refunds.reduce((sum, refund) => sum + refund.amountCents, 0) / 100).toFixed(2)}`);
}
const [command = 'help', scenarioArg, strategyArg] = process.argv.slice(2);
if (!['demo', 'run', 'history', 'summary', 'regressions'].includes(command)) {
  console.log(`Faultline: crash tests for agent tool workflows

  npm run demo
  npm run faultline -- run <scenario> <naive|resilient>
  npm run faultline -- history
  npm run faultline -- summary
  npm run faultline -- regressions

Scenarios: ${scenarios.join(', ')}`);
  if (command !== 'help') process.exitCode = 2;
} else if (command === 'run' && (!scenarios.includes(scenarioArg as Scenario) || !strategies.includes(strategyArg as Strategy))) {
  console.error('Specify a valid scenario and strategy. Run npm run faultline for help.');
  process.exitCode = 2;
} else {
  const db = await connectDatabase({ url: process.env.DATABASE_URL, directory: process.env.FAULTLINE_DATA_DIR });
  try {
    const store = new RunStore(db);
    await store.migrate();
    if (command === 'history') console.table(await store.list());
    else if (command === 'summary') console.table(await store.summary());
    else if (command === 'regressions') {
      const regressions = await store.regressions();
      if (regressions.length) console.table(regressions);
      else console.log('No regressions. No agent version passes a scenario less often than the version before it.');
      // exit 1 on a regression, so CI can gate on it
      process.exitCode = regressions.length ? 1 : 0;
    }
    else {
      const runs: Run[] = [];
      for (const strategy of command === 'demo' ? strategies : [strategyArg as Strategy]) {
        const run = await runScenario({ scenario: command === 'demo' ? 'timeout-after-commit' : scenarioArg as Scenario, strategy });
        await store.save(run);
        runs.push(run);
        display(run);
      }
      await mkdir('.faultline/reports', { recursive: true });
      const reportPath = `.faultline/reports/${runs[0]!.id}.json`;
      await writeFile(reportPath, JSON.stringify({ fixture: true, runs }, null, 2));
      console.log(`\nSaved report: ${reportPath}`);
      // the demo passes only if the broken fixture fails and the fixed one passes
      process.exitCode = command === 'demo'
        ? (runs[0]?.status === 'failed' && runs[1]?.status === 'passed' ? 0 : 1)
        : (runs[0]?.status === 'passed' ? 0 : 1);
    }
  } finally { await db.close(); }
}
