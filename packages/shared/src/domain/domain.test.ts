import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseUsdc, formatUsdc, feeFor, discountBps } from "./money.ts";
import { normalizeReference, toBytes32Code, fromBytes32Code, humanizeCode } from "./text.ts";
import { resolveAssetStatus } from "./status.ts";
import { KYC_TIER_FOR, kycTrackFor } from "./roles.ts";
import { Tier, SubmissionStatus, ReceiptRequestKind, LpoRequestKind, VaultState } from "./enums.ts";

test("parseUsdc / formatUsdc round-trip", () => {
  assert.equal(parseUsdc("1,250.5"), 1_250_500_000n);
  assert.equal(parseUsdc("0.000001"), 1n);
  assert.equal(parseUsdc("25000"), 25_000_000_000n);
  assert.equal(formatUsdc(1_250_500_000n), "1,250.50");
  assert.equal(formatUsdc(1n), "0.000001");
  assert.equal(formatUsdc(25_000_000_000n, { symbol: true }), "25,000.00 USDC");
  for (const s of ["0.01", "999999.999999", "1234567.89"]) {
    assert.equal(parseUsdc(formatUsdc(parseUsdc(s))), parseUsdc(s));
  }
});

test("parseUsdc rejects bad input instead of rounding", () => {
  assert.throws(() => parseUsdc("-5"));
  assert.throws(() => parseUsdc("1.1234567"));
  assert.throws(() => parseUsdc("abc"));
  assert.throws(() => parseUsdc(""));
});

test("feeFor matches the contract (rounds down)", () => {
  assert.equal(feeFor(10_000_000_000n, 100), 100_000_000n);
  assert.equal(feeFor(99n, 100), 0n);
  assert.equal(feeFor(parseUsdc("18000"), 100), parseUsdc("180"));
});

test("discountBps", () => {
  assert.equal(discountBps(parseUsdc("30000"), parseUsdc("28800")), 400);
  assert.equal(discountBps(0n, 1n), 0);
});

test("normalizeReference makes equivalent references hash identically", () => {
  assert.equal(normalizeReference("  isy-2026 / 0042 "), "ISY-2026/0042");
  assert.equal(normalizeReference("ISY-2026/0042"), normalizeReference("isy-2026/0042"));
  assert.equal(normalizeReference("ＡＢＣ１２３"), "ABC123"); // full-width characters
  assert.throws(() => normalizeReference("   "));
});

test("bytes32 codes", () => {
  const maize = toBytes32Code("maize");
  assert.equal(maize.length, 66);
  assert.equal(maize.slice(0, 12), "0x4d41495a45");
  assert.equal(fromBytes32Code(maize), "MAIZE");
  assert.equal(fromBytes32Code(toBytes32Code("grade 1")), "GRADE_1");
  assert.equal(humanizeCode("GRADE_1"), "Grade 1");
  assert.throws(() => toBytes32Code("x".repeat(32)));
  assert.throws(() => toBytes32Code("bad!"));
});

test("resolveAssetStatus precedence", () => {
  const now = 1_000;
  assert.equal(resolveAssetStatus({ now }), "active");
  assert.equal(resolveAssetStatus({ now, listed: true }), "listed");
  assert.equal(resolveAssetStatus({ now, listed: true, pledged: true }), "pledged");
  assert.equal(resolveAssetStatus({ now, pledged: true, expiresAt: 999 }), "expired");
  assert.equal(resolveAssetStatus({ now, suspended: true, expiresAt: 999 }), "suspended");
  assert.equal(resolveAssetStatus({ now, burnedAs: "redeemed", suspended: true }), "redeemed");
});

test("KYC tiers follow the PRD", () => {
  assert.equal(KYC_TIER_FOR.trader, Tier.Individual);
  assert.equal(KYC_TIER_FOR.warehouse, Tier.Business);
  assert.equal(KYC_TIER_FOR.lender, Tier.Institutional);
  assert.equal(kycTrackFor("investor"), "individual");
  assert.equal(kycTrackFor("lender"), "business");
});

// The TS enum mirrors must match the Solidity declaration order. The ABIs don't carry enum names, so
// we parse the Solidity sources directly.
function solidityEnum(file: string, name: string): string[] {
  const src = readFileSync(new URL(`../../../../contracts/src/${file}`, import.meta.url), "utf8");
  const m = src.match(new RegExp(`enum\\s+${name}\\s*\\{([^}]*)\\}`));
  assert.ok(m, `enum ${name} not found in ${file}`);
  return m[1]!.replace(/\/\/.*$/gm, "").split(",").map((s) => s.trim()).filter(Boolean);
}

function assertMirrors(tsEnum: Record<string, number>, solidity: string[]) {
  assert.deepEqual(Object.keys(tsEnum), solidity);
  solidity.forEach((name, i) => assert.equal(tsEnum[name], i, name));
}

test("TS enums mirror Solidity", () => {
  assertMirrors(Tier, solidityEnum("interfaces/IIdentityRegistry.sol", "Tier"));
  assertMirrors(SubmissionStatus, solidityEnum("WarehouseReceipt.sol", "SubmissionStatus"));
  assertMirrors(SubmissionStatus, solidityEnum("LPOToken.sol", "SubmissionStatus"));
  assertMirrors(SubmissionStatus, solidityEnum("CarbonCredits.sol", "SubmissionStatus"));
  assertMirrors(ReceiptRequestKind, solidityEnum("WarehouseReceipt.sol", "RequestKind"));
  assertMirrors(LpoRequestKind, solidityEnum("LPOToken.sol", "RequestKind"));
  assertMirrors(VaultState, solidityEnum("xown/XOwnVault.sol", "State"));
});
