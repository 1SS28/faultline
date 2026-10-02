import { runScenario } from '../core/runner.js';
import { scenarios, strategies } from '../core/types.js';
import type { JobInput } from './types.js';

// Only built-in fixtures are accepted; no arbitrary path, shell command, or code is executed.
process.once('message', async (input: JobInput) => {
  try {
    if (!scenarios.includes(input.scenario) || !strategies.includes(input.strategy)) throw new Error('Unsupported fixture');
    const run = await runScenario(input);
    process.send?.({ run }, () => process.disconnect?.());
  } catch (error) {
    process.send?.({ error: error instanceof Error ? error.message : 'Execution failed' }, () => process.disconnect?.());
  }
});
// If the owning process dies, this child must not remain waiting indefinitely.
process.once('disconnect', () => process.exit(0));
