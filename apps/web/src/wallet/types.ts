import type { Address, Hex } from "viem";
import type { Call } from "@/lib/calls";

export type WalletProviderKind = "dev" | "privy" | "dynamic" | "sequence";

/**
 * The only wallet interface the app uses. Every screen goes through this, so switching between
 * Privy, Dynamic, Sequence (or Polygon Open Money Stack embedded wallets when they ship) is a
 * configuration change: NEXT_PUBLIC_WALLET_PROVIDER.
 *
 * Users never see words like "wallet", "gas" or "sign" (PRD success metric); adapters hide them.
 */
export interface WalletAdapter {
  readonly kind: WalletProviderKind;
  /** Create or restore the signed-in user's wallet. Silent — no provider login screen. */
  connect(email: string): Promise<Address>;
  address(): Address | null;
  signMessage(message: string): Promise<Hex>;
  /** Send one contract call; resolves with the transaction hash once submitted. */
  send(call: Call): Promise<Hex>;
  disconnect(): void;
}
