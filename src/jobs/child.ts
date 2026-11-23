import { runScenario } from '../core/runner.js';
import { scenarios, strategies } from '../core/types.js';
import type { JobInput } from './types.js';

// built-in fixtures only: no path, shell command or code from the message is run
process.once('message', async (input: JobInput) => {
  try {
    if (!scenarios.includes(input.scenario) || !strategies.includes(input.strategy)) throw new Error('Unsupported fixture');
    const run = await runScenario(input);
    process.send?.({ run }, () => process.disconnect?.());
  } catch (error) {
    process.send?.({ error: error instanceof Error ? error.message : 'Execution failed' }, () => process.disconnect?.());
  }
});
// don't outlive the parent
process.once('disconnect', () => process.exit(0));
