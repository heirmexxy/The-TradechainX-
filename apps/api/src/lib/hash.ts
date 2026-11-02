// Hashes that must match the contracts byte-for-byte. Each mirrors a Solidity function noted inline.
import { keccak256, toBytes, encodeAbiParameters, concat, type Hex } from "viem";
import { normalizeReference } from "@tradechainx/shared";

/** keccak256 of a normalised reference number (receipt no., LPO no., registry batch id, serial). */
export function referenceHash(raw: string): Hex {
  return keccak256(toBytes(normalizeReference(raw)));
}

/** WarehouseReceipt.receiptKey: keccak256(abi.encode(warehouseId, receiptNumberHash)) */
export function receiptKey(warehouseId: bigint, receiptNumberHash: Hex): Hex {
  return keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "bytes32" }], [warehouseId, receiptNumberHash]));
}

/** LPOToken.lpoKey: keccak256(abi.encode(buyerRefHash, lpoNumberHash)) */
export function lpoKey(buyerRefHash: Hex, lpoNumberHash: Hex): Hex {
  return keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [buyerRefHash, lpoNumberHash]));
}

/** CarbonCredits.batchKey: keccak256(abi.encode(registry, registryBatchIdHash)) */
export function batchKey(registry: Hex, registryBatchIdHash: Hex): Hex {
  return keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [registry, registryBatchIdHash]));
}

/**
 * The documentHash anchored on-chain for a bundle of files: keccak256 of the files' SHA-256 digests,
 * sorted so upload order doesn't matter. Anyone holding the files can recompute it.
 */
export function documentBundleHash(sha256s: string[]): Hex {
  if (sha256s.length === 0) throw new Error("At least one document is required");
  const sorted = [...sha256s].map((h) => h.toLowerCase() as Hex).sort();
  return keccak256(concat(sorted));
}

/** Opaque bytes32 reference for off-chain records (KYC cases, review notes). Reveals nothing. */
export function recordRef(kind: string, id: string): Hex {
  return keccak256(toBytes(`tradechainx:${kind}:${id}`));
}
