import { createHmac, timingSafeEqual } from "node:crypto";

/** HMAC-SHA256 hex of `payload`. */
export function hmacHex(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

/** Constant-time compare of two hex/ascii signatures (optionally "sha256=" prefixed). */
export function safeEqualSig(expected: string, received: string | undefined): boolean {
  if (!received) return false;
  const r = received.replace(/^sha256=/, "").trim();
  const a = Buffer.from(expected);
  const b = Buffer.from(r);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const header = (h: Record<string, string | string[] | undefined>, name: string): string | undefined => {
  const v = h[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
};
