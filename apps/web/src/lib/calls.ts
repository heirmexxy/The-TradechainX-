import type { Address } from "viem";
import { ABIS, ADDRESSES, ASSET_ADDRESS, ASSET_CONTRACT_KEY, type ContractKey } from "./chain";

/** One contract call for the wallet to send. Mirrors the API's PreparedCall. */
export type Call = {
  contract: ContractKey;
  address: Address;
  functionName: string;
  args: unknown[];
  /** Plain-language step name shown while it runs. */
  summary: string;
};

/** Turns the API's {"$bigint": "123"} markers back into bigints. */
export function reviveArgs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reviveArgs);
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    if (typeof o.$bigint === "string" && Object.keys(o).length === 1) return BigInt(o.$bigint);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) out[k] = reviveArgs(v);
    return out;
  }
  return value;
}

export function fromApi(c: { contract: ContractKey; address: Address; functionName: string; args: unknown[]; summary: string }): Call {
  return { ...c, args: reviveArgs(c.args) as unknown[] };
}

export const abiFor = (c: Call) => ABIS[c.contract];

const c = (contract: ContractKey, address: Address, functionName: string, args: unknown[], summary: string): Call => ({
  contract,
  address,
  functionName,
  args,
  summary,
});

type AssetType = "warehouse-receipt" | "lpo" | "carbon";

// ---------------------------------------------------------------- builders for user actions
// Everything here is public on-chain data; nothing needs the API to prepare it.

export const calls = {
  approveUsdc: (spender: Address, amount: bigint) =>
    c("usdc", ADDRESSES.usdc, "approve", [spender, amount], "Allow the payment"),

  /** Listing moves the asset into the marketplace, so it first needs permission to move it. */
  list(assetType: AssetType, tokenId: bigint, amount: bigint, pricePerUnit: bigint): Call[] {
    const key = ASSET_CONTRACT_KEY[assetType];
    const permit =
      assetType === "carbon"
        ? c(key, ASSET_ADDRESS[assetType], "setApprovalForAll", [ADDRESSES.marketplace, true], "Allow the marketplace to hold your credits")
        : c(key, ASSET_ADDRESS[assetType], "approve", [ADDRESSES.marketplace, tokenId], "Allow the marketplace to hold this asset");
    return [
      permit,
      c("marketplace", ADDRESSES.marketplace, "list", [ASSET_ADDRESS[assetType], tokenId, amount, pricePerUnit], "Put it up for sale"),
    ];
  },

  cancelListing: (listingId: bigint) =>
    c("marketplace", ADDRESSES.marketplace, "cancel", [listingId], "Take it off the market"),

  updatePrice: (listingId: bigint, price: bigint) =>
    c("marketplace", ADDRESSES.marketplace, "updatePrice", [listingId, price], "Change the price"),

  buy: (listingId: bigint, amount: bigint, maxTotal: bigint) =>
    c("marketplace", ADDRESSES.marketplace, "buy", [listingId, amount, maxTotal], "Complete the purchase"),

  grantLien: (assetType: "warehouse-receipt" | "lpo", tokenId: bigint, lender: Address, maturity: bigint, agreementRef: `0x${string}`) =>
    c(ASSET_CONTRACT_KEY[assetType], ASSET_ADDRESS[assetType], "grantLien", [tokenId, lender, maturity, agreementRef], "Pledge to the lender"),

  releaseLien: (assetType: "warehouse-receipt" | "lpo", tokenId: bigint) =>
    c(ASSET_CONTRACT_KEY[assetType], ASSET_ADDRESS[assetType], "releaseLien", [tokenId], "Release the pledge"),

  enforceLien: (assetType: "warehouse-receipt" | "lpo", tokenId: bigint) =>
    c(ASSET_CONTRACT_KEY[assetType], ASSET_ADDRESS[assetType], "enforceLien", [tokenId], "Take ownership under the pledge"),

  requestRedemption: (tokenId: bigint, remaining: bigint, evidenceRef: `0x${string}`) =>
    c("warehouseReceipt", ADDRESSES.warehouseReceipt, "requestRedemption", [tokenId, remaining, evidenceRef], "Ask to collect the goods"),

  confirmRelease: (tokenId: bigint) =>
    c("warehouseReceipt", ADDRESSES.warehouseReceipt, "confirmWarehouseRelease", [tokenId], "Confirm the goods were released"),

  requestWarehouseChange: (tokenId: bigint, kind: number, newExpiry: bigint, evidenceRef: `0x${string}`) =>
    c("warehouseReceipt", ADDRESSES.warehouseReceipt, "requestWarehouseChange", [tokenId, kind, newExpiry, evidenceRef], "Send the change for review"),

  cancelRequest: (assetType: "warehouse-receipt" | "lpo", tokenId: bigint) =>
    c(ASSET_CONTRACT_KEY[assetType], ASSET_ADDRESS[assetType], "cancelStatusRequest", [tokenId], "Cancel the request"),

  settleLpo: (tokenId: bigint, faceValue: bigint): Call[] => [
    calls.approveUsdc(ADDRESSES.lpoToken, faceValue),
    c("lpoToken", ADDRESSES.lpoToken, "settle", [tokenId], "Pay the purchase order"),
  ],

  requestOffChainSettlement: (tokenId: bigint, evidenceRef: `0x${string}`) =>
    c("lpoToken", ADDRESSES.lpoToken, "requestOffChainSettlement", [tokenId, evidenceRef], "Report payment received"),

  requestLpoChange: (tokenId: bigint, kind: number, newDueDate: bigint, evidenceRef: `0x${string}`) =>
    c("lpoToken", ADDRESSES.lpoToken, "requestOriginatorChange", [tokenId, kind, newDueDate, evidenceRef], "Send the change for review"),

  retire: (batchId: bigint, amount: bigint, beneficiaryRef: `0x${string}`, reasonRef: `0x${string}`) =>
    c("carbonCredits", ADDRESSES.carbonCredits, "retire", [batchId, amount, beneficiaryRef, reasonRef], "Retire the credits"),

  subscribe: (vault: Address, shares: bigint, cost: bigint): Call[] => [
    calls.approveUsdc(vault, cost),
    c("xownVault", vault, "subscribe", [shares], "Buy shares"),
  ],
  claimYield: (vault: Address) => c("xownVault", vault, "claimYield", [], "Collect earnings"),
  refund: (vault: Address) => c("xownVault", vault, "refund", [], "Get your money back"),
  redeemShares: (vault: Address) => c("xownVault", vault, "redeem", [], "Redeem your shares"),
  markFailed: (vault: Address) => c("xownVault", vault, "markFailed", [], "Close the unfilled offering"),
  depositYield: (vault: Address, amount: bigint): Call[] => [
    calls.approveUsdc(vault, amount),
    c("xownVault", vault, "depositYield", [amount], "Pay earnings to shareholders"),
  ],
  depositProceeds: (vault: Address, amount: bigint): Call[] => [
    calls.approveUsdc(vault, amount),
    c("xownVault", vault, "depositProceeds", [amount], "Deposit sale proceeds"),
  ],
  dissolve: (vault: Address) => c("xownVault", vault, "dissolve", [], "Close the offering and open redemptions"),

  // Admin controls
  pause: (key: ContractKey, address: Address) => c(key, address, "pause", [], "Pause"),
  unpause: (key: ContractKey, address: Address) => c(key, address, "unpause", [], "Resume"),
  setFee: (bps: number, collector: Address) => c("marketplace", ADDRESSES.marketplace, "setFee", [bps, collector], "Update the marketplace fee"),
  setWarehouseActive: (id: bigint, active: boolean, reasonRef: `0x${string}`) =>
    c("warehouseRegistry", ADDRESSES.warehouseRegistry, "setWarehouseActive", [id, active, reasonRef], active ? "Reinstate warehouse" : "Suspend warehouse"),
  setCarbonSuspended: (batchId: bigint, value: boolean, reasonRef: `0x${string}`) =>
    c("carbonCredits", ADDRESSES.carbonCredits, "setSuspended", [batchId, value, reasonRef], value ? "Suspend batch" : "Lift suspension"),
};
