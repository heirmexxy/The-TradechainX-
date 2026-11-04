// Naira amounts are bigint kobo (2 decimals) everywhere in the code. Customer-facing prices and
// settlements are in naira (PRD v3 §5); USDC (money.ts) stays internal for institutional flows.

export const NAIRA_DECIMALS = 2;
const SCALE = 10n ** BigInt(NAIRA_DECIMALS);

/** "1,250.5" → 125050n kobo. Rejects negatives, more than 2 decimals and non-numbers. */
export function parseNaira(input: string): bigint {
  const s = input.trim().replace(/^₦/, "").replace(/,/g, "");
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`Not a valid amount: "${input}"`);
  const [whole = "0", frac = ""] = s.split(".");
  if (frac.length > NAIRA_DECIMALS) throw new Error(`At most ${NAIRA_DECIMALS} decimal places: "${input}"`);
  return BigInt(whole) * SCALE + BigInt(frac.padEnd(NAIRA_DECIMALS, "0"));
}

/** 125050n → "₦1,250.50" */
export function formatNaira(kobo: bigint): string {
  const negative = kobo < 0n;
  const abs = negative ? -kobo : kobo;
  const whole = (abs / SCALE).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const frac = (abs % SCALE).toString().padStart(NAIRA_DECIMALS, "0");
  return `${negative ? "-" : ""}₦${whole}.${frac}`;
}
