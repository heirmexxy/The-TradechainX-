# Distribution API v1 — design

Status: **design and data model only.** The routes, settlement service and custodian integration are not
built yet (see [Status](#status)). This document is the contract the build must meet.
Product context: [PRD v3](PRD_v3.md) §5, §8 · Schema: [`apps/api/migrations/0005_distribution.sql`](../apps/api/migrations/0005_distribution.sql)
Shared rules: [`packages/shared/src/domain`](../packages/shared/src/domain) (`commodity.ts`, `assetModules.ts`, `naira.ts`)

This is separate from the existing [Partner API](PARTNER_API.md), which is for verified issuers and
partners that sign their own on-chain calls in USDC. The Distribution API is for fintechs that never
touch a chain: they send naira-denominated orders for their own customers.

## Principles

- Money is **naira in kobo** (`"total_kobo": "909000"`), quantities are **units = grams** as integer strings.
  No floating point anywhere.
- Fintechs own the customer, the wallet and KYC. TradeChainX owns assets, pricing, the registry, matching,
  reserves, settlement reconciliation and reporting.
- Every write takes an `Idempotency-Key`. A retry returns the original result.
- The same five asset types are visible in the sandbox from day one. Production use of each is enabled per
  distributor (`distributor_asset_grants`) after contracts are audited and disclosures are accepted.

## Auth, limits, errors

Same key model as the Partner API: `Authorization: Bearer tcx_live_<prefix>_<secret>`, scoped keys,
per-minute rate limit and daily quota, server-to-server only. Scopes: `read`, `customers`, `trade`.
Errors are `{ "error": "<code>", "message": "..." }`. Extra codes: `quote_expired`, `class_halted`,
`buyback_unavailable`, `daily_limit_reached`, `prefund_insufficient`, `kyc_not_verified`,
`asset_not_enabled_for_distributor`, `tier_not_eligible_by_default`, `disclosure_not_accepted:<id>`.

## Endpoints

| Group | Endpoint | Notes |
|---|---|---|
| Catalogue | `GET /asset-types` | The five modules: trading mode, price source, exits, disclosures |
| | `GET /classes`, `/classes/{id}` | Commodity classes with live reference price, bid/ask, status |
| | `GET /classes/{id}/proof` | Lots, weights, grades, sensor readings, reserve and audit status (also public on the site) |
| | `GET /offerings`, `/listings` | Primary offerings and resale listings for the other asset types |
| Customers | `POST /customers` | Create the customer with the distributor's reference and a KYC reference; provisions the custodian-held wallet |
| | `GET /customers/{id}`, `PATCH /customers/{id}/limits` | |
| Trading | `POST /quotes` | `{customer, class, side, units}` → price, total, expiry |
| | `POST /orders` | `{quote_id}` + `Idempotency-Key`. Buy, sell or buyback |
| | `GET /orders/{id}`, `DELETE /orders/{id}` | Cancel only before funds are confirmed |
| Other assets | `POST /subscriptions`, `POST /purchases`, `POST /retirements`, `POST /settle-lpo`, `GET /distributions` | XOwn / LPO primary, listing purchase, carbon retirement, LPO settlement, XOwn earnings |
| Holdings | `GET /holdings`, `/statements`, `/pledges` | |
| Money | `GET /settlements`, `/revenue-share` | Net position per window; revenue-share statement |
| Webhooks | `order.filled`, `settlement.completed`, `kyc.status`, `holding_fee.charged`, `class.price_updated`, `class.paused`, `retirement.paid`, `distribution.paid`, `listing.approved` | Signed, retried (existing dispatcher) |

## Order flow (buy)

```
1. POST /quotes                   price from the latest reference price + spread, valid ~30 s
2. POST /orders                   checks: customer verified, tier + grant + disclosures, class not halted,
                                  10 kg minimum, distributor prefund headroom
3. distributor debits the customer's wallet and confirms funds   → order: funds_confirmed
4. units credited to the customer's wallet on-chain              → order: delivered   (webhook order.filled)
5. net settlement per distributor per window into the client-money account → order: settled
```

Selling mirrors it. Instant buyback is only offered when the circuit breaker is clear and the user and
total daily limits are not reached; otherwise the response says so and the customer can sell to the order book.

## Settlement controls

Because cash and units do not settle atomically, units are delivered before cash arrives. Controls:
distributor prefund plus credit limit (`checkPrefund`), hold-and-release on units bought on credit,
intraday reconciliation (fintech ledger ↔ custodian account ↔ registry), and a signed daily close.
Every naira movement is a balanced journal in `ledger_entries` (append-only; the database refuses
unbalanced journals).

## Status

| Piece | State |
|---|---|
| Rules: unit math, quotes, fees, revenue share, net settlement, prefund, eligibility | **Built and tested** (`packages/shared`, 24 tests) |
| Data model: classes, lots, prices, market parameters, distributors, grants, customers, quotes, orders, ledger, settlements, fees | **Built, applied to Postgres 16 and constraint-tested** (29 checks) |
| `CommodityUnits` contract | **Built and tested** (58 tests); not yet audited |
| API routes and auth for the endpoints above | Not built |
| Indexer handlers for the new contract's events | Not built |
| Reference price service and committee approval flow | Not built |
| Market-making desk, reserve, buyback limits, circuit breaker | Not built |
| Naira settlement service and reconciliation | Not built |
| Custodian-held wallet provisioning | Not built (needs the custodian partner) |
| Naira ramp for direct users | Not built (needs a Nigerian ramp partner) |
| SDK additions and white-label screens | Not built |
| Admin console screens (classes, lots, prices, sales, distributors) | Not built |
