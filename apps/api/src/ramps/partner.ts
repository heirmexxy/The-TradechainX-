// Hosted-checkout ramp partner — the path for Nigeria and other markets OMS doesn't serve.
//
// Most local/aggregator ramps (e.g. Yellow Card, Kotani Pay, Onramper, Transak — pick one that
// supports NGN (or your market) ↔ USDC on your chain and passes your compliance review) work the same way:
//   1. You build a checkout URL with your public key, the user's wallet, asset/network and an order id.
//   2. The user completes KYC + payment on the provider's page.
//   3. The provider calls your webhook, signed with a shared secret.
// This adapter implements that generic shape. Adjust QUERY/WEBHOOK mappings to your partner's docs —
// they're isolated below and marked ADAPT.
//
// Env: RAMP_API_URL = the partner's hosted checkout base URL
//      RAMP_API_KEY = the partner's PUBLIC/publishable key (it appears in the URL; never a secret key)
//      RAMP_WEBHOOK_SECRET = the webhook signing secret from the partner dashboard
//      RAMP_CURRENCIES = e.g. "NGN,KES,GHS"; RAMP_COUNTRIES = e.g. "NG,KE,GH"
import { env } from "../env.ts";
import type { RampStatus } from "../db/schema.ts";
import type { RampDirection, RampHealth, RampProvider, RampSession, RampSessionInput, RampWebhookEvent } from "./types.ts";
import { header, hmacHex, safeEqualSig } from "./signature.ts";

// ADAPT: query parameter names your partner's hosted checkout expects.
function checkoutQuery(i: RampSessionInput, publicKey: string, network: string): Record<string, string> {
  const q: Record<string, string> = {
    apiKey: publicKey,
    productsAvailed: i.direction === "deposit" ? "BUY" : "SELL",
    cryptoCurrencyCode: "USDC",
    network,
    walletAddress: i.walletAddress,
    fiatCurrency: i.fiatCurrency,
    partnerOrderId: i.txId,
    email: i.email,
    redirectURL: i.returnUrl,
    disableWalletAddressForm: "true",
  };
  if (i.fiatAmount) q.fiatAmount = i.fiatAmount;
  return q;
}

// ADAPT: the header carrying the webhook signature.
const SIGNATURE_HEADER = "x-signature";

// ADAPT: status vocabulary.
function mapStatus(s: string): RampStatus {
  const v = s.toUpperCase();
  if (["COMPLETED", "SUCCESS", "SETTLED"].includes(v)) return "completed";
  if (["FAILED", "EXPIRED", "REJECTED"].includes(v)) return "failed";
  if (["CANCELLED", "CANCELED"].includes(v)) return "cancelled";
  return "pending";
}

const NETWORK: Record<number, string> = { 137: "polygon", 80002: "polygon", 8453: "base", 42161: "arbitrum", 42220: "celo" };

export class PartnerRamp implements RampProvider {
  readonly name = "partner";
  readonly directions: RampDirection[] = ["deposit", "withdraw"];
  readonly currencies: string[];
  readonly countries: string[] | null;

  constructor(
    private baseUrl = env.RAMP_API_URL ?? "",
    private publicKey = env.RAMP_API_KEY ?? "",
    private webhookSecret = env.RAMP_WEBHOOK_SECRET ?? "",
  ) {
    if (!baseUrl || !publicKey) throw new Error("RAMP_PROVIDER=partner needs RAMP_API_URL and RAMP_API_KEY.");
    this.currencies = (env.RAMP_CURRENCIES ?? "NGN").split(",").map((c) => c.trim().toUpperCase()).filter(Boolean);
    this.countries = env.RAMP_COUNTRIES ? env.RAMP_COUNTRIES.split(",").map((c) => c.trim().toUpperCase()) : null;
  }

  async createSession(input: RampSessionInput): Promise<RampSession> {
    const url = new URL(this.baseUrl);
    for (const [k, v] of Object.entries(checkoutQuery(input, this.publicKey, NETWORK[env.CHAIN_ID] ?? "polygon"))) {
      url.searchParams.set(k, v);
    }
    return { redirectUrl: url.toString() };
  }

  parseWebhook(rawBody: string, headers: Record<string, string | string[] | undefined>): RampWebhookEvent {
    if (!this.webhookSecret) throw new Error("RAMP_WEBHOOK_SECRET is not set");
    if (!safeEqualSig(hmacHex(this.webhookSecret, rawBody), header(headers, SIGNATURE_HEADER))) {
      throw new Error("bad signature");
    }
    const p = JSON.parse(rawBody) as Record<string, unknown>;
    // ADAPT: where your partner puts the order fields.
    const d = ((p.data as Record<string, unknown>) ?? (p.webhookData as Record<string, unknown>) ?? p) as Record<string, unknown>;
    return {
      providerRef: d.id ? String(d.id) : undefined,
      txId: d.partnerOrderId ? String(d.partnerOrderId) : undefined,
      status: mapStatus(String(d.status ?? "")),
      usdcAmount: d.cryptoAmount != null ? String(Math.round(Number(d.cryptoAmount) * 1e6)) : undefined,
      fiatAmount: d.fiatAmount != null ? String(d.fiatAmount) : undefined,
      txHash: d.transactionHash ? String(d.transactionHash) : undefined,
      raw: p,
    };
  }

  async health(): Promise<RampHealth> {
    try {
      const res = await fetch(this.baseUrl, { method: "HEAD", signal: AbortSignal.timeout(8000) });
      return res.status < 500
        ? { status: "ok", detail: "Ramp checkout reachable" }
        : { status: "degraded", detail: `Ramp checkout returned ${res.status}` };
    } catch (e) {
      return { status: "down", detail: `Ramp checkout unreachable: ${(e as Error).message}` };
    }
  }
}
