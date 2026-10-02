import type { JobStore } from './store.js';
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
  /** A single durable claim/execution cycle; exposed for deterministic integration tests. */
  async tick(): Promise<boolean> {
    const claim = await this.jobs.claim();
    if (!claim) return false;
    const controller = new AbortController();
    let renewal: Promise<void> | undefined;
    const heartbeat = setInterval(() => {
      if (renewal) return;
      renewal = this.jobs.renew(claim).then(owned => {
        if (!owned) controller.abort();
      }, () => controller.abort()).finally(() => { renewal = undefined; });
    }, 5000);
    try {
      const run = await this.execute(claim.job, controller.signal);
      clearInterval(heartbeat);
      await renewal;
      if (!controller.signal.aborted) await this.jobs.complete(claim, run);
    } catch (error) {
      clearInterval(heartbeat);
      await renewal;
      if (!controller.signal.aborted) {
        await this.jobs.fail(claim, error instanceof Error ? error.message : 'Execution failed', Math.min(30_000, 1000 * 2 ** (claim.job.attempts - 1)));
      }
    } finally { clearInterval(heartbeat); }
    return true;
  }
  async stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    // The executor has a bounded deadline; let an in-flight result commit before closing SQL.
    await this.active;
  }
}
