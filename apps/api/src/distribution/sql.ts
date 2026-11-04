// Every SQL statement the Distribution API runs, in one place so each can be checked against the real schema
// (test/distribution/sql-prepare.sh PREPAREs them all on Postgres). Money is BIGINT kobo; pg returns it as a string.
const CUSTOMER = "id, distributor_id, external_ref, tier, kyc_status, kyc_basis, wallet_address";
const QUOTE = "id, customer_id, class_id, side, units, kobo_per_kg, total_kobo, reference_price_id, expires_at, created_at";
const ORDER = "id, quote_id, customer_id, distributor_id, idempotency_key, side, units, total_kobo, status, failure_reason, chain_tx_hash, created_at";
const PRICE = "id, class_id, price_kobo_per_kg, published_at";
const SETTLEMENT = "id, distributor_id, window_start, window_end, net_kobo, status, custodian_ref";

export const SQL = {
  distributor: "SELECT partner_id, revenue_share_bps, prefund_kobo, credit_limit_kobo, kyc_reliance_signed_at, status FROM distributors WHERE partner_id = $1",
  grant: "SELECT enabled, tiers, accepted_disclosures FROM distributor_asset_grants WHERE distributor_id = $1 AND asset_type = $2",

  classes: "SELECT id, display_name, shrinkage_bps, active, halted FROM commodity_classes ORDER BY display_name",
  classById: "SELECT id, display_name, shrinkage_bps, active, halted FROM commodity_classes WHERE id = $1",
  priceById: `SELECT ${PRICE} FROM reference_prices WHERE id = $1`,
  priceLatest: `SELECT ${PRICE} FROM reference_prices WHERE class_id = $1 ORDER BY published_at DESC, id DESC LIMIT 1`,
  priceAtOrBefore: `SELECT ${PRICE} FROM reference_prices WHERE class_id = $1 AND published_at <= $2 ORDER BY published_at DESC, id DESC LIMIT 1`,
  marketParams:
    "SELECT user_spread_bps, buyback_spread_bps, buyback_daily_limit_user, buyback_daily_limit_total, circuit_breaker_bps, buyback_paused " +
    "FROM market_params WHERE class_id = $1 AND effective_from <= now() ORDER BY effective_from DESC, id DESC LIMIT 1",

  customerById: `SELECT ${CUSTOMER} FROM customers WHERE id = $1`,
  customerByRef: `SELECT ${CUSTOMER} FROM customers WHERE distributor_id = $1 AND external_ref = $2`,
  customerInsert:
    "INSERT INTO customers (channel, distributor_id, external_ref, tier, kyc_status, kyc_basis) VALUES ('distributor', $1, $2, $3, $4, $5) " +
    `RETURNING ${CUSTOMER}`,
  customerWallet: "UPDATE customers SET wallet_address = $2, custodian_ref = $3 WHERE id = $1",

  quoteInsert:
    "INSERT INTO quotes (customer_id, class_id, side, units, kobo_per_kg, total_kobo, reference_price_id, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) " +
    `RETURNING ${QUOTE}`,
  quoteById: `SELECT ${QUOTE} FROM quotes WHERE id = $1`,

  orderByKeyDistributor: `SELECT ${ORDER} FROM orders WHERE distributor_id = $1 AND idempotency_key = $2`,
  orderByKeyDirect: `SELECT ${ORDER} FROM orders WHERE distributor_id IS NULL AND customer_id = $1 AND idempotency_key = $2`,
  orderByQuote: `SELECT ${ORDER} FROM orders WHERE quote_id = $1`,
  orderInsert:
    "INSERT INTO orders (quote_id, customer_id, distributor_id, idempotency_key, side, units, total_kobo) VALUES ($1, $2, $3, $4, $5, $6, $7) " +
    `RETURNING ${ORDER}`,
  orderById: `SELECT ${ORDER} FROM orders WHERE id = $1`,
  orderUpdate:
    "UPDATE orders SET status = COALESCE($2, status), failure_reason = COALESCE($3, failure_reason), chain_tx_hash = COALESCE($4, chain_tx_hash), updated_at = now() " +
    `WHERE id = $1 RETURNING ${ORDER}`,
  ordersDeliveredUnsettled: `SELECT ${ORDER} FROM orders WHERE distributor_id = $1 AND status = 'delivered' AND created_at <= $2 ORDER BY created_at, id FOR UPDATE`,
  ordersMarkSettled: "UPDATE orders SET status = 'settled', updated_at = now() WHERE id = ANY($1::uuid[])",

  // delivered, not-yet-in-a-settlement orders (buys positive) + net of settlements not yet paid
  exposure:
    "SELECT COALESCE((SELECT SUM(CASE WHEN side = 'buy' THEN total_kobo ELSE -total_kobo END) FROM orders WHERE distributor_id = $1 AND status = 'delivered'), 0) " +
    "+ COALESCE((SELECT SUM(net_kobo) FROM settlements WHERE distributor_id = $1 AND status <> 'paid'), 0) AS exposure",
  // $1 class, $2 start of the UTC day, $3 customer (NULL = everyone)
  buybackToday:
    "SELECT COALESCE(SUM(o.units), 0) AS units FROM orders o JOIN quotes q ON q.id = o.quote_id " +
    "WHERE o.side = 'buyback' AND q.class_id = $1 AND o.created_at >= $2 " +
    "AND o.status IN ('accepted', 'funds_confirmed', 'delivered', 'settled') AND ($3::uuid IS NULL OR o.customer_id = $3::uuid)",

  journalInsert:
    "INSERT INTO ledger_entries (journal_id, account, delta_kobo, order_id, kind, memo) " +
    "SELECT $1::uuid, t.account, t.delta, $2::uuid, t.kind, t.memo FROM unnest($3::text[], $4::bigint[], $5::text[], $6::text[]) AS t(account, delta, kind, memo)",

  settlementInsert:
    "INSERT INTO settlements (distributor_id, window_start, window_end, net_kobo) VALUES ($1, $2, $3, $4) " +
    `RETURNING ${SETTLEMENT}`,
  settlementById: `SELECT ${SETTLEMENT} FROM settlements WHERE id = $1 FOR UPDATE`,
  settlementUpdate:
    "UPDATE settlements SET status = COALESCE($2, status), custodian_ref = COALESCE($3, custodian_ref) " +
    `WHERE id = $1 RETURNING ${SETTLEMENT}`,
} as const;
