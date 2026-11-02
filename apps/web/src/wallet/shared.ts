import { createWalletClient, custom, type Address, type Hex, type WalletClient, type EIP1193Provider } from "viem";
import { api } from "@/lib/api";
import { chain, publicClient } from "@/lib/chain";
import { abiFor, type Call } from "@/lib/calls";

/** Signed TradeChainX identity token that the wallet provider verifies (see apps/api/src/auth/walletToken.ts). */
export async function getWalletToken(): Promise<{ token: string; userId: string }> {
  return api<{ token: string; userId: string }>("/auth/wallet-token", { method: "POST", body: {} });
}

/** Simulate (to surface the contract's refusal reason) then send, via any viem wallet client. */
export async function sendWithViem(client: WalletClient, account: Address, call: Call): Promise<Hex> {
  const { request } = await publicClient.simulateContract({
    account,
    address: call.address,
    abi: abiFor(call),
    functionName: call.functionName,
    args: call.args,
  } as never);
  return client.writeContract({ ...(request as object), account, chain } as never);
}

/** Wrap an EIP-1193 provider (Privy, Dynamic) as a viem wallet client on our chain. */
export function clientFromProvider(provider: EIP1193Provider, account: Address): WalletClient {
  return createWalletClient({ account, chain, transport: custom(provider) });
}

/** Resolve once `get()` returns a value, or fail after `ms`. Used while a provider creates the wallet. */
export async function waitFor<T>(get: () => T | null | undefined, ms = 30_000, what = "your account"): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = get();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error(`Timed out setting up ${what}. Refresh and try again.`);
    await new Promise((r) => setTimeout(r, 250));
  }
}
