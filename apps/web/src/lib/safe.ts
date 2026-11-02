// Export contract calls as a Safe{Wallet} Transaction Builder batch file.
//
// In production the Super Admin role belongs to a Safe multisig, so admin-only actions (granting roles,
// resuming contracts, changing the fee) can't be sent from a person's own wallet. Download the batch,
// then in app.safe.global → Apps → Transaction Builder → "drag and drop a JSON file", review, and
// collect the other owners' signatures.
import { encodeFunctionData } from "viem";
import { ABIS, CHAIN_ID } from "./chain";
import type { Call } from "./calls";

export function safeBatch(calls: Call[], name: string) {
  return {
    version: "1.0",
    chainId: String(CHAIN_ID),
    createdAt: Date.now(),
    meta: { name, description: calls.map((c) => c.summary).join(" → ") },
    transactions: calls.map((c) => ({
      to: c.address,
      value: "0",
      data: encodeFunctionData({ abi: ABIS[c.contract], functionName: c.functionName, args: c.args } as never),
      contractMethod: null,
      contractInputsValues: null,
    })),
  };
}

export function downloadSafeBatch(calls: Call[], name: string) {
  const blob = new Blob([JSON.stringify(safeBatch(calls, name), null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-safe-batch.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
