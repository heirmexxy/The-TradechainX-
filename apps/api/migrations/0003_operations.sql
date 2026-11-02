-- Operations: gas station bookkeeping, fiat ramp transactions, and the system health monitor.

-- One row per gas top-up, so the cooldown survives restarts and there's an audit trail.
CREATE TABLE gas_topups (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  address     TEXT NOT NULL,
  amount_wei  NUMERIC(78,0) NOT NULL,
  tx_hash     TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX gas_topups_address_idx ON gas_topups (address, created_at DESC);

-- Deposits (fiat → USDC) and withdrawals (USDC → fiat) through the configured ramp provider.
-- The provider is the system of record; this mirrors its webhooks so users see progress.
CREATE TABLE ramp_transactions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES users(id),
  provider          TEXT NOT NULL,
  provider_ref      TEXT,                        -- provider's own id, set from the create response/webhook
  direction         TEXT NOT NULL CHECK (direction IN ('deposit','withdraw')),
  status            TEXT NOT NULL CHECK (status IN ('created','pending','completed','failed','cancelled')),
  fiat_currency     TEXT NOT NULL,
  fiat_amount       NUMERIC(20,2),
  usdc_amount       NUMERIC(78,0),               -- base units (6 dp)
  wallet_address    TEXT NOT NULL,
  tx_hash           TEXT,
  raw               JSONB NOT NULL DEFAULT '{}', -- last provider payload (no card/bank numbers are sent to us)
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_ref)
);
CREATE INDEX ramp_transactions_user_idx ON ramp_transactions (user_id, created_at DESC);

-- Latest result per health check (the admin "System health" page) …
CREATE TABLE health_checks (
  name         TEXT PRIMARY KEY,           -- e.g. 'database', 'indexer', 'supplier:alchemy'
  category     TEXT NOT NULL,              -- 'platform' | 'provider' | 'supplier'
  status       TEXT NOT NULL CHECK (status IN ('ok','degraded','down','unknown','disabled')),
  detail       TEXT NOT NULL,
  latency_ms   INT,
  data         JSONB NOT NULL DEFAULT '{}',
  checked_at   TIMESTAMPTZ NOT NULL,
  changed_at   TIMESTAMPTZ NOT NULL        -- when the status last changed
);

-- … and a log of status changes (what alerts are sent from).
CREATE TABLE health_events (
  id          BIGSERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  from_status TEXT,
  to_status   TEXT NOT NULL,
  detail      TEXT NOT NULL,
  alerted     BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX health_events_created_idx ON health_events (created_at DESC);
