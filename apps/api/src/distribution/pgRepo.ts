// Postgres implementation of the Repo port, using the SQL in sql.ts. Money columns are BIGINT (strings from pg).
import type { Pool, PoolClient } from "pg";
import type { DistributionAssetType, DistributorAssetGrant } from "@tradechainx/shared";
import type {
  CommodityClass, Customer, Distributor, LedgerLine, MarketParams, Order, Quote, ReferencePrice, Repo, Settlement,
} from "./model.ts";
import { SQL } from "./sql.ts";

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Q = Pick<Pool | PoolClient, "query">;

const big = (v: unknown) => BigInt(v as string | number | bigint);
const one = (rows: Row[]): Row | null => rows[0] ?? null;

const toDistributor = (r: Row): Distributor => ({
  partnerId: r.partner_id, revenueShareBps: r.revenue_share_bps, prefundKobo: big(r.prefund_kobo), creditLimitKobo: big(r.credit_limit_kobo),
  kycRelianceSignedAt: r.kyc_reliance_signed_at, status: r.status,
});
const toClass = (r: Row): CommodityClass => ({ id: r.id, displayName: r.display_name, shrinkageBps: r.shrinkage_bps, active: r.active, halted: r.halted });
const toPrice = (r: Row): ReferencePrice => ({ id: Number(r.id), classId: r.class_id, priceKoboPerKg: big(r.price_kobo_per_kg), publishedAt: r.published_at });
const toParams = (r: Row): MarketParams => ({
  userSpreadBps: r.user_spread_bps, buybackSpreadBps: r.buyback_spread_bps, buybackDailyLimitUser: big(r.buyback_daily_limit_user),
  buybackDailyLimitTotal: big(r.buyback_daily_limit_total), circuitBreakerBps: r.circuit_breaker_bps, buybackPaused: r.buyback_paused,
});
const toCustomer = (r: Row): Customer => ({
  id: r.id, distributorId: r.distributor_id, externalRef: r.external_ref, tier: r.tier, kycStatus: r.kyc_status, kycBasis: r.kyc_basis, walletAddress: r.wallet_address,
});
const toQuote = (r: Row): Quote => ({
  id: r.id, customerId: r.customer_id, classId: r.class_id, side: r.side, units: big(r.units), koboPerKg: big(r.kobo_per_kg), totalKobo: big(r.total_kobo),
  referencePriceId: Number(r.reference_price_id), expiresAt: r.expires_at, createdAt: r.created_at,
});
const toOrder = (r: Row): Order => ({
  id: r.id, quoteId: r.quote_id, customerId: r.customer_id, distributorId: r.distributor_id, idempotencyKey: r.idempotency_key, side: r.side,
  units: big(r.units), totalKobo: big(r.total_kobo), status: r.status, failureReason: r.failure_reason, chainTxHash: r.chain_tx_hash, createdAt: r.created_at,
});
const toSettlement = (r: Row): Settlement => ({
  id: r.id, distributorId: r.distributor_id, windowStart: r.window_start, windowEnd: r.window_end, netKobo: big(r.net_kobo), status: r.status, custodianRef: r.custodian_ref,
});

export class PgRepo implements Repo {
  private pool: Pool | null;
  private q: Q;

  constructor(poolOrClient: Pool | PoolClient, private nested = false) {
    this.q = poolOrClient;
    this.pool = nested ? null : (poolOrClient as Pool);
  }

  /** One database transaction. Nested calls reuse the open transaction. The deferred ledger-balance trigger fires at COMMIT. */
  async tx<T>(fn: (r: Repo) => Promise<T>): Promise<T> {
    if (this.nested || !this.pool) return fn(this);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const out = await fn(new PgRepo(client, true));
      await client.query("COMMIT");
      return out;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  private async rows(text: string, params: unknown[] = []): Promise<Row[]> {
    return (await this.q.query(text, params as any[])).rows; // eslint-disable-line @typescript-eslint/no-explicit-any
  }

  async getDistributor(id: string) { const r = one(await this.rows(SQL.distributor, [id])); return r ? toDistributor(r) : null; }
  async getGrant(id: string, asset: DistributionAssetType): Promise<DistributorAssetGrant | null> {
    const r = one(await this.rows(SQL.grant, [id, asset]));
    return r ? { enabled: r.enabled, tiers: r.tiers, acceptedDisclosures: r.accepted_disclosures } : null;
  }

  async listClasses() { return (await this.rows(SQL.classes)).map(toClass); }
  async getClass(id: string) { const r = one(await this.rows(SQL.classById, [id])); return r ? toClass(r) : null; }
  async getReferencePrice(id: number) { const r = one(await this.rows(SQL.priceById, [id])); return r ? toPrice(r) : null; }
  async latestReferencePrice(classId: string) { const r = one(await this.rows(SQL.priceLatest, [classId])); return r ? toPrice(r) : null; }
  async referencePriceAtOrBefore(classId: string, before: Date) { const r = one(await this.rows(SQL.priceAtOrBefore, [classId, before])); return r ? toPrice(r) : null; }
  async latestMarketParams(classId: string) { const r = one(await this.rows(SQL.marketParams, [classId])); return r ? toParams(r) : null; }

  async getCustomer(id: string) { const r = one(await this.rows(SQL.customerById, [id])); return r ? toCustomer(r) : null; }
  async findDistributorCustomer(partnerId: string, ref: string) { const r = one(await this.rows(SQL.customerByRef, [partnerId, ref])); return r ? toCustomer(r) : null; }
  async insertCustomer(c: Omit<Customer, "id">) {
    if (!c.distributorId || !c.externalRef) throw new Error("PgRepo.insertCustomer only creates distributor customers; direct customers are created at sign-up.");
    return toCustomer((await this.rows(SQL.customerInsert, [c.distributorId, c.externalRef, c.tier, c.kycStatus, c.kycBasis]))[0]!);
  }
  async setCustomerWallet(id: string, walletAddress: string, custodianRef: string) { await this.rows(SQL.customerWallet, [id, walletAddress, custodianRef]); }

  async insertQuote(q: Omit<Quote, "id" | "createdAt">) {
    const rows = await this.rows(SQL.quoteInsert, [q.customerId, q.classId, q.side, q.units.toString(), q.koboPerKg.toString(), q.totalKobo.toString(), q.referencePriceId, q.expiresAt]);
    return toQuote(rows[0]!);
  }
  async getQuote(id: string) { const r = one(await this.rows(SQL.quoteById, [id])); return r ? toQuote(r) : null; }

  async findOrderByIdempotency(distributorId: string | null, customerId: string, key: string) {
    const r = distributorId ? one(await this.rows(SQL.orderByKeyDistributor, [distributorId, key])) : one(await this.rows(SQL.orderByKeyDirect, [customerId, key]));
    return r ? toOrder(r) : null;
  }
  async findOrderByQuote(quoteId: string) { const r = one(await this.rows(SQL.orderByQuote, [quoteId])); return r ? toOrder(r) : null; }
  async insertOrder(o: Omit<Order, "id" | "status" | "failureReason" | "chainTxHash" | "createdAt">) {
    const rows = await this.rows(SQL.orderInsert, [o.quoteId, o.customerId, o.distributorId, o.idempotencyKey, o.side, o.units.toString(), o.totalKobo.toString()]);
    return toOrder(rows[0]!);
  }
  async getOrder(id: string) { const r = one(await this.rows(SQL.orderById, [id])); return r ? toOrder(r) : null; }
  async updateOrder(id: string, patch: Partial<Pick<Order, "status" | "failureReason" | "chainTxHash">>) {
    const rows = await this.rows(SQL.orderUpdate, [id, patch.status ?? null, patch.failureReason ?? null, patch.chainTxHash ?? null]);
    return toOrder(rows[0]!);
  }

  async unsettledExposureKobo(distributorId: string) { return big((await this.rows(SQL.exposure, [distributorId]))[0]!.exposure); }
  async buybackUnitsToday(customerId: string | null, classId: string, now: Date) {
    const startOfDayUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    return big((await this.rows(SQL.buybackToday, [classId, startOfDayUtc, customerId]))[0]!.units);
  }
  async deliveredUnsettledOrders(distributorId: string, windowEnd: Date) {
    return (await this.rows(SQL.ordersDeliveredUnsettled, [distributorId, windowEnd])).map(toOrder);
  }

  async postJournal(journalId: string, orderId: string | null, lines: LedgerLine[]) {
    await this.rows(SQL.journalInsert, [
      journalId, orderId, lines.map((l) => l.account), lines.map((l) => l.deltaKobo.toString()), lines.map((l) => l.kind), lines.map((l) => l.memo ?? null),
    ]);
  }
  async insertSettlement(s: Omit<Settlement, "id" | "status" | "custodianRef">) {
    return toSettlement((await this.rows(SQL.settlementInsert, [s.distributorId, s.windowStart, s.windowEnd, s.netKobo.toString()]))[0]!);
  }
  async getSettlement(id: string) { const r = one(await this.rows(SQL.settlementById, [id])); return r ? toSettlement(r) : null; }
  async updateSettlement(id: string, patch: Partial<Pick<Settlement, "status" | "custodianRef">>) {
    return toSettlement((await this.rows(SQL.settlementUpdate, [id, patch.status ?? null, patch.custodianRef ?? null]))[0]!);
  }
  async markOrdersSettled(ids: string[]) { if (ids.length) await this.rows(SQL.ordersMarkSettled, [ids]); }
}
