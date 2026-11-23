import type { JobStore } from './store.js';
import type { Claim } from './types.js';
import { executeFixture, type Executor } from './executor.js';

export class JobWorker {
  private stopped = true;
  private timer?: ReturnType<typeof setTimeout>;
  private active?: Promise<boolean>;
  constructor(readonly jobs: JobStore, readonly execute: Executor = executeFixture,
    private readonly onError: (error: unknown) => void = error => console.error('Worker error:', error)) {}

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(0);
  }
  private schedule(delay: number) {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.active = this.tick();
      void this.active.then(worked => this.schedule(worked ? 0 : 250), error => {
        this.onError(error); this.schedule(1000);
      });
    }, delay);
  }
  /** One claim-and-run cycle. Public so tests can step the worker. */
  async tick(): Promise<boolean> {
    const claim = await this.jobs.claim();
    if (!claim) return false;
    await this.process(claim);
    return true;
  }
  /** Executes one claimed job while renewing its lease, then records the run or schedules a retry. */
  async process(claim: Claim): Promise<void> {
    const controller = new AbortController();
    let renewal: Promise<void> | undefined;
    const heartbeat = setInterval(() => {
      if (renewal) return;
      renewal = this.jobs.renew(claim).then(owned => {
        if (!owned) controller.abort();
      }, () => controller.abort()).finally(() => { renewal = undefined; });
    }, 5000);
    // a renewal still in flight has to land before the lease is checked
    const settle = async () => { clearInterval(heartbeat); await renewal; };
    try {
      const run = await this.execute(claim.job, controller.signal);
      await settle();
      if (!controller.signal.aborted) await this.jobs.complete(claim, run);
    } catch (error) {
      await settle();
      if (!controller.signal.aborted) {
        await this.jobs.fail(claim, error instanceof Error ? error.message : 'Execution failed', Math.min(30_000, 1000 * 2 ** (claim.job.attempts - 1)));
      }
    }
  }
  async stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    // the executor has a deadline, so wait for an in-flight result before the database closes
    await this.active;
  }
}
