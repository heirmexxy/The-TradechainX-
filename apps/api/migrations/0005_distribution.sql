-- Distribution layer (PRD v3): commodity classes and lots, reference prices, distributors and their
-- customers, naira orders and a double-entry ledger, settlements and holding-fee charges.
-- Amounts: naira is BIGINT kobo; commodity quantities are BIGINT grams / units (1 unit = 1 g).
-- The chain remains the source of truth for ownership. These tables hold what the chain cannot:
-- prices, orders, cash movements and the audit trail around them.

-- ------------------------------------------------------------------ commodity classes, lots, proof of stock

CREATE TABLE commodity_classes (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chain_class_id     NUMERIC(78,0) UNIQUE,              -- CommodityUnits class id, set once created on-chain
  commodity          TEXT NOT NULL,                     -- e.g. SOYBEAN
  grade              TEXT NOT NULL,                     -- e.g. GRADE_1
  display_name       TEXT NOT NULL,                     -- "Soybean Grade 1"
  grading_standard   TEXT NOT NULL,
  offtake_buyer      TEXT,                              -- the processor behind the exit
  price_sources      JSONB NOT NULL DEFAULT '[]',       -- published reference-price method inputs
  shrinkage_bps      INT NOT NULL CHECK (shrinkage_bps BETWEEN 0 AND 2000),
  max_fee_bps        INT NOT NULL CHECK (max_fee_bps BETWEEN 0 AND 500),
  active             BOOLEAN NOT NULL DEFAULT true,
  halted             BOOLEAN NOT NULL DEFAULT false,    -- mirrored from the chain by the indexer
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (commodity, grade)
);

CREATE TABLE commodity_lots (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chain_lot_id     NUMERIC(78,0) UNIQUE,
  class_id         UUID NOT NULL REFERENCES commodity_classes(id),
  warehouse_id     NUMERIC(78,0) NOT NULL REFERENCES warehouses(id),
  lot_ref          TEXT NOT NULL,                       -- warehouse's own intake reference
  gross_grams      BIGINT NOT NULL CHECK (gross_grams > 0),
  attested_grams   BIGINT CHECK (attested_grams > 0),
  remaining_grams  BIGINT CHECK (remaining_grams >= 0),
  issued_live      BIGINT NOT NULL DEFAULT 0 CHECK (issued_live >= 0),
  status           TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','attested','live','rejected','withdrawn','depleted')),
  monitoring_ok    BOOLEAN NOT NULL DEFAULT false,
  document_hash    TEXT,
  attestation_ref  TEXT,
  intake_date      DATE NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (warehouse_id, lot_ref)
);
CREATE INDEX commodity_lots_class_idx ON commodity_lots (class_id, status);

-- Sensor readings (WareGuard) shown on the public proof-of-stock page.
CREATE TABLE stock_readings (
  id               BIGSERIAL PRIMARY KEY,
  lot_id           UUID NOT NULL REFERENCES commodity_lots(id) ON DELETE CASCADE,
  read_at          TIMESTAMPTZ NOT NULL,
  moisture_pct     NUMERIC(5,2),
  temperature_c    NUMERIC(5,2),
  humidity_pct     NUMERIC(5,2)
);
CREATE INDEX stock_readings_lot_idx ON stock_readings (lot_id, read_at DESC);

-- Processor sales mirror the on-chain sale records and carry the cash side.
CREATE TABLE lot_sales (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chain_sale_id    NUMERIC(78,0) UNIQUE,
  lot_id           UUID NOT NULL REFERENCES commodity_lots(id),
  grams            BIGINT NOT NULL CHECK (grams > 0),
  units_to_retire  BIGINT NOT NULL CHECK (units_to_retire >= 0),
  units_retired    BIGINT NOT NULL DEFAULT 0 CHECK (units_retired >= 0),
  sale_ref         TEXT NOT NULL,
  proceeds_kobo    BIGINT CHECK (proceeds_kobo >= 0),  -- what the processor actually paid, less costs
  status           TEXT NOT NULL DEFAULT 'proposed'
                   CHECK (status IN ('proposed','approved','completed','cancelled')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------------ prices and market parameters

-- Published reference prices. Written by the price service; each row needs a committee approver,
-- independent of the trading desk. Never updated in place: a new price is a new row.
CREATE TABLE reference_prices (
  id                    BIGSERIAL PRIMARY KEY,
  class_id              UUID NOT NULL REFERENCES commodity_classes(id),
  price_kobo_per_kg     BIGINT NOT NULL CHECK (price_kobo_per_kg > 0),
  method_version        TEXT NOT NULL,
  sources               JSONB NOT NULL,                -- inputs, weights and outlier decisions
  kitovu_weight_bps     INT NOT NULL CHECK (kitovu_weight_bps BETWEEN 0 AND 10000),
  approved_by           UUID NOT NULL REFERENCES users(id),
  published_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX reference_prices_latest_idx ON reference_prices (class_id, published_at DESC);

-- Versioned market parameters (spreads, limits, reserve floor). Latest effective row wins.
CREATE TABLE market_params (
  id                          BIGSERIAL PRIMARY KEY,
  class_id                    UUID NOT NULL REFERENCES commodity_classes(id),
  user_spread_bps             INT NOT NULL CHECK (user_spread_bps BETWEEN 0 AND 9999),
  buyback_spread_bps          INT NOT NULL CHECK (buyback_spread_bps BETWEEN 0 AND 9999),
  fee_kobo_per_kg_month       BIGINT NOT NULL CHECK (fee_kobo_per_kg_month >= 0),
  buyback_daily_limit_user    BIGINT NOT NULL CHECK (buyback_daily_limit_user >= 0),   -- units
  buyback_daily_limit_total   BIGINT NOT NULL CHECK (buyback_daily_limit_total >= 0),  -- units
  circuit_breaker_bps         INT NOT NULL CHECK (circuit_breaker_bps > 0),            -- daily move that pauses buyback
  reserve_floor_bps           INT NOT NULL CHECK (reserve_floor_bps BETWEEN 0 AND 10000),
  buyback_paused              BOOLEAN NOT NULL DEFAULT false,
  effective_from              TIMESTAMPTZ NOT NULL DEFAULT now(),
  set_by                      UUID NOT NULL REFERENCES users(id),
  CHECK (buyback_spread_bps >= user_spread_bps)
);
CREATE INDEX market_params_latest_idx ON market_params (class_id, effective_from DESC);

-- Public reserve and stock dashboard.
CREATE TABLE reserve_snapshots (
  id                      BIGSERIAL PRIMARY KEY,
  class_id                UUID NOT NULL REFERENCES commodity_classes(id),
  taken_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  units_outstanding       BIGINT NOT NULL,
  backed_grams            BIGINT NOT NULL,
  reserve_cash_kobo       BIGINT NOT NULL,
  reserve_tbills_kobo     BIGINT NOT NULL,
  desk_inventory_units    BIGINT NOT NULL            -- units Kitovu holds from buybacks
);

-- ------------------------------------------------------------------ distributors and customers

-- A distributor is a verified partner (partners table) with commercial and settlement terms.
CREATE TABLE distributors (
  partner_id             UUID PRIMARY KEY REFERENCES partners(id),
  revenue_share_bps      INT NOT NULL DEFAULT 0 CHECK (revenue_share_bps BETWEEN 0 AND 10000),
  prefund_kobo           BIGINT NOT NULL DEFAULT 0 CHECK (prefund_kobo >= 0),
  credit_limit_kobo      BIGINT NOT NULL DEFAULT 0 CHECK (credit_limit_kobo >= 0),
  settlement_cadence     TEXT NOT NULL DEFAULT 'daily' CHECK (settlement_cadence IN ('intraday','daily','weekly')),
  kyc_reliance_signed_at TIMESTAMPTZ,                 -- reliance agreement in force
  status                 TEXT NOT NULL DEFAULT 'sandbox' CHECK (status IN ('sandbox','live','suspended')),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Per-asset production enablement (PRD v3 §4.2 gate). The API contract exposes all five asset types
-- in the sandbox; production needs an enabled grant here.
CREATE TABLE distributor_asset_grants (
  distributor_id        UUID NOT NULL REFERENCES distributors(partner_id) ON DELETE CASCADE,
  asset_type            TEXT NOT NULL CHECK (asset_type IN ('commodity_unit','warehouse_receipt','lpo','carbon_credit','xown')),
  enabled               BOOLEAN NOT NULL DEFAULT false,
  tiers                 TEXT[] NOT NULL DEFAULT '{}' CHECK (tiers <@ ARRAY['retail','qualified','institutional']::TEXT[]),
  accepted_disclosures  TEXT[] NOT NULL DEFAULT '{}',
  enabled_by            UUID REFERENCES users(id),
  enabled_at            TIMESTAMPTZ,
  PRIMARY KEY (distributor_id, asset_type),
  CHECK (NOT enabled OR (enabled_by IS NOT NULL AND enabled_at IS NOT NULL AND cardinality(tiers) > 0))
);

-- One row per end customer, whether they came through a distributor or signed up directly.
-- The wallet is created for the customer at onboarding; a licensed custodian holds its keys.
CREATE TABLE customers (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel           TEXT NOT NULL CHECK (channel IN ('direct','distributor')),
  distributor_id    UUID REFERENCES distributors(partner_id),
  external_ref      TEXT,                                -- the distributor's own customer id
  user_id           UUID REFERENCES users(id),           -- direct customers sign in; distributed ones do not
  tier              TEXT NOT NULL DEFAULT 'retail' CHECK (tier IN ('retail','qualified','institutional')),
  kyc_status        TEXT NOT NULL DEFAULT 'pending' CHECK (kyc_status IN ('pending','verified','needs_info','rejected','frozen')),
  kyc_basis         TEXT NOT NULL DEFAULT 'tradechainx' CHECK (kyc_basis IN ('tradechainx','distributor_reliance')),
  wallet_address    TEXT UNIQUE,
  custodian_ref     TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (channel = 'direct' AND distributor_id IS NULL AND user_id IS NOT NULL) OR
    (channel = 'distributor' AND distributor_id IS NOT NULL AND external_ref IS NOT NULL)
  ),
  CHECK (kyc_basis <> 'distributor_reliance' OR channel = 'distributor')
);
CREATE UNIQUE INDEX customers_distributor_ref_idx ON customers (distributor_id, external_ref) WHERE distributor_id IS NOT NULL;
CREATE UNIQUE INDEX customers_direct_user_idx ON customers (user_id) WHERE channel = 'direct';

-- ------------------------------------------------------------------ quotes, orders, ledger

CREATE TABLE quotes (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id       UUID NOT NULL REFERENCES customers(id),
  class_id          UUID NOT NULL REFERENCES commodity_classes(id),
  side              TEXT NOT NULL CHECK (side IN ('buy','sell','buyback')),
  units             BIGINT NOT NULL CHECK (units > 0),
  kobo_per_kg       BIGINT NOT NULL CHECK (kobo_per_kg > 0),
  total_kobo        BIGINT NOT NULL CHECK (total_kobo >= 0),
  reference_price_id BIGINT NOT NULL REFERENCES reference_prices(id),
  expires_at        TIMESTAMPTZ NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (side <> 'buy' OR units >= 10000)                -- 10 kg minimum purchase
);

CREATE TABLE orders (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id          UUID NOT NULL UNIQUE REFERENCES quotes(id),
  customer_id       UUID NOT NULL REFERENCES customers(id),
  distributor_id    UUID REFERENCES distributors(partner_id),   -- NULL for direct customers
  idempotency_key   TEXT NOT NULL,
  side              TEXT NOT NULL CHECK (side IN ('buy','sell','buyback')),
  units             BIGINT NOT NULL CHECK (units > 0),
  total_kobo        BIGINT NOT NULL CHECK (total_kobo >= 0),
  status            TEXT NOT NULL DEFAULT 'accepted'
                    CHECK (status IN ('accepted','funds_confirmed','delivered','settled','failed','cancelled')),
  failure_reason    TEXT,
  chain_tx_hash     TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Retries with the same key return the same order instead of creating a second one.
CREATE UNIQUE INDEX orders_idem_distributor_idx ON orders (distributor_id, idempotency_key) WHERE distributor_id IS NOT NULL;
CREATE UNIQUE INDEX orders_idem_direct_idx ON orders (customer_id, idempotency_key) WHERE distributor_id IS NULL;
CREATE INDEX orders_status_idx ON orders (status, created_at);

-- Double-entry naira ledger. Every journal must net to zero; a constraint trigger enforces it, so a
-- bug in application code cannot create or lose money. Accounts are plain text:
--   customer:<uuid> · distributor_settlement:<uuid> · client_money · platform_revenue · distributor_revenue:<uuid> · reserve
CREATE TABLE ledger_entries (
  id          BIGSERIAL PRIMARY KEY,
  journal_id  UUID NOT NULL,
  account     TEXT NOT NULL,
  delta_kobo  BIGINT NOT NULL CHECK (delta_kobo <> 0),
  order_id    UUID REFERENCES orders(id),
  kind        TEXT NOT NULL CHECK (kind IN ('buy','sell','buyback','fee','revenue_share','settlement','processor_payout','adjustment')),
  memo        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ledger_entries_journal_idx ON ledger_entries (journal_id);
CREATE INDEX ledger_entries_account_idx ON ledger_entries (account, id);

CREATE FUNCTION assert_journal_balanced() RETURNS trigger AS $$
BEGIN
  IF (SELECT COALESCE(SUM(delta_kobo), 0) FROM ledger_entries WHERE journal_id = NEW.journal_id) <> 0 THEN
    RAISE EXCEPTION 'Unbalanced ledger journal %', NEW.journal_id USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER ledger_journal_balanced
  AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_journal_balanced();

-- Ledger rows are never edited or removed: corrections are new, balanced journals.
CREATE FUNCTION ledger_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ledger_entries is append-only' USING ERRCODE = '42501';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ledger_no_update BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_append_only();

-- ------------------------------------------------------------------ settlements and fees

CREATE TABLE settlements (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  distributor_id  UUID NOT NULL REFERENCES distributors(partner_id),
  window_start    TIMESTAMPTZ NOT NULL,
  window_end      TIMESTAMPTZ NOT NULL,
  net_kobo        BIGINT NOT NULL,                      -- + distributor owes, - TradeChainX owes
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','reported','confirmed','paid','disputed')),
  custodian_ref   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (window_end > window_start),
  UNIQUE (distributor_id, window_start, window_end)
);

CREATE TABLE holding_fee_charges (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id   UUID NOT NULL REFERENCES customers(id),
  class_id      UUID NOT NULL REFERENCES commodity_classes(id),
  period        BIGINT NOT NULL,                        -- block.timestamp / 30 days, as on-chain
  units         BIGINT NOT NULL CHECK (units > 0),
  chain_tx_hash TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (customer_id, class_id, period)                -- one charge per holder per period, as on-chain
);
