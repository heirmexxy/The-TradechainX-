import { createWalletClient, http, keccak256, toBytes, type Address, type Hex, type WalletClient } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { chain, publicClient, RPC_URL } from "@/lib/chain";
import { abiFor, type Call } from "@/lib/calls";
import type { WalletAdapter } from "./types";

/**
 * DEVELOPMENT ONLY. Derives a key from a public dev seed + the user's email, entirely in the browser,
 * and pays gas from the dev faucet. Anyone who knows the seed and an email can derive that key, so
 * this must never be used with real funds. The app refuses to use it when NODE_ENV is production.
 *
 * Deterministic on purpose: the API's seed script derives the same demo wallets and gives them roles.
 */
export class DevWallet implements WalletAdapter {
  readonly kind = "dev" as const;
  private account: PrivateKeyAccount | null = null;
  private client: WalletClient | null = null;

  constructor(private seed: string) {
    if (process.env.NODE_ENV === "production" && process.env.NEXT_PUBLIC_ALLOW_DEV_WALLET !== "true") {
      throw new Error("The dev wallet is disabled in production builds. Set NEXT_PUBLIC_WALLET_PROVIDER=sequence.");
    }
  }

  async connect(email: string): Promise<Address> {
    const key = keccak256(toBytes(`${this.seed}:${email.toLowerCase()}`));
    this.account = privateKeyToAccount(key);
    this.client = createWalletClient({ account: this.account, chain, transport: http(RPC_URL) });
    return this.account.address;
  }

  address(): Address | null {
    return this.account?.address ?? null;
  }

  async signMessage(message: string): Promise<Hex> {
    if (!this.account) throw new Error("Not connected");
    return this.account.signMessage({ message });
  }

  async send(call: Call): Promise<Hex> {
    if (!this.account || !this.client) throw new Error("Not connected");
    // Simulate first so a refusal comes back with the contract's reason before anything is sent.
    const { request } = await publicClient.simulateContract({
      account: this.account,
      address: call.address,
      abi: abiFor(call),
      functionName: call.functionName,
      args: call.args,
    } as never);
    return this.client.writeContract(request as never);
  }

  disconnect() {
    this.account = null;
    this.client = null;
  }
}
