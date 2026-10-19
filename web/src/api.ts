import type { Run, Scenario, Strategy } from '../../src/core/types';
import type { Job, JobDetail } from '../../src/jobs/types';
export type RunSummary = Pick<Run, 'id' | 'scenario' | 'agentVersion' | 'startedAt' | 'durationMs' | 'status' | 'metadata'>;
export async function request<T>(path: string, body?: unknown, headers?: Record<string, string>): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? headers : { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    // fetch rejects with no status when the server is down or slow; the browser's own message ("Failed to fetch") explains nothing.
    if (error instanceof DOMException && error.name === 'TimeoutError') throw new Error('The local API took too long to respond. Check that it is still running.');
    throw new Error('Could not reach the local API. Start it with npm start, then try again.');
  }
  if (!response.ok) throw new Error(`Request failed (${response.status}). Check that the local API is running.`);
  return response.json() as Promise<T>;
}
export const api = {
  list: () => request<{ runs: RunSummary[] }>('/api/runs'),
  jobs: () => request<{ jobs: Job[] }>('/api/jobs'),
  job: (id: string) => request<JobDetail>(`/api/jobs/${encodeURIComponent(id)}`),
  async run(scenario: Scenario, strategy: Strategy, onProgress: (job: Job) => void): Promise<Run> {
    let job = await request<Job>('/api/jobs', { scenario, strategy }, { 'Idempotency-Key': crypto.randomUUID() });
    const deadline = Date.now() + 120_000;
    while (true) {
      onProgress(job);
      if (job.status === 'completed' && job.runId) return api.get(job.runId);
      if (job.status === 'errored') throw new Error(`Execution failed after ${job.attempts} attempts: ${job.error ?? 'unknown error'}`);
      if (Date.now() > deadline) throw new Error(`Job ${job.id.slice(0, 8)} is still ${job.status}. It remains saved; check the queue in Run history.`);
      await new Promise(resolve => setTimeout(resolve, 300));
      job = await api.job(job.id);
    }
  },
  get: (id: string) => request<Run>(`/api/runs/${encodeURIComponent(id)}`),
};
