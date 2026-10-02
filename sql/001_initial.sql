CREATE TABLE IF NOT EXISTS runs (
  id UUID PRIMARY KEY,
  scenario TEXT NOT NULL,
  agent_version TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  duration_ms DOUBLE PRECISION NOT NULL CHECK (duration_ms >= 0),
  status TEXT NOT NULL CHECK (status IN ('passed', 'failed')),
  result JSONB NOT NULL
);
CREATE TABLE IF NOT EXISTS trace_events (
  run_id UUID NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  time_ms INTEGER NOT NULL CHECK (time_ms >= 0),
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  data JSONB NOT NULL,
  PRIMARY KEY (run_id, sequence)
);
CREATE TABLE IF NOT EXISTS refunds (
  run_id UUID NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  idempotency_key TEXT,
  PRIMARY KEY (run_id, id),
  UNIQUE (run_id, idempotency_key)
);
CREATE TABLE IF NOT EXISTS assertions (
  run_id UUID NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  label TEXT NOT NULL,
  passed BOOLEAN NOT NULL,
  expected TEXT NOT NULL,
  actual TEXT NOT NULL,
  PRIMARY KEY (run_id, key)
);
CREATE INDEX IF NOT EXISTS runs_started_at_idx ON runs(started_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS runs_version_scenario_idx ON runs(agent_version, scenario, started_at DESC);
CREATE INDEX IF NOT EXISTS failed_assertions_idx ON assertions(key, run_id) WHERE passed = false;
