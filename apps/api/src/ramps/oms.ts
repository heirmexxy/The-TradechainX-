// Polygon Open Money Stack (OMS) ramp — cash/bank ↔ USDC.
//
// STATUS (checked September 2026 — re-check before building on it):
//   * OMS is in technical preview; access is by request and granted in waves.
//   * Its fiat ramps (via Coinme) serve United States users only (48 states). They do NOT serve
//     Nigeria or other African markets, so this adapter is for US-based users/partners only.
//   * The public docs do not yet publish the ramp REST endpoints; they come with access.
//
// So this adapter is deliberately a thin shell: the request/response mapping is in one place
// (ENDPOINTS + mapStatus) and every spot you must confirm against the OMS docs is marked CONFIRM.
// Until you have OMS access, use RAMP_PROVIDER=partner (a local ramp) or none.
import { env } from "../env.ts";
import type { RampDirection, RampProvider, RampSession, RampSessionInput, RampWebhookEvent, RampHealth } from "./types.ts";
import { header, hmacHex, safeEqualSig } from "./signature.ts";
import type { RampStatus } from "../db/schema.ts";

// CONFIRM: replace with the paths in the OMS API reference you receive with access.
const ENDPOINTS = {
  createOnramp: "/v1/onramp/sessions",
  createOfframp: "/v1/offramp/sessions",
  health: "/v1/health",
};
// CONFIRM: the header OMS signs webhooks with, and the algorithm (assumed HMAC-SHA256 of the raw body).
const SIGNATURE_HEADER = "x-oms-signature";

function mapStatus(s: string): RampStatus {
  // CONFIRM: OMS status vocabulary.
  switch (s.toLowerCase()) {
    case "completed":
    case "settled":
    case "succeeded":
      return "completed";
    case "failed":
    case "rejected":
    case "expired":
      return "failed";
    case "cancelled":
    case "canceled":
      return "cancelled";
    case "created":
      return "created";
    default:
      return "pending";
  }
}

export class OmsRamp implements RampProvider {
  readonly name = "oms";
  readonly directions: RampDirection[] = ["deposit", "withdraw"];
  readonly currencies = ["USD"];
  readonly countries = ["US"];

  constructor(
    private baseUrl = env.RAMP_API_URL ?? "",
    private apiKey = env.RAMP_API_KEY ?? "",
    private webhookSecret = env.RAMP_WEBHOOK_SECRET ?? "",
  ) {
    if (!baseUrl || !apiKey) throw new Error("RAMP_PROVIDER=oms needs RAMP_API_URL and RAMP_API_KEY (request OMS access first).");
  }

  private async post(path: string, body: unknown) {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`OMS ramp error ${res.status}: ${text.slice(0, 300)}`);
    return (text ? JSON.parse(text) : {}) as Record<string, unknown>;
  }

  async createSession(input: RampSessionInput): Promise<RampSession> {
    // CONFIRM: field names. USDC on Polygon is what TradeChainX settles in.
    const res = await this.post(input.direction === "deposit" ? ENDPOINTS.createOnramp : ENDPOINTS.createOfframp, {
      externalId: input.txId,
      walletAddress: input.walletAddress,
      asset: "USDC",
      network: "polygon",
      fiatCurrency: input.fiatCurrency,
      fiatAmount: input.fiatAmount,
      cryptoAmount: input.usdcAmount,
      email: input.email,
      redirectUrl: input.returnUrl,
    });
    return {
      providerRef: String(res.id ?? res.sessionId ?? ""),
      redirectUrl: (res.url ?? res.checkoutUrl) as string | undefined,
    };
  }

  parseWebhook(rawBody: string, headers: Record<string, string | string[] | undefined>): RampWebhookEvent {
    if (!this.webhookSecret) throw new Error("RAMP_WEBHOOK_SECRET is not set");
    if (!safeEqualSig(hmacHex(this.webhookSecret, rawBody), header(headers, SIGNATURE_HEADER))) {
      throw new Error("bad signature");
    }
    const p = JSON.parse(rawBody) as Record<string, unknown>;
    const d = (p.data ?? p) as Record<string, unknown>;
    return {
      providerRef: d.id ? String(d.id) : undefined,
      txId: d.externalId ? String(d.externalId) : undefined,
      status: mapStatus(String(d.status ?? "")),
      usdcAmount: d.cryptoAmount ? String(d.cryptoAmount) : undefined,
      fiatAmount: d.fiatAmount ? String(d.fiatAmount) : undefined,
      txHash: d.txHash ? String(d.txHash) : undefined,
      raw: p,
    };
  }

  async health(): Promise<RampHealth> {
    try {
      const res = await fetch(`${this.baseUrl}${ENDPOINTS.health}`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(8000),
      });
      return res.ok ? { status: "ok", detail: "OMS ramp API reachable" } : { status: "degraded", detail: `OMS ramp API returned ${res.status}` };
    } catch (e) {
      return { status: "down", detail: `OMS ramp API unreachable: ${(e as Error).message}` };
    }
  }
}
