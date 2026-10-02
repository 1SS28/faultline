CREATE TABLE IF NOT EXISTS billing_accounts (
  id TEXT PRIMARY KEY,
  available INTEGER NOT NULL CHECK (available >= 0),
  reserved INTEGER NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  consumed INTEGER NOT NULL DEFAULT 0 CHECK (consumed >= 0)
);
CREATE TABLE IF NOT EXISTS billing_reservations (
  id UUID PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES billing_accounts(id),
  mode TEXT NOT NULL CHECK (mode IN ('fixture', 'byok', 'included')),
  simulated BOOLEAN NOT NULL,
  planned INTEGER NOT NULL CHECK (planned BETWEEN 1 AND 80),
  completed INTEGER NOT NULL DEFAULT 0 CHECK (completed >= 0 AND completed <= planned),
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'closed')),
  config JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS billing_trials (
  run_id UUID PRIMARY KEY REFERENCES runs(id),
  reservation_id UUID NOT NULL REFERENCES billing_reservations(id),
  input_tokens INTEGER NOT NULL CHECK (input_tokens >= 0),
  output_tokens INTEGER NOT NULL CHECK (output_tokens >= 0)
);
CREATE TABLE IF NOT EXISTS billing_ledger (
  id BIGSERIAL PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES billing_accounts(id),
  reference TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('grant', 'reserve', 'trial', 'release')),
  available_delta INTEGER NOT NULL,
  reserved_delta INTEGER NOT NULL,
  consumed_delta INTEGER NOT NULL,
  reservation_id UUID REFERENCES billing_reservations(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO billing_accounts(id, available) VALUES ('local-demo', 20) ON CONFLICT DO NOTHING;
INSERT INTO billing_ledger(account_id, reference, kind, available_delta, reserved_delta, consumed_delta)
VALUES ('local-demo', 'initial-demo-grant', 'grant', 20, 0, 0) ON CONFLICT DO NOTHING;
