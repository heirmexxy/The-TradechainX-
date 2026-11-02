import { describe, it, expect } from "vitest";
import { keccak256, toBytes } from "viem";
import { referenceHash, receiptKey, lpoKey, batchKey, documentBundleHash } from "../src/lib/hash.ts";
import { toBytes32Code } from "@tradechainx/shared";

// Expected values were produced by calling the deployed contracts' own view functions
// (receiptKey / lpoKey / batchKey) with `cast`. If these fail, the API would compute keys the contracts
// disagree with and duplicate detection would silently break.
describe("hashes match the contracts", () => {
  it("referenceHash normalises before hashing", () => {
    const expected = "0x47bfeac24a39b6621993ed43be0ce0d281cf7f31b011dc4eee02495981e496f3";
    expect(referenceHash("ISY-2026/0042")).toBe(expected);
    expect(referenceHash("  isy-2026 / 0042 ")).toBe(expected);
  });

  it("receiptKey", () => {
    expect(receiptKey(1n, referenceHash("ISY-2026/0042"))).toBe(
      "0xa616a207fb6728a83e5b6d3a148b7741e830ac7e81d5f2ecac4bcaf5c98f151c",
    );
  });

  it("lpoKey", () => {
    expect(lpoKey(keccak256(toBytes("RC-554433")), keccak256(toBytes("PO-7781")))).toBe(
      "0xaba11b8e8ff4447b7ed3b3073d69197e46aa7aafd47de0aab5c8ac5b3a93b4d6",
    );
  });

  it("batchKey", () => {
    expect(toBytes32Code("VERRA")).toBe("0x5645525241000000000000000000000000000000000000000000000000000000");
    expect(batchKey(toBytes32Code("VERRA"), referenceHash("VCS-1234-2025-001-500"))).toBe(
      "0xd3733aaf2f327152ef4db25418c1d00dacf4f77c737618e7b825f2b638fefce8",
    );
  });

  it("documentBundleHash is order-independent", () => {
    const a = `0x${"a".repeat(64)}`;
    const b = `0x${"1".repeat(64)}`;
    const expected = "0x78ebe20a005a5610ffd12bb10b985d39707041327636917519e78094d3341e2a";
    expect(documentBundleHash([a, b])).toBe(expected);
    expect(documentBundleHash([b, a])).toBe(expected);
  });
});
