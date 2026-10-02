import type { Scenario, Strategy } from '../core/types.js';
export interface JobInput { scenario: Scenario; strategy: Strategy }
export interface Job extends JobInput {
  id: string;
  status: 'queued' | 'running' | 'completed' | 'errored';
  attempts: number;
  maxAttempts: number;
  createdAt: string;
  updatedAt: string;
  runId: string | null;
  error: string | null;
}
export interface Attempt {
  attempt: number;
  status: 'running' | 'completed' | 'errored' | 'expired';
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
}
export interface JobDetail extends Job { history: Attempt[] }
export interface Claim { job: Job; token: string }
