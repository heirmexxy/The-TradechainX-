// A contract call the API has prepared for the user's wallet to send. The API never signs user
// transactions; it returns exactly what to call, and the browser wallet signs it.
import type { Address } from "viem";

export type ContractKey =
  | "identityRegistry"
  | "warehouseRegistry"
  | "warehouseReceipt"
  | "lpoToken"
  | "carbonCredits"
  | "marketplace"
  | "xownFactory"
  | "xownVault"
  | "usdc";

export type PreparedCall = {
  contract: ContractKey;
  address: Address;
  functionName: string;
  /** bigints are encoded as {"$bigint": "123"} so they survive JSON; the web app revives them. */
  args: unknown[];
  /** Plain-language summary shown on the confirmation screen. */
  summary: string;
};

export function encodeArgs(value: unknown): unknown {
  if (typeof value === "bigint") return { $bigint: value.toString() };
  if (Array.isArray(value)) return value.map(encodeArgs);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = encodeArgs(v);
    return out;
  }
  return value;
}

export function call(
  contract: ContractKey,
  address: Address,
  functionName: string,
  args: unknown[],
  summary: string,
): PreparedCall {
  return { contract, address, functionName, args: encodeArgs(args) as unknown[], summary };
}
