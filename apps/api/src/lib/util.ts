// Helpers for moving on-chain values into JSON and the database.

/** Recursively turn bigints into decimal strings (JSON can't hold bigint). */
export function jsonSafe<T>(value: T): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = jsonSafe(v);
    return out;
  }
  return value;
}

export const lower = (a: string) => a.toLowerCase();

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export function isZeroAddress(a: string | undefined | null): boolean {
  return !a || a.toLowerCase() === ZERO_ADDRESS;
}

/** Unix seconds now. */
export const nowSec = () => Math.floor(Date.now() / 1000);
