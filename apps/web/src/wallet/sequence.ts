// Sequence embedded wallets (WaaS) — the wallet layer Polygon's Open Money Stack is built on.
// Signed in with the TradeChainX session via an OIDC ID token (no Sequence login screen).
//
// Builder setup (sequence.build → your project):
//   1. Embedded Wallet → Configuration → add a custom OIDC provider: Issuer = <API_URL>,
//      Audience = WALLET_TOKEN_AUDIENCE (API env), JWKS discovered via <API_URL>/.well-known/openid-configuration.
//   2. Copy the Project Access Key and WaaS Config Key.
//   3. Gas sponsorship: Builder → Gas Sponsorship → sponsor your contract addresses on your chain.
// Env: NEXT_PUBLIC_SEQUENCE_PROJECT_ACCESS_KEY, NEXT_PUBLIC_SEQUENCE_WAAS_CONFIG_KEY,
//      NEXT_PUBLIC_SEQUENCE_NETWORK (optional; derived from the chain id otherwise).
//
// Written against @0xsequence/waas v2. Sequence wallets are smart accounts: the API verifies their
// signatures with ERC-1271/6492, which viem's verifyMessage handles.
import { encodeFunctionData, type Address, type Hex } from "viem";
import { CHAIN_ID, publicClient } from "@/lib/chain";
import { abiFor, type Call } from "@/lib/calls";
import type { WalletAdapter } from "./types";
import { getWalletToken } from "./shared";

const NETWORK_BY_CHAIN: Record<number, string> = {
  137: "polygon",
  80002: "amoy",
  8453: "base",
  42161: "arbitrum",
  42220: "celo",
};

type Waas = {
  signIn(creds: { idToken: string }, sessionName: string): Promise<unknown>;
  getAddress(): Promise<string>;
  signMessage(args: { message: string; network?: string }): Promise<{ data: { signature: string } }>;
  sendTransaction(args: { transactions: { to: string; data?: string; value?: string }[]; network?: string }): Promise<unknown>;
  dropSession?(args?: unknown): Promise<unknown>;
};

export class SequenceWallet implements WalletAdapter {
  readonly kind = "sequence" as const;
  private waas: Waas | null = null;
  private addr: Address | null = null;
  private network = process.env.NEXT_PUBLIC_SEQUENCE_NETWORK || NETWORK_BY_CHAIN[CHAIN_ID] || "amoy";

  constructor(private projectAccessKey: string, private waasConfigKey: string) {
    if (!projectAccessKey || !waasConfigKey) {
      throw new Error("Set NEXT_PUBLIC_SEQUENCE_PROJECT_ACCESS_KEY and NEXT_PUBLIC_SEQUENCE_WAAS_CONFIG_KEY.");
    }
  }

  private async client(): Promise<Waas> {
    if (this.waas) return this.waas;
    const { SequenceWaaS } = await import("@0xsequence/waas");
    this.waas = new SequenceWaaS({
      projectAccessKey: this.projectAccessKey,
      waasConfigKey: this.waasConfigKey,
      network: this.network,
    }) as unknown as Waas;
    return this.waas;
  }

  async connect(): Promise<Address> {
    const waas = await this.client();
    const { token } = await getWalletToken();
    await waas.signIn({ idToken: token }, "TradeChainX");
    this.addr = (await waas.getAddress()) as Address;
    return this.addr;
  }

  address(): Address | null {
    return this.addr;
  }

  async signMessage(message: string): Promise<Hex> {
    const res = await (await this.client()).signMessage({ message, network: this.network });
    return res.data.signature as Hex;
  }

  async send(call: Call): Promise<Hex> {
    if (!this.addr) throw new Error("Not connected");
    // Simulate first so a refusal comes back with the contract's reason before anything is sent.
    await publicClient.simulateContract({
      account: this.addr,
      address: call.address,
      abi: abiFor(call),
      functionName: call.functionName,
      args: call.args,
    } as never);
    const data = encodeFunctionData({ abi: abiFor(call), functionName: call.functionName, args: call.args } as never);
    const res = (await (await this.client()).sendTransaction({ transactions: [{ to: call.address, data }], network: this.network })) as {
      code?: string;
      data?: { txHash?: string; receipt?: { txnHash?: string } };
    };
    const hash = res.data?.txHash ?? res.data?.receipt?.txnHash;
    if (!hash) throw new Error("The transaction wasn't accepted. Try again.");
    return hash as Hex;
  }

  disconnect() {
    void this.waas?.dropSession?.();
    this.addr = null;
  }
}
