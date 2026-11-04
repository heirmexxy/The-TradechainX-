// Commodity Units rules shared by the API and web (PRD v3 §4, §6, §7). Pure functions, bigint only,
// no floating point. Rounding directions are chosen so the platform never over-issues and never
// under-charges: issuance rounds DOWN, retirement quotes round UP, buy totals round UP, sell totals DOWN.
// Issuance and retirement mirror CommodityUnits.sol exactly; test/commodity.test.ts pins that.

/** One base unit is one gram, so 1 kg = 1000 units and holdings divide to 0.001 kg. */
export const UNITS_PER_KG = 1000n;
export const BPS = 10_000n;
/** Minimum purchase per order: 10 kg. */
export const MIN_ORDER_UNITS = 10n * UNITS_PER_KG;
export const MAX_SHRINKAGE_BPS = 2_000;
export const MAX_FEE_BPS_CAP = 500;
export const FEE_PERIOD_SECONDS = 30 * 24 * 60 * 60;

export function ceilDiv(a: bigint, b: bigint): bigint {
  if (b <= 0n) throw new Error("Division by zero");
  return (a + b - 1n) / b;
}

// ---------------------------------------------------------------- unit conversion

/** "10" → 10000n, "0.001" → 1n. At most 3 decimals; rejects negatives and rounding. */
export function kgToUnits(kg: string): bigint {
  const s = kg.trim();
  if (!/^\d+(\.\d{1,3})?$/.test(s)) throw new Error(`Not a valid weight in kg (max 3 decimals): "${kg}"`);
  const [whole = "0", frac = ""] = s.split(".");
  return BigInt(whole) * UNITS_PER_KG + BigInt(frac.padEnd(3, "0"));
}

/** 10000n → "10", 1n → "0.001", 12345n → "12.345" */
export function unitsToKg(units: bigint): string {
  if (units < 0n) throw new Error("Negative units");
  const whole = units / UNITS_PER_KG;
  const frac = (units % UNITS_PER_KG).toString().padStart(3, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

// ---------------------------------------------------------------- issuance and backing (mirror the contract)

/** Units minted for an attested weight: attested grams minus the shrinkage buffer, rounded down. */
export function issuableUnits(backedGrams: bigint, shrinkageBps: number): bigint {
  assertShrinkage(shrinkageBps);
  return (backedGrams * (BPS - BigInt(shrinkageBps))) / BPS;
}

/** Units that must be retired when `grams` of a lot are sold: its proportional share, rounded up. */
export function unitsToRetire(issuedLive: bigint, grams: bigint, remainingGrams: bigint): bigint {
  if (grams <= 0n || grams > remainingGrams) throw new Error("Sale weight must be between 1 g and the remaining stock");
  return grams === remainingGrams ? issuedLive : ceilDiv(issuedLive * grams, remainingGrams);
}

/** True while units outstanding do not exceed what live stock supports. */
export function isWithinBacking(outstandingUnits: bigint, backedGrams: bigint, shrinkageBps: number): boolean {
  return outstandingUnits <= issuableUnits(backedGrams, shrinkageBps);
}

/** Units the stock no longer supports (0 when fully backed). */
export function unbackedUnits(issuedLive: bigint, remainingGrams: bigint, shrinkageBps: number): bigint {
  const supported = issuableUnits(remainingGrams, shrinkageBps);
  return issuedLive > supported ? issuedLive - supported : 0n;
}

function assertShrinkage(bps: number) {
  if (!Number.isInteger(bps) || bps < 0 || bps > MAX_SHRINKAGE_BPS) throw new Error(`Shrinkage must be 0–${MAX_SHRINKAGE_BPS} bps`);
}

// ---------------------------------------------------------------- pricing (naira, kobo per kg)

export type Side = "buy" | "sell" | "buyback";

export interface PriceBook {
  /** Published reference price, kobo per kg. */
  referenceKoboPerKg: bigint;
  /** Distance of the user buy/sell price from the reference, in bps (narrow, matched trades). */
  userSpreadBps: number;
  /** Distance of Kitovu's instant-buyback bid from the reference, in bps (wider: Kitovu carries the risk). */
  buybackSpreadBps: number;
}

export function validatePriceBook(book: PriceBook): void {
  if (book.referenceKoboPerKg <= 0n) throw new Error("Reference price must be positive");
  for (const bps of [book.userSpreadBps, book.buybackSpreadBps]) {
    if (!Number.isInteger(bps) || bps < 0 || bps >= 10_000) throw new Error("Spread must be 0–9999 bps");
  }
  if (book.buybackSpreadBps < book.userSpreadBps) throw new Error("Buyback spread cannot be narrower than the user spread");
}

/** Price per kg the customer sees for a side. */
export function quoteKoboPerKg(book: PriceBook, side: Side): bigint {
  validatePriceBook(book);
  const ref = book.referenceKoboPerKg;
  if (side === "buy") return ref + ceilDiv(ref * BigInt(book.userSpreadBps), BPS);
  if (side === "sell") return ref - ceilDiv(ref * BigInt(book.userSpreadBps), BPS);
  return ref - ceilDiv(ref * BigInt(book.buybackSpreadBps), BPS);
}

export interface OrderQuote {
  side: Side;
  units: bigint;
  koboPerKg: bigint;
  /** Total in kobo: buys round UP, sells and buybacks round DOWN. */
  totalKobo: bigint;
}

/** Total for an order. Enforces the 10 kg minimum on purchases. */
export function quoteOrder(book: PriceBook, side: Side, units: bigint): OrderQuote {
  if (units <= 0n) throw new Error("Order must be for at least 1 g");
  if (side === "buy" && units < MIN_ORDER_UNITS) throw new Error("Minimum purchase is 10 kg");
  const koboPerKg = quoteKoboPerKg(book, side);
  const raw = units * koboPerKg;
  const totalKobo = side === "buy" ? ceilDiv(raw, UNITS_PER_KG) : raw / UNITS_PER_KG;
  return { side, units, koboPerKg, totalKobo };
}

// ---------------------------------------------------------------- holding fee

export interface HoldingFeeInput {
  balanceUnits: bigint;
  /** Storage + insurance charge, kobo per kg per month (e.g. ₦3 → 300n plus margin). */
  feeKoboPerKgMonth: bigint;
  referenceKoboPerKg: bigint;
  /** Class cap: maximum units one charge may take, as bps of the balance (contract limit 500). */
  maxFeeBps: number;
}

/** Units to collect for one 30-day period, rounded up, then capped exactly as the contract caps it. */
export function holdingFeeUnits(i: HoldingFeeInput): bigint {
  if (i.maxFeeBps < 0 || i.maxFeeBps > MAX_FEE_BPS_CAP) throw new Error(`maxFeeBps must be 0–${MAX_FEE_BPS_CAP}`);
  if (i.balanceUnits <= 0n || i.referenceKoboPerKg <= 0n) return 0n;
  const feeKobo = ceilDiv(i.balanceUnits * i.feeKoboPerKgMonth, UNITS_PER_KG);
  const wanted = ceilDiv(feeKobo * UNITS_PER_KG, i.referenceKoboPerKg);
  const cap = (i.balanceUnits * BigInt(i.maxFeeBps)) / BPS;
  return wanted < cap ? wanted : cap;
}

// ---------------------------------------------------------------- distributor revenue share and settlement

/** Splits an amount between distributor and platform. The distributor share rounds down. */
export function revenueShare(amountKobo: bigint, distributorShareBps: number): { distributor: bigint; platform: bigint } {
  if (!Number.isInteger(distributorShareBps) || distributorShareBps < 0 || distributorShareBps > 10_000) {
    throw new Error("Share must be 0–10000 bps");
  }
  const distributor = (amountKobo * BigInt(distributorShareBps)) / BPS;
  return { distributor, platform: amountKobo - distributor };
}

export interface SettlementEntry {
  distributorId: string;
  side: Side;
  totalKobo: bigint;
}

/**
 * Net cash position per distributor for a settlement window. Positive = the distributor owes
 * TradeChainX's client-money account (its customers bought); negative = TradeChainX owes the distributor.
 */
export function netSettlement(entries: SettlementEntry[]): Map<string, bigint> {
  const out = new Map<string, bigint>();
  for (const e of entries) {
    const delta = e.side === "buy" ? e.totalKobo : -e.totalKobo;
    out.set(e.distributorId, (out.get(e.distributorId) ?? 0n) + delta);
  }
  return out;
}

export interface PrefundCheck {
  prefundKobo: bigint;
  creditLimitKobo: bigint;
  /** Cash the distributor already owes for delivered-but-unsettled buys. */
  unsettledExposureKobo: bigint;
  orderKobo: bigint;
}

/** Orders that would push unsettled exposure past prefund + credit limit are declined (PRD v3 §5.4). */
export function checkPrefund(c: PrefundCheck): { allowed: boolean; headroomKobo: bigint } {
  const limit = c.prefundKobo + c.creditLimitKobo;
  const headroomKobo = limit - c.unsettledExposureKobo;
  return { allowed: c.orderKobo <= headroomKobo, headroomKobo };
}
