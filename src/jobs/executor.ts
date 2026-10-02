import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Run } from '../core/types.js';
import type { JobInput } from './types.js';

export type Executor = (input: JobInput, signal: AbortSignal) => Promise<Run>;
/** Process isolation for trusted fixtures, not a security sandbox. */
export function executeFixture(input: JobInput, signal: AbortSignal, timeoutMs = 10_000): Promise<Run> {
  if (signal.aborted) return Promise.reject(new Error('Execution aborted'));
  return new Promise((resolve, reject) => {
    const child = fork(fileURLToPath(new URL('./child.ts', import.meta.url)), [], {
      execArgv: ['--import', 'tsx', '--max-old-space-size=128'],
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      // Do not give fixture processes database credentials or unrelated API secrets.
      env: { PATH: process.env.PATH, NODE_ENV: 'production' },
    });
    let run: Run | undefined;
    let failure: Error | undefined;
    let finished = false;
    const terminate = (message: string) => {
      failure ??= new Error(message);
      child.kill('SIGKILL');
    };
    const abort = () => terminate('Execution aborted: worker lost ownership or is shutting down');
    const timer = setTimeout(() => terminate(`Execution exceeded ${timeoutMs}ms deadline`), timeoutMs);
    const clean = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    child.on('message', (message: { run?: Run; error?: string }) => {
      if (message.error) failure = new Error(message.error);
      if (message.run) run = message.run;
    });
    child.once('error', error => {
      if (finished) return;
      finished = true; clean(); reject(error);
    });
    child.once('exit', (code, exitSignal) => {
      if (finished) return;
      finished = true; clean();
      if (failure) reject(failure);
      else if (code !== 0 || !run) reject(new Error(`Fixture process exited without a result (${exitSignal ?? code})`));
      else resolve(run);
    });
    child.send(input, error => { if (error) terminate('Could not send the job to its fixture process'); });
  });
}
