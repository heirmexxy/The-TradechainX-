// USDC amounts are bigint base units (6 decimals) everywhere in the code. These helpers are the only
// place strings and base units are converted, so rounding rules live in one spot.

export const USDC_DECIMALS = 6;
const SCALE = 10n ** BigInt(USDC_DECIMALS);

/**
 * "1,250.5" → 1250500000n. Rejects negatives, more than 6 decimals, and anything that isn't a number,
 * rather than silently rounding a price someone typed.
 */
export function parseUsdc(input: string): bigint {
  const s = input.trim().replace(/,/g, "");
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`Not a valid amount: "${input}"`);
  const [whole = "0", frac = ""] = s.split(".");
  if (frac.length > USDC_DECIMALS) throw new Error(`At most ${USDC_DECIMALS} decimal places: "${input}"`);
  return BigInt(whole) * SCALE + BigInt(frac.padEnd(USDC_DECIMALS, "0"));
}

/** 1250500000n → "1,250.50". Always shows 2 decimals; shows more only when needed. */
export function formatUsdc(value: bigint, opts: { symbol?: boolean } = {}): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / SCALE;
  let frac = (abs % SCALE).toString().padStart(USDC_DECIMALS, "0").replace(/0+$/, "");
  if (frac.length < 2) frac = frac.padEnd(2, "0");
  const wholeStr = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const body = `${negative ? "-" : ""}${wholeStr}.${frac}`;
  return opts.symbol ? `${body} USDC` : body;
}

/** Basis-point fee, rounded down — identical to the Marketplace contract. */
export function feeFor(total: bigint, feeBps: number): bigint {
  return (total * BigInt(feeBps)) / 10_000n;
}

/** Discount an LPO is being sold at, in basis points, for display ("sold at 4.00% below face"). */
export function discountBps(faceValue: bigint, price: bigint): number {
  if (faceValue === 0n) return 0;
  return Number(((faceValue - price) * 10_000n) / faceValue);
}
