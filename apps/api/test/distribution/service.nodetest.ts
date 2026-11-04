// Distribution service rules, run with Node's built-in runner (no database, framework or chain needed):
//   pnpm --filter @tradechainx/api test:distribution
// File ends in .nodetest.ts so the app's vitest run does not pick it up.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { DistributionService, orderJournal, QUOTE_TTL_MS, PRICE_MAX_AGE_MS } from "../../src/distribution/service.ts";
import { MemoryRepo } from "../../src/distribution/testing/memoryRepo.ts";
import type { Custodian, Holdings, Order } from "../../src/distribution/model.ts";
import { assetModules } from "@tradechainx/shared";

const DIST = "dist-1";
const OTHER = "dist-2";
const CLASS = "class-soy";
const HOUR = 3_600_000;

let now = new Date("2026-11-04T10:00:00Z");
let repo: MemoryRepo;
let svc: DistributionService;
let held: Map<string, bigint>;
let walletSeq = 0;
let customerId: string;

const custodian: Custodian = {
  async provisionWallet(id) { walletSeq++; return { address: `0xwallet${walletSeq}`, custodianRef: `cust-${id}` }; },
};
const holdings: Holdings = { async unitsOf(w, c) { return held.get(`${w}:${c}`) ?? 0n; } };

const code = (c: string) => (e: unknown) => (e as { code?: string }).code === c || (assert.fail(`expected ${c}, got ${(e as { code?: string }).code}: ${(e as Error).message}`), false);

beforeEach(async () => {
  now = new Date("2026-11-04T10:00:00Z");
  repo = new MemoryRepo();
  held = new Map();
  repo.distributors.set(DIST, { partnerId: DIST, revenueShareBps: 3000, prefundKobo: 10_000_000n, creditLimitKobo: 5_000_000n, kycRelianceSignedAt: new Date("2026-10-01"), status: "live" });
  repo.distributors.set(OTHER, { partnerId: OTHER, revenueShareBps: 0, prefundKobo: 0n, creditLimitKobo: 0n, kycRelianceSignedAt: null, status: "live" });
  repo.grants.set(`${DIST}:commodity_unit`, { enabled: true, tiers: ["retail", "qualified", "institutional"], acceptedDisclosures: [...assetModules.commodity_unit.disclosures] });
  repo.classes.set(CLASS, { id: CLASS, displayName: "Soybean Grade 1", shrinkageBps: 200, active: true, halted: false });
  repo.addPrice(CLASS, 90_000n, new Date(now.getTime() - HOUR)); // ₦900/kg
  repo.params.set(CLASS, { userSpreadBps: 100, buybackSpreadBps: 400, buybackDailyLimitUser: 100_000n, buybackDailyLimitTotal: 1_000_000n, circuitBreakerBps: 1000, buybackPaused: false });
  svc = new DistributionService({ repo, custodian, holdings, clock: { now: () => now } });
  const { customer } = await svc.createCustomer(DIST, { externalRef: "cust-1", tier: "retail", kycVerified: true });
  customerId = customer.id;
});

const buyQuote = (units = 10_000n) => svc.createQuote(DIST, { customerId, classId: CLASS, side: "buy", units });
const give = (units: bigint) => held.set(`${repo.customers.get(customerId)!.walletAddress}:${CLASS}`, units);

// ------------------------------------------------------------------ customers

test("customer gets a custodian-held wallet; same reference returns the same customer", async () => {
  const c = repo.customers.get(customerId)!;
  assert.match(c.walletAddress!, /^0xwallet/);
  assert.equal(c.kycStatus, "verified");
  assert.equal(c.kycBasis, "distributor_reliance");
  const again = await svc.createCustomer(DIST, { externalRef: "cust-1", tier: "retail", kycVerified: true });
  assert.equal(again.created, false);
  assert.equal(again.customer.id, customerId);
  assert.equal(repo.customers.size, 1);
});

test("asserting KYC needs a signed reliance agreement; unverified customers stay pending", async () => {
  await assert.rejects(svc.createCustomer(OTHER, { externalRef: "x", tier: "retail", kycVerified: true }), code("kyc_reliance_not_signed"));
  const { customer } = await svc.createCustomer(OTHER, { externalRef: "y", tier: "retail", kycVerified: false });
  assert.equal(customer.kycStatus, "pending");
  assert.equal(customer.kycBasis, "tradechainx");
});

test("a distributor cannot see another distributor's customer", async () => {
  await assert.rejects(svc.getCustomer(OTHER, customerId), code("not_found"));
  await assert.rejects(svc.createQuote(OTHER, { customerId, classId: CLASS, side: "buy", units: 10_000n }), code("not_found"));
});

test("a suspended distributor is blocked", async () => {
  repo.distributors.set(DIST, { ...repo.distributors.get(DIST)!, status: "suspended" });
  await assert.rejects(buyQuote(), code("partner_suspended"));
});

// ------------------------------------------------------------------ quotes

test("buy quote: ₦909/kg, 10 kg = ₦9,090, expires in 30 seconds", async () => {
  const q = await buyQuote();
  assert.equal(q.koboPerKg, 90_900n);
  assert.equal(q.totalKobo, 909_000n);
  assert.equal(q.expiresAt.getTime() - now.getTime(), QUOTE_TTL_MS);
});

test("minimum purchase is 10 kg", async () => {
  await assert.rejects(buyQuote(9_999n), code("below_minimum"));
});

test("customer must be verified", async () => {
  repo.customers.set(customerId, { ...repo.customers.get(customerId)!, kycStatus: "pending" });
  await assert.rejects(buyQuote(), code("kyc_not_verified"));
});

test("halted or inactive classes cannot be traded", async () => {
  repo.classes.set(CLASS, { ...repo.classes.get(CLASS)!, halted: true });
  await assert.rejects(buyQuote(), code("class_halted"));
  repo.classes.set(CLASS, { ...repo.classes.get(CLASS)!, halted: false, active: false });
  await assert.rejects(buyQuote(), code("not_found"));
});

test("the asset must be enabled for the distributor, the tier allowed and disclosures accepted", async () => {
  repo.grants.delete(`${DIST}:commodity_unit`);
  await assert.rejects(buyQuote(), code("asset_not_enabled_for_distributor"));
  repo.grants.set(`${DIST}:commodity_unit`, { enabled: true, tiers: ["qualified"], acceptedDisclosures: [...assetModules.commodity_unit.disclosures] });
  await assert.rejects(buyQuote(), code("tier_not_in_distributor_grant"));
  repo.grants.set(`${DIST}:commodity_unit`, { enabled: true, tiers: ["retail"], acceptedDisclosures: ["price_risk"] });
  await assert.rejects(buyQuote(), code("disclosure_not_accepted"));
});

test("a stale reference price stops quoting", async () => {
  now = new Date(now.getTime() + PRICE_MAX_AGE_MS + 1000);
  await assert.rejects(buyQuote(), code("price_stale"));
});

test("no market parameters means the market is not open", async () => {
  repo.params.delete(CLASS);
  await assert.rejects(buyQuote(), code("market_not_open"));
});

test("selling needs the units: checked against the chain registry", async () => {
  await assert.rejects(svc.createQuote(DIST, { customerId, classId: CLASS, side: "sell", units: 10_000n }), code("insufficient_units"));
  give(10_000n);
  const q = await svc.createQuote(DIST, { customerId, classId: CLASS, side: "sell", units: 10_000n });
  assert.equal(q.koboPerKg, 89_100n); // ₦891/kg
  assert.equal(q.totalKobo, 891_000n);
});

// ------------------------------------------------------------------ instant buyback protections

test("instant buyback quotes the wider bid", async () => {
  give(10_000n);
  const q = await svc.createQuote(DIST, { customerId, classId: CLASS, side: "buyback", units: 10_000n });
  assert.equal(q.koboPerKg, 86_400n); // ₦864/kg
  assert.equal(q.totalKobo, 864_000n);
});

test("buyback pauses on the circuit breaker, a manual pause and daily limits", async () => {
  give(1_000_000n);
  const bb = (units = 10_000n) => svc.createQuote(DIST, { customerId, classId: CLASS, side: "buyback", units });

  // manual pause
  repo.params.set(CLASS, { ...repo.params.get(CLASS)!, buybackPaused: true });
  await assert.rejects(bb(), code("buyback_unavailable"));
  repo.params.set(CLASS, { ...repo.params.get(CLASS)!, buybackPaused: false });

  // price moved 12.5% against the price a day earlier (breaker is 10%)
  repo.addPrice(CLASS, 80_000n, new Date(now.getTime() - 25 * HOUR));
  await assert.rejects(bb(), code("buyback_unavailable"));
  // user-to-user selling is not affected by the breaker
  await svc.createQuote(DIST, { customerId, classId: CLASS, side: "sell", units: 10_000n });
  repo.prices.pop();

  // per-user daily limit (100_000 units)
  repo.buybackUsed.set(`${customerId}:${CLASS}`, 95_000n);
  await assert.rejects(bb(10_000n), code("daily_limit_reached"));
  await bb(5_000n);
  repo.buybackUsed.delete(`${customerId}:${CLASS}`);

  // total daily limit (1_000_000 units)
  repo.buybackUsed.set(`all:${CLASS}`, 995_000n);
  await assert.rejects(bb(10_000n), code("daily_limit_reached"));
});

// ------------------------------------------------------------------ orders

test("order creation is idempotent", async () => {
  const q = await buyQuote();
  const a = await svc.createOrder(DIST, { quoteId: q.id, idempotencyKey: "k1" });
  assert.equal(a.replayed, false);
  assert.equal(a.order.status, "accepted");
  assert.equal(a.order.totalKobo, 909_000n);
  const b = await svc.createOrder(DIST, { quoteId: q.id, idempotencyKey: "k1" });
  assert.equal(b.replayed, true);
  assert.equal(b.order.id, a.order.id);
  assert.equal(repo.orders.size, 1);
});

test("a key reused with another quote, or a second key on a used quote, is a conflict", async () => {
  const q1 = await buyQuote();
  const q2 = await buyQuote();
  await svc.createOrder(DIST, { quoteId: q1.id, idempotencyKey: "k1" });
  await assert.rejects(svc.createOrder(DIST, { quoteId: q2.id, idempotencyKey: "k1" }), code("idempotency_conflict"));
  await assert.rejects(svc.createOrder(DIST, { quoteId: q1.id, idempotencyKey: "k2" }), code("quote_already_used"));
});

test("an expired quote cannot become an order", async () => {
  const q = await buyQuote();
  now = new Date(now.getTime() + QUOTE_TTL_MS + 1);
  await assert.rejects(svc.createOrder(DIST, { quoteId: q.id, idempotencyKey: "k1" }), code("quote_expired"));
});

test("the class halting between quote and order blocks the order", async () => {
  const q = await buyQuote();
  repo.classes.set(CLASS, { ...repo.classes.get(CLASS)!, halted: true });
  await assert.rejects(svc.createOrder(DIST, { quoteId: q.id, idempotencyKey: "k1" }), code("class_halted"));
});

test("idempotency key must be present and short", async () => {
  const q = await buyQuote();
  await assert.rejects(svc.createOrder(DIST, { quoteId: q.id, idempotencyKey: "  " }), code("bad_request"));
  await assert.rejects(svc.createOrder(DIST, { quoteId: q.id, idempotencyKey: "x".repeat(129) }), code("bad_request"));
});

test("cancel works only before money moves; funds confirmation is for buys only", async () => {
  const q = await buyQuote();
  const { order } = await svc.createOrder(DIST, { quoteId: q.id, idempotencyKey: "k1" });
  const confirmed = await svc.confirmFunds(DIST, order.id);
  assert.equal(confirmed.status, "funds_confirmed");
  await assert.rejects(svc.cancelOrder(DIST, order.id), code("invalid_state"));

  give(10_000n);
  const sq = await svc.createQuote(DIST, { customerId, classId: CLASS, side: "sell", units: 10_000n });
  const sell = (await svc.createOrder(DIST, { quoteId: sq.id, idempotencyKey: "k2" })).order;
  await assert.rejects(svc.confirmFunds(DIST, sell.id), code("invalid_state"));
  assert.equal((await svc.cancelOrder(DIST, sell.id)).status, "cancelled");
  assert.equal((await svc.cancelOrder(DIST, sell.id)).status, "cancelled"); // repeat is harmless
});

test("a distributor cannot touch another distributor's order", async () => {
  const q = await buyQuote();
  const { order } = await svc.createOrder(DIST, { quoteId: q.id, idempotencyKey: "k1" });
  await assert.rejects(svc.getOrder(OTHER, order.id), code("not_found"));
  await assert.rejects(svc.cancelOrder(OTHER, order.id), code("not_found"));
});

// ------------------------------------------------------------------ ledger

const sum = (lines: { deltaKobo: bigint }[]) => lines.reduce((s, l) => s + l.deltaKobo, 0n);
const by = (lines: { account: string; deltaKobo: bigint }[], prefix: string) => lines.find((l) => l.account.startsWith(prefix))?.deltaKobo;

test("buy: delivery posts a balanced journal; the spread is shared 30/70", async () => {
  const q = await buyQuote();
  const { order } = await svc.createOrder(DIST, { quoteId: q.id, idempotencyKey: "k1" });
  await assert.rejects(svc.markDelivered(order.id, "0xtx"), code("invalid_state")); // funds not confirmed yet
  await svc.confirmFunds(DIST, order.id);
  const delivered = await svc.markDelivered(order.id, "0xtx");
  assert.equal(delivered.status, "delivered");
  assert.equal(delivered.chainTxHash, "0xtx");

  assert.equal(repo.journals.length, 1);
  const lines = repo.journals[0]!.lines;
  assert.equal(sum(lines), 0n);
  assert.equal(by(lines, "distributor_settlement:"), 909_000n);  // distributor owes the total
  assert.equal(by(lines, "unit_sales:"), -900_000n);             // 10 kg at the ₦900 reference
  assert.equal(by(lines, "platform_revenue"), -6_300n);          // 70% of the ₦90 spread
  assert.equal(by(lines, "distributor_revenue:"), -2_700n);      // 30%
  assert.equal((await svc.markDelivered(order.id, "0xtx")).status, "delivered");
  assert.equal(repo.journals.length, 1, "delivering twice must not post twice");
});

test("sell: we owe the distributor the bid; buyback: the wider spread is all ours", async () => {
  give(20_000n);
  const sq = await svc.createQuote(DIST, { customerId, classId: CLASS, side: "sell", units: 10_000n });
  const sell = (await svc.createOrder(DIST, { quoteId: sq.id, idempotencyKey: "s1" })).order;
  await svc.markDelivered(sell.id, "0xs");
  const sl = repo.journals[0]!.lines;
  assert.equal(sum(sl), 0n);
  assert.equal(by(sl, "distributor_settlement:"), -891_000n);
  assert.equal(by(sl, "unit_sales:"), 900_000n);
  assert.equal(by(sl, "platform_revenue"), -6_300n);
  assert.equal(by(sl, "distributor_revenue:"), -2_700n);

  const bq = await svc.createQuote(DIST, { customerId, classId: CLASS, side: "buyback", units: 10_000n });
  const bb = (await svc.createOrder(DIST, { quoteId: bq.id, idempotencyKey: "b1" })).order;
  await svc.markDelivered(bb.id, "0xb");
  const bl = repo.journals[1]!.lines;
  assert.equal(sum(bl), 0n);
  assert.equal(by(bl, "distributor_settlement:"), -864_000n);
  assert.equal(by(bl, "platform_revenue"), -36_000n);
  assert.equal(by(bl, "distributor_revenue:"), undefined);
});

test("journals balance for every side, size, price and share (sweep)", () => {
  const base = { id: "o", quoteId: "q", customerId: "c", idempotencyKey: "k", status: "accepted", failureReason: null, chainTxHash: null, createdAt: new Date() } as const;
  for (const side of ["buy", "sell", "buyback"] as const) {
    for (const units of [1n, 7n, 999n, 10_000n, 12_345n, 987_654n]) {
      for (const ref of [1n, 333n, 90_000n, 123_457n]) {
        for (const share of [0, 1, 3000, 10_000]) {
          // build a total the way the pricing code would: ±1% for user trades, −4% for buyback
          const adj = side === "buy" ? ref + (ref + 99n) / 100n : side === "sell" ? ref - (ref + 99n) / 100n : ref - (ref * 4n + 99n) / 100n;
          const total = side === "buy" ? (units * adj + 999n) / 1000n : (units * adj) / 1000n;
          const o: Order = { ...base, distributorId: "d", side, units, totalKobo: total };
          assert.equal(sum(orderJournal(o, "c", ref, share)), 0n);
        }
      }
    }
  }
});

// ------------------------------------------------------------------ prefund and settlement

test("delivered but unsettled buys count against the prefund headroom", async () => {
  repo.distributors.set(DIST, { ...repo.distributors.get(DIST)!, prefundKobo: 1_000_000n, creditLimitKobo: 0n });
  const q1 = await buyQuote();
  const o1 = (await svc.createOrder(DIST, { quoteId: q1.id, idempotencyKey: "a" })).order;
  await svc.confirmFunds(DIST, o1.id);
  await svc.markDelivered(o1.id, "0x1");
  assert.equal(await repo.unsettledExposureKobo(DIST), 909_000n);

  const q2 = await buyQuote();
  await assert.rejects(svc.createOrder(DIST, { quoteId: q2.id, idempotencyKey: "b" }), code("prefund_insufficient"));
  // sells reduce exposure and are never blocked by the prefund gate
  give(10_000n);
  const sq = await svc.createQuote(DIST, { customerId, classId: CLASS, side: "sell", units: 10_000n });
  await svc.createOrder(DIST, { quoteId: sq.id, idempotencyKey: "c" });
});

test("settlement nets buys against sells, stays in exposure until paid, then clears", async () => {
  give(10_000n);
  const bq = await buyQuote();
  const buy = (await svc.createOrder(DIST, { quoteId: bq.id, idempotencyKey: "a" })).order;
  await svc.confirmFunds(DIST, buy.id);
  await svc.markDelivered(buy.id, "0x1");
  const sq = await svc.createQuote(DIST, { customerId, classId: CLASS, side: "sell", units: 10_000n });
  const sell = (await svc.createOrder(DIST, { quoteId: sq.id, idempotencyKey: "b" })).order;
  await svc.markDelivered(sell.id, "0x2");

  const s = await svc.createSettlement(DIST, new Date(now.getTime() - 24 * HOUR), new Date(now.getTime() + HOUR));
  assert.equal(s.netKobo, 18_000n); // 909,000 owed in, 891,000 owed out
  assert.equal(repo.orders.get(buy.id)!.status, "settled");
  assert.equal(repo.orders.get(sell.id)!.status, "settled");
  assert.equal(await repo.unsettledExposureKobo(DIST), 18_000n, "still counts until the cash has moved");

  const before = repo.journals.length;
  const paid = await svc.markSettlementPaid(s.id, "NIP-12345");
  assert.equal(paid.status, "paid");
  assert.equal(paid.custodianRef, "NIP-12345");
  const j = repo.journals[before]!.lines;
  assert.equal(sum(j), 0n);
  assert.equal(by(j, "client_money"), 18_000n);
  assert.equal(await repo.unsettledExposureKobo(DIST), 0n);

  assert.equal((await svc.markSettlementPaid(s.id, "NIP-12345")).status, "paid");
  assert.equal(repo.journals.length, before + 1, "paying twice must not post twice");
});

test("a net payable to the distributor posts the opposite direction", async () => {
  give(10_000n);
  const sq = await svc.createQuote(DIST, { customerId, classId: CLASS, side: "sell", units: 10_000n });
  const sell = (await svc.createOrder(DIST, { quoteId: sq.id, idempotencyKey: "b" })).order;
  await svc.markDelivered(sell.id, "0x2");
  const s = await svc.createSettlement(DIST, new Date(now.getTime() - HOUR), new Date(now.getTime() + HOUR));
  assert.equal(s.netKobo, -891_000n);
  await svc.markSettlementPaid(s.id, "NIP-9");
  assert.equal(by(repo.journals.at(-1)!.lines, "client_money"), -891_000n);
});

test("an empty settlement window is allowed and nets to zero; bad windows are rejected", async () => {
  const s = await svc.createSettlement(DIST, new Date(now.getTime() - HOUR), new Date(now.getTime() + HOUR));
  assert.equal(s.netKobo, 0n);
  const before = repo.journals.length;
  await svc.markSettlementPaid(s.id, "ref");
  assert.equal(repo.journals.length, before, "nothing to post for a zero net");
  await assert.rejects(svc.createSettlement(DIST, now, now), code("bad_request"));
});

test("failing an order only works before delivery", async () => {
  const q = await buyQuote();
  const { order } = await svc.createOrder(DIST, { quoteId: q.id, idempotencyKey: "k" });
  assert.equal((await svc.failOrder(order.id, "wallet debit failed")).failureReason, "wallet debit failed");
  await assert.rejects(svc.failOrder(order.id, "again"), code("invalid_state"));
});

// ------------------------------------------------------------------ catalogue

test("market listing shows live quotes and tradability; stale prices show none", async () => {
  const [m] = await svc.listMarket();
  assert.equal(m!.referenceKoboPerKg, 90_000n);
  assert.deepEqual(m!.quotesKoboPerKg, { buy: 90_900n, sell: 89_100n, buyback: 86_400n });
  assert.equal(m!.tradable, true);

  now = new Date(now.getTime() + PRICE_MAX_AGE_MS + 1000);
  const [stale] = await svc.listMarket();
  assert.equal(stale!.quotesKoboPerKg, null);
  assert.equal(stale!.tradable, false);
});
