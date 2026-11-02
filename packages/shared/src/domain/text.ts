// Text rules shared by the web app and API.
//
// Reference numbers (receipt numbers, LPO numbers, registry batch ids, company registration numbers,
// machine serials) are hashed before they go on-chain. The duplicate checks in the contracts only work
// if everyone normalises the same way before hashing, so this is the single definition.

/** "  isy-2026 / 0042 " → "ISY-2026/0042": trim, uppercase, drop internal whitespace. */
export function normalizeReference(raw: string): string {
  const s = raw.normalize("NFKC").trim().toUpperCase().replace(/\s+/g, "");
  if (s.length === 0) throw new Error("Reference is empty");
  if (s.length > 128) throw new Error("Reference is too long");
  return s;
}

/**
 * Short codes stored as bytes32 on-chain (commodity, grade, registry, methodology, asset type).
 * Allowed: A–Z, 0–9, underscore; 1–31 chars. Returns 0x-prefixed 32-byte hex, right-padded.
 */
export function toBytes32Code(code: string): `0x${string}` {
  const s = code.trim().toUpperCase().replace(/[\s-]+/g, "_");
  if (!/^[A-Z0-9_]{1,31}$/.test(s)) {
    throw new Error(`Code must be 1–31 characters of A–Z, 0–9 or _: "${code}"`);
  }
  let hex = "";
  for (let i = 0; i < s.length; i++) hex += s.charCodeAt(i).toString(16).padStart(2, "0");
  return `0x${hex.padEnd(64, "0")}`;
}

/** Inverse of toBytes32Code. Non-printable bytes are dropped. */
export function fromBytes32Code(hex: string): string {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  let out = "";
  for (let i = 0; i + 1 < h.length; i += 2) {
    const c = parseInt(h.slice(i, i + 2), 16);
    if (c === 0) break;
    if (c >= 0x20 && c < 0x7f) out += String.fromCharCode(c);
  }
  return out;
}

/** "GRADE_1" → "Grade 1" for display. */
export function humanizeCode(code: string): string {
  return code
    .toLowerCase()
    .split("_")
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(" ");
}

/** 0x1234…abcd */
export function shortAddress(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}
