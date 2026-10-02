CREATE TABLE IF NOT EXISTS jobs (
  id UUID PRIMARY KEY,
  scenario TEXT NOT NULL,
  strategy TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'errored')),
  idempotency_key TEXT UNIQUE,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_until TIMESTAMPTZ,
  lease_token UUID,
  run_id UUID UNIQUE REFERENCES runs(id),
  error TEXT,
  CHECK ((status = 'running') = (lease_token IS NOT NULL AND lease_until IS NOT NULL)),
  CHECK ((status = 'completed') = (run_id IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS job_attempts (
  job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  attempt INTEGER NOT NULL CHECK (attempt > 0),
  lease_token UUID NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'errored', 'expired')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  error TEXT,
  PRIMARY KEY (job_id, attempt)
);
CREATE INDEX IF NOT EXISTS jobs_ready_idx ON jobs(available_at, created_at) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS jobs_expired_idx ON jobs(lease_until) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS jobs_created_idx ON jobs(created_at DESC, id DESC);
