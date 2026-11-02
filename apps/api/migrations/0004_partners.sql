-- Partner API: verified businesses that build on TradeChainX.
-- A partner is always linked to a TradeChainX business account whose wallet holds a valid
-- Business/Institutional identity on-chain. Everything a partner submits goes through the same
-- review gate as the TradeChainX app.

CREATE TABLE partners (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name             TEXT NOT NULL,
  account_user_id  UUID NOT NULL UNIQUE REFERENCES users(id),  -- the verified business account
  contact_email    TEXT NOT NULL,
  website          TEXT,
  referral_code    TEXT NOT NULL UNIQUE,                        -- attributes widget traffic
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  created_by       UUID NOT NULL REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Keys look like tcx_live_<prefix>_<secret>. Only sha256(key) is stored; the key is shown once.
CREATE TABLE api_keys (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id             UUID NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  name                   TEXT NOT NULL,
  prefix                 TEXT NOT NULL UNIQUE,               -- public part, safe to show/log
  key_hash               TEXT NOT NULL UNIQUE,
  scopes                 TEXT[] NOT NULL,                     -- subset of {read, issue, trade}
  rate_limit_per_minute  INT NOT NULL DEFAULT 60,
  daily_quota            INT NOT NULL DEFAULT 10000,
  last_used_at           TIMESTAMPTZ,
  revoked_at             TIMESTAMPTZ,
  created_by             UUID NOT NULL REFERENCES users(id),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (scopes <@ ARRAY['read','issue','trade']::TEXT[] AND cardinality(scopes) > 0)
);
CREATE INDEX api_keys_partner_idx ON api_keys (partner_id);

-- Daily request counts per key (quota + usage chart).
CREATE TABLE api_usage (
  api_key_id  UUID NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  day         DATE NOT NULL,
  requests    INT NOT NULL DEFAULT 0,
  PRIMARY KEY (api_key_id, day)
);

-- Webhook endpoints. The signing secret is derived (HMAC of WEBHOOK_SECRET_PEPPER, id, version)
-- so it's never stored; rotating bumps secret_version.
CREATE TABLE webhooks (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id      UUID NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  url             TEXT NOT NULL,
  events          TEXT[] NOT NULL,
  secret_version  INT NOT NULL DEFAULT 1,
  active          BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX webhooks_partner_idx ON webhooks (partner_id);

CREATE TABLE webhook_deliveries (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  webhook_id        UUID NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  event_id          TEXT NOT NULL,          -- stable id, e.g. evt_<chainId>_<txHash>_<logIndex>
  event_type        TEXT NOT NULL,
  payload           JSONB NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','delivered','failed')),
  attempts          INT NOT NULL DEFAULT 0,
  next_attempt_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_status_code  INT,
  last_error        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at      TIMESTAMPTZ,
  UNIQUE (webhook_id, event_id)
);
CREATE INDEX webhook_deliveries_due_idx ON webhook_deliveries (next_attempt_at) WHERE status = 'pending';

-- Attribution: which partner (and key) created a draft; which partner referred a trade/subscription.
ALTER TABLE drafts ADD COLUMN partner_id UUID REFERENCES partners(id);
ALTER TABLE drafts ADD COLUMN api_key_id UUID REFERENCES api_keys(id);

CREATE TABLE referrals (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id    UUID NOT NULL REFERENCES partners(id),
  user_id       UUID REFERENCES users(id),
  target_type   TEXT NOT NULL,           -- 'listing' | 'xown'
  target_id     TEXT NOT NULL,
  tx_hash       TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX referrals_partner_idx ON referrals (partner_id, created_at DESC);
