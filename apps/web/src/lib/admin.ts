import { keccak256, toBytes } from "viem";
import { fromApi, type Call } from "./calls";
import type { PreparedCallJson } from "./types";

/**
 * Reviewer notes stay off-chain; only their fingerprint goes into the contract's reasonRef argument.
 * Prepared admin calls carry a zero placeholder in that position.
 */
export function withReason(prepared: PreparedCallJson, note: string, index = 1): Call {
  const call = fromApi(prepared);
  const args = [...call.args];
  args[index] = keccak256(toBytes(note.trim()));
  return { ...call, args };
}
