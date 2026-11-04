// In-memory Repo for tests and local experiments. Mirrors the semantics of the Postgres schema that matter
// to the rules: unique idempotency keys, one order per quote, append-only balanced journals.
import { randomUUID } from "node:crypto";
import type { DistributionAssetType, DistributorAssetGrant } from "@tradechainx/shared";
import type {
  CommodityClass, Customer, Distributor, LedgerLine, MarketParams, Order, Quote, ReferencePrice, Repo, Settlement,
} from "../model.ts";

export class MemoryRepo implements Repo {
  distributors = new Map<string, Distributor>();
  grants = new Map<string, DistributorAssetGrant>(); // `${partnerId}:${asset}`
  classes = new Map<string, CommodityClass>();
  prices: ReferencePrice[] = [];
  params = new Map<string, MarketParams>();
  customers = new Map<string, Customer>();
  quotes = new Map<string, Quote>();
  orders = new Map<string, Order>();
  settlements = new Map<string, Settlement>();
  journals: { journalId: string; orderId: string | null; lines: LedgerLine[] }[] = [];
  /** Instant-buyback units already used today (test hook: the real repo sums orders). */
  buybackUsed = new Map<string, bigint>(); // `${customerId|all}:${classId}`
  private priceSeq = 0;

  async tx<T>(fn: (r: Repo) => Promise<T>): Promise<T> {
    return fn(this); // single-threaded: good enough for logic tests (atomicity is the database's job)
  }

  async getDistributor(id: string) { return this.distributors.get(id) ?? null; }
  async getGrant(id: string, a: DistributionAssetType) { return this.grants.get(`${id}:${a}`) ?? null; }
  async listClasses() { return [...this.classes.values()]; }
  async getClass(id: string) { return this.classes.get(id) ?? null; }
  async getReferencePrice(id: number) { return this.prices.find((p) => p.id === id) ?? null; }
  async latestReferencePrice(classId: string) {
    return this.prices.filter((p) => p.classId === classId).sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime())[0] ?? null;
  }
  async referencePriceAtOrBefore(classId: string, before: Date) {
    return this.prices.filter((p) => p.classId === classId && p.publishedAt <= before).sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime())[0] ?? null;
  }
  async latestMarketParams(classId: string) { return this.params.get(classId) ?? null; }

  addPrice(classId: string, priceKoboPerKg: bigint, publishedAt: Date): ReferencePrice {
    const p = { id: ++this.priceSeq, classId, priceKoboPerKg, publishedAt };
    this.prices.push(p);
    return p;
  }

  async getCustomer(id: string) { return this.customers.get(id) ?? null; }
  async findDistributorCustomer(partnerId: string, ref: string) {
    return [...this.customers.values()].find((c) => c.distributorId === partnerId && c.externalRef === ref) ?? null;
  }
  async insertCustomer(c: Omit<Customer, "id">) {
    const row = { ...c, id: randomUUID() };
    this.customers.set(row.id, row);
    return row;
  }
  async setCustomerWallet(id: string, walletAddress: string) {
    const c = this.customers.get(id)!;
    this.customers.set(id, { ...c, walletAddress });
  }

  async insertQuote(q: Omit<Quote, "id" | "createdAt">) {
    const row = { ...q, id: randomUUID(), createdAt: new Date() };
    this.quotes.set(row.id, row);
    return row;
  }
  async getQuote(id: string) { return this.quotes.get(id) ?? null; }

  async findOrderByIdempotency(distributorId: string | null, customerId: string, key: string) {
    return [...this.orders.values()].find((o) => o.idempotencyKey === key && (distributorId ? o.distributorId === distributorId : o.customerId === customerId)) ?? null;
  }
  async findOrderByQuote(quoteId: string) { return [...this.orders.values()].find((o) => o.quoteId === quoteId) ?? null; }
  async insertOrder(o: Omit<Order, "id" | "status" | "failureReason" | "chainTxHash" | "createdAt">) {
    const row: Order = { ...o, id: randomUUID(), status: "accepted", failureReason: null, chainTxHash: null, createdAt: new Date() };
    this.orders.set(row.id, row);
    return row;
  }
  async getOrder(id: string) { return this.orders.get(id) ?? null; }
  async updateOrder(id: string, patch: Partial<Pick<Order, "status" | "failureReason" | "chainTxHash">>) {
    const next = { ...this.orders.get(id)!, ...patch };
    this.orders.set(id, next);
    return next;
  }

  async unsettledExposureKobo(distributorId: string) {
    let exposure = 0n;
    for (const o of this.orders.values()) {
      if (o.distributorId === distributorId && o.status === "delivered") exposure += o.side === "buy" ? o.totalKobo : -o.totalKobo;
    }
    for (const s of this.settlements.values()) {
      if (s.distributorId === distributorId && s.status !== "paid") exposure += s.netKobo;
    }
    return exposure;
  }
  async buybackUnitsToday(customerId: string | null, classId: string) {
    return this.buybackUsed.get(`${customerId ?? "all"}:${classId}`) ?? 0n;
  }
  async deliveredUnsettledOrders(distributorId: string, windowEnd: Date) {
    return [...this.orders.values()].filter((o) => o.distributorId === distributorId && o.status === "delivered" && o.createdAt <= windowEnd);
  }

  async postJournal(journalId: string, orderId: string | null, lines: LedgerLine[]) {
    const sum = lines.reduce((s, l) => s + l.deltaKobo, 0n);
    if (sum !== 0n) throw new Error(`Unbalanced ledger journal ${journalId}`); // what the database trigger enforces
    if (lines.some((l) => l.deltaKobo === 0n)) throw new Error("Zero-value ledger line");
    this.journals.push({ journalId, orderId, lines });
  }
  async insertSettlement(s: Omit<Settlement, "id" | "status" | "custodianRef">) {
    const row: Settlement = { ...s, id: randomUUID(), status: "open", custodianRef: null };
    this.settlements.set(row.id, row);
    return row;
  }
  async getSettlement(id: string) { return this.settlements.get(id) ?? null; }
  async updateSettlement(id: string, patch: Partial<Pick<Settlement, "status" | "custodianRef">>) {
    const next = { ...this.settlements.get(id)!, ...patch };
    this.settlements.set(id, next);
    return next;
  }
  async markOrdersSettled(ids: string[]) {
    for (const id of ids) this.orders.set(id, { ...this.orders.get(id)!, status: "settled" });
  }
}
