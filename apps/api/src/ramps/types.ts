// Fiat on/off-ramp adapter. TradeChainX never touches fiat or card/bank details: the provider runs
// KYC + payment in its own hosted flow and sends USDC to (or takes USDC from) the user's wallet.
// We create a session, send the user to the provider, and mirror its webhooks so the user sees progress.
//
// Selected by RAMP_PROVIDER (none | oms | partner). See docs/OMS_INTEGRATION.md for which to use where.
import type { RampStatus } from "../db/schema.ts";

export type RampDirection = "deposit" | "withdraw";

export type RampSessionInput = {
  /** Our ramp_transactions.id — pass to the provider as their "partner order id" so webhooks map back. */
  txId: string;
  direction: RampDirection;
  fiatCurrency: string;
  fiatAmount?: string;
  usdcAmount?: string; // base units (6 dp)
  walletAddress: string;
  email: string;
  /** Where the provider sends the user when they finish. */
  returnUrl: string;
};

export type RampSession = {
  providerRef?: string;
  /** Hosted checkout to redirect/iframe the user into. */
  redirectUrl?: string;
  /** For bank-transfer style flows: account details/reference to show the user. */
  instructions?: Record<string, string>;
};

export type RampWebhookEvent = {
  providerRef?: string;
  txId?: string;
  status: RampStatus;
  usdcAmount?: string;
  fiatAmount?: string;
  txHash?: string;
  raw: Record<string, unknown>;
};

export type RampHealth = { status: "ok" | "degraded" | "down" | "unknown"; detail: string };

export interface RampProvider {
  readonly name: string;
  readonly directions: RampDirection[];
  readonly currencies: string[];
  /** ISO country codes the provider serves, or null for "check provider". */
  readonly countries: string[] | null;
  createSession(input: RampSessionInput): Promise<RampSession>;
  /** Verify the signature and translate the payload. Throw on a bad signature. */
  parseWebhook(rawBody: string, headers: Record<string, string | string[] | undefined>): RampWebhookEvent;
  health(): Promise<RampHealth>;
}
