-- TradeChainX initial schema.
-- Two kinds of tables:
--   * Off-chain records the app owns (users, KYC cases, documents, drafts).
--   * Mirrors of on-chain state, written ONLY by the indexer (identities … xown_holdings).
-- Addresses are stored lowercase. Token amounts are NUMERIC(78,0) base units.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------- users & auth

CREATE TABLE users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email           TEXT NOT NULL UNIQUE,
  user_type       TEXT CHECK (user_type IN ('trader','warehouse','sme','originator','investor','lender')),
  display_name    TEXT,
  org_name        TEXT,
  wallet_address  TEXT UNIQUE,
  admin_roles     TEXT[] NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE login_codes (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email        TEXT NOT NULL,
  code_hash    TEXT NOT NULL,
  expires_at   TIMESTAMPTZ NOT NULL,
  attempts     INT NOT NULL DEFAULT 0,
  consumed_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX login_codes_email_idx ON login_codes (email, created_at DESC);

CREATE TABLE wallet_challenges (
  user_id     UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  nonce       TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL
);

-- ---------------------------------------------------------------- documents & KYC

CREATE TABLE documents (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id   UUID NOT NULL REFERENCES users(id),
  kind            TEXT NOT NULL,
  filename        TEXT NOT NULL,
  mime            TEXT NOT NULL,
  size_bytes      INT NOT NULL,
  sha256          TEXT NOT NULL,          -- 0x-prefixed hex; the value anchored on-chain
  storage_key     TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX documents_owner_idx ON documents (owner_user_id);

CREATE TABLE kyc_cases (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              UUID NOT NULL REFERENCES users(id),
  track                TEXT NOT NULL CHECK (track IN ('individual','business')),
  -- pending → (needs_info → pending)* → approved → verified   |   rejected
  -- "approved" = reviewer approved off-chain; "verified" = IdentitySet seen on-chain.
  status               TEXT NOT NULL CHECK (status IN ('pending','needs_info','approved','verified','rejected')),
  details              JSONB NOT NULL,
  document_ids         UUID[] NOT NULL DEFAULT '{}',
  record_ref           TEXT NOT NULL UNIQUE, -- bytes32 written to IdentityRegistry.recordRef
  approved_tier        INT,
  approved_valid_until BIGINT,
  reviewer_note        TEXT,
  reviewed_by          UUID REFERENCES users(id),
  submitted_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at          TIMESTAMPTZ,
  verified_at          TIMESTAMPTZ
);
CREATE INDEX kyc_cases_user_idx ON kyc_cases (user_id, submitted_at DESC);
CREATE INDEX kyc_cases_status_idx ON kyc_cases (status);

-- ---------------------------------------------------------------- drafts (off-chain side of submissions)

CREATE TABLE drafts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_type      TEXT NOT NULL CHECK (asset_type IN ('warehouse-receipt','lpo','carbon','xown','warehouse')),
  owner_user_id   UUID NOT NULL REFERENCES users(id),
  -- Plain-language details as entered (receipt numbers, buyer names). Private to owner + reviewers.
  fields          JSONB NOT NULL,
  -- Exact on-chain terms (hashes, codes, base units) the contract call uses.
  terms           JSONB NOT NULL,
  -- Contract-level duplicate key (receiptKey / lpoKey / batchKey / serialHash / licenceRef).
  key_hash        TEXT NOT NULL,
  document_ids    UUID[] NOT NULL DEFAULT '{}',
  submission_id   NUMERIC(78,0),           -- set by the indexer once the submission lands
  tx_hash         TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX drafts_owner_idx ON drafts (owner_user_id, created_at DESC);
CREATE INDEX drafts_key_idx ON drafts (asset_type, key_hash);

-- ---------------------------------------------------------------- indexer bookkeeping

CREATE TABLE chain_cursor (
  name        TEXT PRIMARY KEY,
  chain_id    INT NOT NULL,
  last_block  BIGINT NOT NULL
);

-- Every decoded contract event: the platform's audit trail.
CREATE TABLE chain_events (
  chain_id      INT NOT NULL,
  tx_hash       TEXT NOT NULL,
  log_index     INT NOT NULL,
  block_number  BIGINT NOT NULL,
  block_time    TIMESTAMPTZ NOT NULL,
  contract      TEXT NOT NULL,           -- lowercase address
  contract_name TEXT NOT NULL,
  event         TEXT NOT NULL,
  args          JSONB NOT NULL,          -- bigints serialised as strings
  entity_type   TEXT,                    -- e.g. 'warehouse-receipt'
  entity_id     TEXT,                    -- e.g. token id, listing id, address
  PRIMARY KEY (chain_id, tx_hash, log_index)
);
CREATE INDEX chain_events_entity_idx ON chain_events (entity_type, entity_id, block_number);
CREATE INDEX chain_events_block_idx ON chain_events (block_number);

-- ---------------------------------------------------------------- on-chain mirrors (indexer-owned)

CREATE TABLE identities (
  address      TEXT PRIMARY KEY,
  tier         INT NOT NULL,
  valid_until  BIGINT NOT NULL,
  frozen       BOOLEAN NOT NULL,
  record_ref   TEXT NOT NULL,
  updated_block BIGINT NOT NULL
);

CREATE TABLE warehouses (
  id            NUMERIC(78,0) PRIMARY KEY,
  operator      TEXT NOT NULL,
  licence_ref   TEXT NOT NULL,
  active        BOOLEAN NOT NULL,
  metadata_uri  TEXT NOT NULL,
  updated_block BIGINT NOT NULL
);

CREATE TABLE submissions (
  asset_type     TEXT NOT NULL,
  submission_id  NUMERIC(78,0) NOT NULL,
  submitter      TEXT NOT NULL,
  holder         TEXT,                   -- warehouse receipts only
  status         INT NOT NULL,           -- SubmissionStatus
  key_hash       TEXT NOT NULL,
  token_id       NUMERIC(78,0),
  terms          JSONB NOT NULL,
  draft_id       UUID REFERENCES drafts(id),
  updated_block  BIGINT NOT NULL,
  PRIMARY KEY (asset_type, submission_id)
);
CREATE INDEX submissions_status_idx ON submissions (status);

-- Whole assets (receipts, LPOs) and carbon batches.
CREATE TABLE assets (
  asset_type       TEXT NOT NULL,
  token_id         NUMERIC(78,0) NOT NULL,
  owner            TEXT,                 -- ERC-721 holder; NULL for carbon batches
  originator       TEXT NOT NULL,
  terms            JSONB NOT NULL,
  expires_at       BIGINT,
  burned_as        TEXT CHECK (burned_as IN ('redeemed','settled','voided','cancelled')),
  suspended        BOOLEAN NOT NULL DEFAULT false,
  total_supply     NUMERIC(78,0),        -- carbon
  retired          NUMERIC(78,0),        -- carbon
  lien             JSONB,                -- {lienholder, maturity, agreementRef}
  pending_request  JSONB,                -- {kind, requester, ...}
  submission_id    NUMERIC(78,0),
  draft_id         UUID REFERENCES drafts(id),
  issued_block     BIGINT NOT NULL,
  updated_block    BIGINT NOT NULL,
  PRIMARY KEY (asset_type, token_id)
);
CREATE INDEX assets_owner_idx ON assets (owner);

CREATE TABLE carbon_balances (
  batch_id  NUMERIC(78,0) NOT NULL,
  holder    TEXT NOT NULL,
  amount    NUMERIC(78,0) NOT NULL,
  PRIMARY KEY (batch_id, holder)
);
CREATE INDEX carbon_balances_holder_idx ON carbon_balances (holder);

CREATE TABLE retirements (
  retirement_id   NUMERIC(78,0) PRIMARY KEY,
  batch_id        NUMERIC(78,0) NOT NULL,
  holder          TEXT NOT NULL,
  amount          NUMERIC(78,0) NOT NULL,
  beneficiary_ref TEXT NOT NULL,
  reason_ref      TEXT NOT NULL,
  tx_hash         TEXT NOT NULL,
  block_time      TIMESTAMPTZ NOT NULL
);

CREATE TABLE listings (
  listing_id      NUMERIC(78,0) PRIMARY KEY,
  seller          TEXT NOT NULL,
  asset_type      TEXT NOT NULL,
  asset_address   TEXT NOT NULL,
  token_id        NUMERIC(78,0) NOT NULL,
  remaining       NUMERIC(78,0) NOT NULL,
  price_per_unit  NUMERIC(78,0) NOT NULL,
  fee_bps         INT NOT NULL,
  active          BOOLEAN NOT NULL,
  created_block   BIGINT NOT NULL,
  updated_block   BIGINT NOT NULL
);
CREATE INDEX listings_active_idx ON listings (active, asset_type);

CREATE TABLE trades (
  tx_hash      TEXT NOT NULL,
  log_index    INT NOT NULL,
  listing_id   NUMERIC(78,0) NOT NULL,
  buyer        TEXT NOT NULL,
  seller       TEXT NOT NULL,
  amount       NUMERIC(78,0) NOT NULL,
  total        NUMERIC(78,0) NOT NULL,
  fee          NUMERIC(78,0) NOT NULL,
  block_time   TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tx_hash, log_index)
);

CREATE TABLE xown_offerings (
  proposal_id      NUMERIC(78,0) PRIMARY KEY,
  vault            TEXT UNIQUE,
  proposer         TEXT NOT NULL,
  operator         TEXT NOT NULL,
  name             TEXT NOT NULL,
  symbol           TEXT NOT NULL,
  max_shares       NUMERIC(78,0) NOT NULL,
  price_per_share  NUMERIC(78,0) NOT NULL,
  deadline         BIGINT NOT NULL,
  proposal_status  INT NOT NULL,           -- ProposalStatus
  vault_state      INT,                    -- VaultState
  equipment_id     NUMERIC(78,0),
  equipment        JSONB NOT NULL,
  shares_sold      NUMERIC(78,0) NOT NULL DEFAULT 0,
  total_yield      NUMERIC(78,0) NOT NULL DEFAULT 0,
  proceeds         NUMERIC(78,0) NOT NULL DEFAULT 0,
  draft_id         UUID REFERENCES drafts(id),
  updated_block    BIGINT NOT NULL
);

CREATE TABLE xown_holdings (
  vault    TEXT NOT NULL,
  holder   TEXT NOT NULL,
  shares   NUMERIC(78,0) NOT NULL,
  PRIMARY KEY (vault, holder)
);
CREATE INDEX xown_holdings_holder_idx ON xown_holdings (holder);
