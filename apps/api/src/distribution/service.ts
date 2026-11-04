// Distribution API business rules. See docs/DISTRIBUTION_API.md and PRD v3 §5, §7, §8.
// Pure orchestration over the ports in model.ts: no framework, database or chain imports.
import { randomUUID } from "node:crypto";
import {
  checkPrefund, eligibilityBlock, netSettlement, quoteOrder, revenueShare, UNITS_PER_KG, BPS,
  type CustomerTier, type PriceBook, type Side,
} from "@tradechainx/shared";
import { HttpError } from "../lib/errors.ts";
import type {
  Clock, CommodityClass, Custodian, Customer, Distributor, Holdings, LedgerLine, MarketParams, Order, Quote,
  ReferencePrice, Repo, Settlement,
} from "./model.ts";

export const QUOTE_TTL_MS = 30_000;
/** A reference price older than this is treated as missing: no quotes until the price service publishes. */
export const PRICE_MAX_AGE_MS = 36 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const fail = (status: number, code: string, message: string) => new HttpError(status, code, message);

export interface Deps {
  repo: Repo;
  custodian: Custodian;
  holdings: Holdings;
  clock: Clock;
}

export class DistributionService {
  constructor(private d: Deps) {}

  // ------------------------------------------------------------------ catalogue

  async listMarket() {
    const { repo, clock } = this.d;
    const out = [];
    for (const c of await repo.listClasses()) {
      const price = await repo.latestReferencePrice(c.id);
      const params = await repo.latestMarketParams(c.id);
      const fresh = price && clock.now().getTime() - price.publishedAt.getTime() <= PRICE_MAX_AGE_MS;
      let quotes: { buy: bigint; sell: bigint; buyback: bigint } | null = null;
      if (fresh && params) {
        const book = bookOf(price, params);
        quotes = {
          buy: quoteOrder(book, "buy", 10_000n).koboPerKg,
          sell: quoteOrder(book, "sell", 10_000n).koboPerKg,
          buyback: quoteOrder(book, "buyback", 10_000n).koboPerKg,
        };
      }
      out.push({ class: c, referenceKoboPerKg: price?.priceKoboPerKg ?? null, publishedAt: price?.publishedAt ?? null, tradable: !!quotes && c.active && !c.halted, quotesKoboPerKg: quotes });
    }
    return out;
  }

  // ------------------------------------------------------------------ customers

  /** Creates (or returns, if the distributor's reference was already used) a customer with a wallet. */
  async createCustomer(
    distributorId: string,
    input: { externalRef: string; tier: CustomerTier; kycVerified: boolean },
  ): Promise<{ customer: Customer; created: boolean }> {
    const { repo, custodian } = this.d;
    const dist = await this.liveDistributor(distributorId);
    if (!input.externalRef.trim()) throw fail(400, "bad_request", "externalRef is required.");
    if (input.kycVerified && !dist.kycRelianceSignedAt) {
      throw fail(409, "kyc_reliance_not_signed", "Asserting KYC for your customers needs a signed reliance agreement.");
    }
    const existing = await repo.findDistributorCustomer(distributorId, input.externalRef);
    if (existing) return { customer: existing, created: false };

    const customer = await repo.insertCustomer({
      distributorId,
      externalRef: input.externalRef,
      tier: input.tier,
      kycStatus: input.kycVerified ? "verified" : "pending",
      kycBasis: input.kycVerified ? "distributor_reliance" : "tradechainx",
      walletAddress: null,
    });
    const w = await custodian.provisionWallet(customer.id);
    await repo.setCustomerWallet(customer.id, w.address, w.custodianRef);
    return { customer: { ...customer, walletAddress: w.address }, created: true };
  }

  async getCustomer(distributorId: string, customerId: string): Promise<Customer> {
    return this.ownCustomer(distributorId, customerId);
  }

  // ------------------------------------------------------------------ quotes

  async createQuote(
    distributorId: string,
    input: { customerId: string; classId: string; side: Side; units: bigint },
  ): Promise<Quote> {
    const { repo, clock } = this.d;
    await this.liveDistributor(distributorId);
    const customer = await this.ownCustomer(distributorId, input.customerId);
    const { cls, price, params } = await this.assertTradable(distributorId, customer, input.classId, input.side, input.units);

    let quote;
    try {
      quote = quoteOrder(bookOf(price, params), input.side, input.units);
    } catch (e) {
      throw fail(400, "below_minimum", e instanceof Error ? e.message : "Invalid order size.");
    }
    return repo.insertQuote({
      customerId: customer.id,
      classId: cls.id,
      side: input.side,
      units: input.units,
      koboPerKg: quote.koboPerKg,
      totalKobo: quote.totalKobo,
      referencePriceId: price.id,
      expiresAt: new Date(clock.now().getTime() + QUOTE_TTL_MS),
    });
  }

  // ------------------------------------------------------------------ orders

  /** Idempotent: the same key and quote returns the original order; the same key with another quote is a conflict. */
  async createOrder(
    distributorId: string,
    input: { quoteId: string; idempotencyKey: string },
  ): Promise<{ order: Order; replayed: boolean }> {
    const { repo, clock } = this.d;
    const key = input.idempotencyKey.trim();
    if (!key || key.length > 128) throw fail(400, "bad_request", "Idempotency-Key must be 1–128 characters.");
    const dist = await this.liveDistributor(distributorId);
    const quote = await repo.getQuote(input.quoteId);
    if (!quote) throw fail(404, "not_found", "Quote not found.");
    const customer = await this.ownCustomer(distributorId, quote.customerId);

    return repo.tx(async (r) => {
      const prior = await r.findOrderByIdempotency(distributorId, customer.id, key);
      if (prior) {
        if (prior.quoteId !== quote.id) throw fail(409, "idempotency_conflict", "This Idempotency-Key was used with a different quote.");
        return { order: prior, replayed: true };
      }
      if (await r.findOrderByQuote(quote.id)) throw fail(409, "quote_already_used", "This quote already has an order.");
      if (clock.now().getTime() > quote.expiresAt.getTime()) throw fail(409, "quote_expired", "This quote has expired. Request a new one.");

      await this.assertTradable(distributorId, customer, quote.classId, quote.side, quote.units, r);

      if (quote.side === "buy") {
        const exposure = await r.unsettledExposureKobo(distributorId);
        const gate = checkPrefund({ prefundKobo: dist.prefundKobo, creditLimitKobo: dist.creditLimitKobo, unsettledExposureKobo: exposure, orderKobo: quote.totalKobo });
        if (!gate.allowed) throw fail(409, "prefund_insufficient", "Your settlement prefund and credit limit do not cover this order. Top up and retry.");
      }
      const order = await r.insertOrder({
        quoteId: quote.id,
        customerId: customer.id,
        distributorId,
        idempotencyKey: key,
        side: quote.side,
        units: quote.units,
        totalKobo: quote.totalKobo,
      });
      return { order, replayed: false };
    });
  }

  async getOrder(distributorId: string, orderId: string): Promise<Order> {
    return this.ownOrder(distributorId, orderId);
  }

  /** The distributor has debited the customer's wallet. Buys only. */
  async confirmFunds(distributorId: string, orderId: string): Promise<Order> {
    const o = await this.ownOrder(distributorId, orderId);
    if (o.side !== "buy") throw fail(409, "invalid_state", "Only buy orders wait for customer funds.");
    if (o.status === "funds_confirmed") return o;
    if (o.status !== "accepted") throw fail(409, "invalid_state", `Order is ${o.status}.`);
    return this.d.repo.updateOrder(o.id, { status: "funds_confirmed" });
  }

  async cancelOrder(distributorId: string, orderId: string): Promise<Order> {
    const o = await this.ownOrder(distributorId, orderId);
    if (o.status === "cancelled") return o;
    if (o.status !== "accepted") throw fail(409, "invalid_state", "Only orders that have not moved money can be cancelled.");
    return this.d.repo.updateOrder(o.id, { status: "cancelled" });
  }

  /**
   * Called by the chain worker once units have moved on the registry. Posts the order's balanced ledger
   * journal. Buys must have funds confirmed first; sells and buybacks deliver from `accepted`.
   */
  async markDelivered(orderId: string, chainTxHash: string): Promise<Order> {
    return this.d.repo.tx(async (r) => {
      const o = await r.getOrder(orderId);
      if (!o) throw fail(404, "not_found", "Order not found.");
      if (o.status === "delivered" || o.status === "settled") return o;
      const ready = o.side === "buy" ? o.status === "funds_confirmed" : o.status === "accepted";
      if (!ready) throw fail(409, "invalid_state", `Order is ${o.status}; cannot deliver.`);

      const quote = await r.getQuote(o.quoteId);
      const ref = quote ? await r.getReferencePrice(quote.referencePriceId) : null;
      if (!quote || !ref) throw fail(500, "internal", "Order is missing its quote or reference price.");
      const dist = o.distributorId ? await r.getDistributor(o.distributorId) : null;

      await r.postJournal(randomUUID(), o.id, orderJournal(o, quote.classId, ref.priceKoboPerKg, dist?.revenueShareBps ?? 0));
      return r.updateOrder(o.id, { status: "delivered", chainTxHash });
    });
  }

  async failOrder(orderId: string, reason: string): Promise<Order> {
    const o = await this.d.repo.getOrder(orderId);
    if (!o) throw fail(404, "not_found", "Order not found.");
    if (o.status !== "accepted" && o.status !== "funds_confirmed") throw fail(409, "invalid_state", `Order is ${o.status}.`);
    return this.d.repo.updateOrder(o.id, { status: "failed", failureReason: reason });
  }

  // ------------------------------------------------------------------ settlement

  /** Closes the window: the delivered orders in it become one net position, and are no longer "unsettled". */
  async createSettlement(distributorId: string, windowStart: Date, windowEnd: Date): Promise<Settlement> {
    if (windowEnd <= windowStart) throw fail(400, "bad_request", "windowEnd must be after windowStart.");
    return this.d.repo.tx(async (r) => {
      const orders = await r.deliveredUnsettledOrders(distributorId, windowEnd);
      const net = netSettlement(orders.map((o) => ({ distributorId, side: o.side, totalKobo: o.totalKobo }))).get(distributorId) ?? 0n;
      const s = await r.insertSettlement({ distributorId, windowStart, windowEnd, netKobo: net });
      await r.markOrdersSettled(orders.map((o) => o.id));
      return s;
    });
  }

  /** The custodian confirms the net cash moved. Positive net: distributor paid in; negative: we paid out. */
  async markSettlementPaid(settlementId: string, custodianRef: string): Promise<Settlement> {
    return this.d.repo.tx(async (r) => {
      const s = await r.getSettlement(settlementId);
      if (!s) throw fail(404, "not_found", "Settlement not found.");
      if (s.status === "paid") return s;
      if (!custodianRef.trim()) throw fail(400, "bad_request", "custodianRef is required.");
      if (s.netKobo !== 0n) {
        await r.postJournal(randomUUID(), null, [
          { account: "client_money", deltaKobo: s.netKobo, kind: "settlement", memo: custodianRef },
          { account: `distributor_settlement:${s.distributorId}`, deltaKobo: -s.netKobo, kind: "settlement", memo: custodianRef },
        ]);
      }
      return r.updateSettlement(s.id, { status: "paid", custodianRef });
    });
  }

  // ------------------------------------------------------------------ shared checks

  private async liveDistributor(id: string): Promise<Distributor> {
    const d = await this.d.repo.getDistributor(id);
    if (!d) throw fail(403, "not_a_distributor", "This partner is not set up as a distributor.");
    if (d.status === "suspended") throw fail(403, "partner_suspended", "This distributor is suspended. Contact TradeChainX.");
    return d;
  }

  private async ownCustomer(distributorId: string, customerId: string): Promise<Customer> {
    const c = await this.d.repo.getCustomer(customerId);
    if (!c || c.distributorId !== distributorId) throw fail(404, "not_found", "Customer not found.");
    return c;
  }

  private async ownOrder(distributorId: string, orderId: string): Promise<Order> {
    const o = await this.d.repo.getOrder(orderId);
    if (!o || o.distributorId !== distributorId) throw fail(404, "not_found", "Order not found.");
    return o;
  }

  /** Every rule that decides whether this customer may trade this class on this side right now. */
  private async assertTradable(
    distributorId: string,
    customer: Customer,
    classId: string,
    side: Side,
    units: bigint,
    repo: Repo = this.d.repo,
  ): Promise<{ cls: CommodityClass; price: ReferencePrice; params: MarketParams }> {
    const now = this.d.clock.now();
    if (units <= 0n) throw fail(400, "bad_request", "units must be positive.");
    if (customer.kycStatus !== "verified") throw fail(403, "kyc_not_verified", "This customer is not verified yet.");

    const cls = await repo.getClass(classId);
    if (!cls || !cls.active) throw fail(404, "not_found", "Commodity class not found.");
    if (cls.halted) throw fail(409, "class_halted", "Trading in this class is halted.");

    const block = eligibilityBlock("commodity_unit", customer.tier, (await repo.getGrant(distributorId, "commodity_unit")) ?? undefined);
    if (block) throw fail(403, block.split(":")[0]!, `Not available to this customer through you (${block}).`);

    const price = await repo.latestReferencePrice(classId);
    if (!price || now.getTime() - price.publishedAt.getTime() > PRICE_MAX_AGE_MS) {
      throw fail(409, "price_stale", "No current reference price. Try again shortly.");
    }
    const params = await repo.latestMarketParams(classId);
    if (!params) throw fail(409, "market_not_open", "This class has no market parameters yet.");

    if (side !== "buy") {
      if (!customer.walletAddress) throw fail(409, "wallet_required", "Customer has no wallet.");
      const held = await this.d.holdings.unitsOf(customer.walletAddress, classId);
      if (held < units) throw fail(409, "insufficient_units", "Customer does not hold enough units.");
    }
    if (side === "buyback") await this.assertBuybackAvailable(repo, customer, classId, units, price, params, now);
    return { cls, price, params };
  }

  private async assertBuybackAvailable(
    repo: Repo, customer: Customer, classId: string, units: bigint, price: ReferencePrice, params: MarketParams, now: Date,
  ) {
    const unavailable = () => fail(409, "buyback_unavailable", "Instant buyback is paused. You can sell to other users instead.");
    if (params.buybackPaused) throw unavailable();

    // Circuit breaker: a sharp move against the price a day ago pauses instant buyback (not user-to-user trading).
    const before = await repo.referencePriceAtOrBefore(classId, new Date(now.getTime() - DAY_MS));
    if (before && before.priceKoboPerKg > 0n) {
      const diff = price.priceKoboPerKg > before.priceKoboPerKg ? price.priceKoboPerKg - before.priceKoboPerKg : before.priceKoboPerKg - price.priceKoboPerKg;
      if ((diff * BPS) / before.priceKoboPerKg >= BigInt(params.circuitBreakerBps)) throw unavailable();
    }
    const usedByUser = await repo.buybackUnitsToday(customer.id, classId, now);
    const usedTotal = await repo.buybackUnitsToday(null, classId, now);
    if (usedByUser + units > params.buybackDailyLimitUser || usedTotal + units > params.buybackDailyLimitTotal) {
      throw fail(409, "daily_limit_reached", "Today's instant-buyback limit is reached. Sell to other users or try tomorrow.");
    }
  }
}

function bookOf(price: ReferencePrice, p: MarketParams): PriceBook {
  return { referenceKoboPerKg: price.priceKoboPerKg, userSpreadBps: p.userSpreadBps, buybackSpreadBps: p.buybackSpreadBps };
}

/**
 * The order's money movement as one balanced journal (the database refuses an unbalanced one):
 *   buy:  distributor owes us the total; units sold at reference value; the spread is revenue
 *   sell: we owe the distributor the total; units bought at reference value; the spread is revenue
 * The user-side spread is shared with the distributor; the buyback spread is wholly ours.
 */
export function orderJournal(o: Order, classId: string, referenceKoboPerKg: bigint, distributorShareBps: number): LedgerLine[] {
  const refValue = (o.units * referenceKoboPerKg) / UNITS_PER_KG;
  const spread = o.side === "buy" ? o.totalKobo - refValue : refValue - o.totalKobo;
  if (spread < 0n) throw new Error(`Negative spread on order ${o.id}`);
  const share = o.side === "buyback" || !o.distributorId ? { distributor: 0n, platform: spread } : revenueShare(spread, distributorShareBps);
  const settleAcct = `distributor_settlement:${o.distributorId ?? "direct"}`;
  const sign = o.side === "buy" ? 1n : -1n;
  const lines: LedgerLine[] = [
    { account: settleAcct, deltaKobo: sign * o.totalKobo, kind: o.side },
    { account: `unit_sales:${classId}`, deltaKobo: -sign * refValue, kind: o.side },
    { account: "platform_revenue", deltaKobo: -share.platform, kind: "fee" },
  ];
  if (share.distributor > 0n) lines.push({ account: `distributor_revenue:${o.distributorId}`, deltaKobo: -share.distributor, kind: "revenue_share" });
  const kept = lines.filter((l) => l.deltaKobo !== 0n);
  if (kept.reduce((s, l) => s + l.deltaKobo, 0n) !== 0n) throw new Error(`Unbalanced journal for order ${o.id}`);
  return kept;
}

