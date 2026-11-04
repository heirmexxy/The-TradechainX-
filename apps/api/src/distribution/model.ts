// Types and ports for the Distribution API core (docs/DISTRIBUTION_API.md). Nothing in this folder's
// service imports a framework or the database: it talks to the outside world only through the ports
// below, so the business rules run (and are tested) without Fastify, Postgres or a blockchain.
import type { CustomerTier, DistributionAssetType, DistributorAssetGrant, Side } from "@tradechainx/shared";

export type KycStatus = "pending" | "verified" | "needs_info" | "rejected" | "frozen";
export type OrderStatus = "accepted" | "funds_confirmed" | "delivered" | "settled" | "failed" | "cancelled";

export interface Distributor {
  partnerId: string;
  revenueShareBps: number;
  prefundKobo: bigint;
  creditLimitKobo: bigint;
  kycRelianceSignedAt: Date | null;
  status: "sandbox" | "live" | "suspended";
}

export interface CommodityClass {
  id: string;
  displayName: string;
  shrinkageBps: number;
  active: boolean;
  halted: boolean;
}

export interface Customer {
  id: string;
  distributorId: string | null;
  externalRef: string | null;
  tier: CustomerTier;
  kycStatus: KycStatus;
  kycBasis: "tradechainx" | "distributor_reliance";
  walletAddress: string | null;
}

export interface ReferencePrice {
  id: number;
  classId: string;
  priceKoboPerKg: bigint;
  publishedAt: Date;
}

export interface MarketParams {
  userSpreadBps: number;
  buybackSpreadBps: number;
  buybackDailyLimitUser: bigint;   // units
  buybackDailyLimitTotal: bigint;  // units
  circuitBreakerBps: number;
  buybackPaused: boolean;
}

export interface Quote {
  id: string;
  customerId: string;
  classId: string;
  side: Side;
  units: bigint;
  koboPerKg: bigint;
  totalKobo: bigint;
  referencePriceId: number;
  expiresAt: Date;
  createdAt: Date;
}

export interface Order {
  id: string;
  quoteId: string;
  customerId: string;
  distributorId: string | null;
  idempotencyKey: string;
  side: Side;
  units: bigint;
  totalKobo: bigint;
  status: OrderStatus;
  failureReason: string | null;
  chainTxHash: string | null;
  createdAt: Date;
}

export interface LedgerLine {
  account: string;
  deltaKobo: bigint;
  kind: "buy" | "sell" | "buyback" | "fee" | "revenue_share" | "settlement" | "processor_payout" | "adjustment";
  memo?: string;
}

export interface Settlement {
  id: string;
  distributorId: string;
  windowStart: Date;
  windowEnd: Date;
  netKobo: bigint;
  status: "open" | "reported" | "confirmed" | "paid" | "disputed";
  custodianRef: string | null;
}

/** Persistence port. `tx` runs the callback atomically (one database transaction in production). */
export interface Repo {
  tx<T>(fn: (r: Repo) => Promise<T>): Promise<T>;

  getDistributor(partnerId: string): Promise<Distributor | null>;
  getGrant(partnerId: string, asset: DistributionAssetType): Promise<DistributorAssetGrant | null>;

  getClass(id: string): Promise<CommodityClass | null>;
  listClasses(): Promise<CommodityClass[]>;
  getReferencePrice(id: number): Promise<ReferencePrice | null>;
  latestReferencePrice(classId: string): Promise<ReferencePrice | null>;
  /** Most recent reference price published at or before `before` (for the day-over-day circuit breaker). */
  referencePriceAtOrBefore(classId: string, before: Date): Promise<ReferencePrice | null>;
  latestMarketParams(classId: string): Promise<MarketParams | null>;

  getCustomer(id: string): Promise<Customer | null>;
  findDistributorCustomer(partnerId: string, externalRef: string): Promise<Customer | null>;
  insertCustomer(c: Omit<Customer, "id">): Promise<Customer>;
  setCustomerWallet(id: string, walletAddress: string, custodianRef: string): Promise<void>;

  insertQuote(q: Omit<Quote, "id" | "createdAt">): Promise<Quote>;
  getQuote(id: string): Promise<Quote | null>;

  /** Looks up by (distributor, key) for distributed customers, or (customer, key) for direct ones. */
  findOrderByIdempotency(distributorId: string | null, customerId: string, key: string): Promise<Order | null>;
  findOrderByQuote(quoteId: string): Promise<Order | null>;
  insertOrder(o: Omit<Order, "id" | "status" | "failureReason" | "chainTxHash" | "createdAt">): Promise<Order>;
  getOrder(id: string): Promise<Order | null>;
  updateOrder(id: string, patch: Partial<Pick<Order, "status" | "failureReason" | "chainTxHash">>): Promise<Order>;

  /**
   * Cash position that counts against the distributor's prefund headroom: delivered orders not yet in a
   * settlement (buys minus sells/buybacks) plus the net of settlements that are not yet paid.
   */
  unsettledExposureKobo(distributorId: string): Promise<bigint>;
  /** Units a customer has already sold back to Kitovu today, and all customers' total today. */
  buybackUnitsToday(customerId: string | null, classId: string, now: Date): Promise<bigint>;
  deliveredUnsettledOrders(distributorId: string, windowEnd: Date): Promise<Order[]>;

  postJournal(journalId: string, orderId: string | null, lines: LedgerLine[]): Promise<void>;
  insertSettlement(s: Omit<Settlement, "id" | "status" | "custodianRef">): Promise<Settlement>;
  getSettlement(id: string): Promise<Settlement | null>;
  updateSettlement(id: string, patch: Partial<Pick<Settlement, "status" | "custodianRef">>): Promise<Settlement>;
  markOrdersSettled(orderIds: string[]): Promise<void>;
}

/** Wallet provisioning: a licensed custodian holds the keys (PRD v3 §6.2). */
export interface Custodian {
  provisionWallet(customerId: string): Promise<{ address: string; custodianRef: string }>;
}

/** Read-only view of the chain registry. */
export interface Holdings {
  unitsOf(walletAddress: string, classId: string): Promise<bigint>;
}

export interface Clock {
  now(): Date;
}
