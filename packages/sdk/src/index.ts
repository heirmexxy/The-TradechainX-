// @tradechainx/sdk — a small, dependency-free client for the TradeChainX Partner API.
// Works in Node 18+, Deno, Bun and edge runtimes (uses global fetch and WebCrypto).
// Server-side only: never ship an API key to a browser.
//
//   import { TradeChainX, reviveCalls, verifyWebhook } from "@tradechainx/sdk";
//   const tcx = new TradeChainX({ apiKey: process.env.TRADECHAINX_API_KEY! });
//   const { offerings } = await tcx.offerings.list();

export type Scope = "read" | "issue" | "trade";
export type AssetType = "warehouse-receipt" | "lpo" | "carbon";

/** A contract call prepared by TradeChainX for YOUR wallet to sign. bigints arrive as {"$bigint": "…"}. */
export type PreparedCall = {
  contract: string;
  address: `0x${string}`;
  functionName: string;
  args: unknown[];
  summary: string;
};

export type CallsResponse = { signer: `0x${string}`; calls: PreparedCall[]; totalUsdc?: string };

export type WebhookEvent<T = Record<string, unknown>> = {
  id: string;
  type: string;
  created: string;
  livemode: boolean;
  data: T;
};

export class TradeChainXError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryAfterSeconds?: number;
  constructor(status: number, code: string, message: string, retryAfterSeconds?: number) {
    super(message);
    this.name = "TradeChainXError";
    this.status = status;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export type ClientOptions = {
  apiKey: string;
  /** Defaults to the production API. */
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Per-request timeout in ms (default 15000). */
  timeoutMs?: number;
};

type Query = Record<string, string | number | undefined>;

export class TradeChainX {
  private opts: ClientOptions;
  private base: string;
  private f: typeof fetch;
  private timeoutMs: number;

  constructor(opts: ClientOptions) {
    this.opts = opts;
    if (!opts.apiKey?.startsWith("tcx_")) throw new Error("TradeChainX: apiKey must start with tcx_");
    this.base = (opts.baseUrl ?? "https://api.tradechainx.com").replace(/\/$/, "") + "/partner/v1";
    this.f = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  /** Low-level request. Prefer the typed helpers below. */
  async request<T>(method: string, path: string, init: { query?: Query; json?: unknown; body?: BodyInit } = {}): Promise<T> {
    const url = new URL(this.base + path);
    for (const [k, v] of Object.entries(init.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
    const headers: Record<string, string> = { Authorization: `Bearer ${this.opts.apiKey}`, Accept: "application/json" };
    let body = init.body;
    if (init.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(init.json);
    }
    const res = await this.f(url, { method, headers, body, signal: AbortSignal.timeout(this.timeoutMs) });
    const text = await res.text();
    const data = text ? JSON.parse(text) : {};
    if (!res.ok) {
      const retry = res.headers.get("retry-after");
      throw new TradeChainXError(res.status, data.error ?? "error", data.message ?? `HTTP ${res.status}`, retry ? Number(retry) : undefined);
    }
    return data as T;
  }

  me() {
    return this.request<{
      partner: { id: string; name: string; referralCode: string };
      account: { walletAddress: string | null; verifiedBusiness: boolean };
      key: { prefix: string; scopes: Scope[]; rateLimitPerMinute: number; dailyQuota: number; usedToday: number };
      chain: { chainId: number; usdc: string; contracts: Record<string, string> };
    }>("GET", "/me");
  }

  events() {
    return this.request<{ events: { type: string; description: string }[] }>("GET", "/events");
  }

  readonly offerings = {
    list: () => this.request<{ offerings: Record<string, unknown>[] }>("GET", "/offerings"),
    get: (vault: string) => this.request<{ offering: Record<string, unknown> }>("GET", `/offerings/${vault}`),
  };

  readonly assets = {
    list: (q: { type?: AssetType; owner?: string; limit?: number; cursor?: number } = {}) =>
      this.request<{ assets: Record<string, unknown>[]; nextCursor: number | null }>("GET", "/assets", { query: q }),
    get: (type: AssetType, id: string | number | bigint) => this.request<{ asset: Record<string, unknown> }>("GET", `/assets/${type}/${id}`),
  };

  readonly listings = {
    list: (q: { type?: AssetType; seller?: string; limit?: number } = {}) => this.request<{ listings: Record<string, unknown>[] }>("GET", "/listings", { query: q }),
    get: (id: string | number | bigint) => this.request<{ listing: Record<string, unknown> }>("GET", `/listings/${id}`),
  };

  readonly documents = {
    /** Upload a PDF/JPG/PNG (max 15 MB). Returns its id and SHA-256 (anchored on-chain with the submission). */
    upload: (file: Blob, opts: { filename: string; kind?: string }) => {
      const form = new FormData();
      form.append("kind", opts.kind ?? "other");
      form.append("file", file, opts.filename);
      return this.request<{ document: { id: string; sha256: string; filename: string } }>("POST", "/documents", { body: form });
    },
  };

  readonly drafts = {
    /** Create a draft; returns the call your wallet must send to submit it for review. */
    create: (type: AssetType, input: { fields: Record<string, unknown>; documentIds: string[] }) =>
      this.request<CallsResponse & { draft: { id: string } & Record<string, unknown>; next: string }>("POST", `/drafts/${type}`, { json: input }),
    /** Tell TradeChainX the submission transaction hash (optional; the indexer links it anyway). */
    recordTx: (draftId: string, txHash: string) => this.request<{ ok: true }>("POST", `/drafts/${draftId}/tx`, { json: { txHash } }),
    list: () => this.request<{ drafts: Record<string, unknown>[] }>("GET", "/drafts"),
  };

  readonly trade = {
    buy: (input: { listingId: string | number | bigint; amount?: string | number | bigint }) =>
      this.request<CallsResponse>("POST", "/trade/buy", { json: { listingId: String(input.listingId), amount: String(input.amount ?? 1) } }),
    list: (input: { assetType: AssetType; tokenId: string | number | bigint; amount?: string | number | bigint; pricePerUnit: string | number | bigint }) =>
      this.request<CallsResponse>("POST", "/trade/list", {
        json: { assetType: input.assetType, tokenId: String(input.tokenId), amount: String(input.amount ?? 1), pricePerUnit: String(input.pricePerUnit) },
      }),
    cancel: (listingId: string | number | bigint) => this.request<CallsResponse>("POST", "/trade/cancel", { json: { listingId: String(listingId) } }),
    subscribe: (input: { vault: string; shares: string | number | bigint }) =>
      this.request<CallsResponse>("POST", "/trade/subscribe", { json: { vault: input.vault, shares: String(input.shares) } }),
    settleLpo: (tokenId: string | number | bigint) => this.request<CallsResponse>("POST", "/trade/settle-lpo", { json: { tokenId: String(tokenId) } }),
  };

  readonly webhooks = {
    list: () => this.request<{ webhooks: { id: string; url: string; events: string[]; active: boolean }[] }>("GET", "/webhooks"),
    deliveries: (id: string) => this.request<{ deliveries: Record<string, unknown>[] }>("GET", `/webhooks/${id}/deliveries`),
  };
}

/** Turn {"$bigint": "123"} markers back into bigint so the args can go straight to viem/ethers. */
export function reviveArgs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reviveArgs);
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    if (typeof o.$bigint === "string" && Object.keys(o).length === 1) return BigInt(o.$bigint);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) out[k] = reviveArgs(v);
    return out;
  }
  return value;
}

export function reviveCalls(calls: PreparedCall[]): PreparedCall[] {
  return calls.map((c) => ({ ...c, args: reviveArgs(c.args) as unknown[] }));
}

// ---------------------------------------------------------------- webhooks

const enc = new TextEncoder();

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
  return Array.from(sig, (b) => b.toString(16).padStart(2, "0")).join("");
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Verify a TradeChainX webhook and return the parsed event. Throws if the signature is wrong or the
 * timestamp is outside the tolerance (replay protection).
 *
 * @param payload  the RAW request body string, exactly as received (don't re-serialise parsed JSON)
 * @param header   the value of the `TradeChainX-Signature` header
 * @param secret   your webhook signing secret (whsec_…)
 */
export async function verifyWebhook<T = Record<string, unknown>>(opts: {
  payload: string;
  header: string | null | undefined;
  secret: string;
  toleranceSeconds?: number;
  now?: number;
}): Promise<WebhookEvent<T>> {
  const { payload, header, secret } = opts;
  if (!header) throw new Error("Missing TradeChainX-Signature header");
  const parts = Object.fromEntries(
    header.split(",").map((p) => {
      const i = p.indexOf("=");
      return [p.slice(0, i).trim(), p.slice(i + 1).trim()];
    }),
  );
  const t = Number(parts.t);
  const v1 = parts.v1;
  if (!Number.isFinite(t) || !v1) throw new Error("Malformed TradeChainX-Signature header");
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - t) > (opts.toleranceSeconds ?? 300)) throw new Error("Webhook timestamp outside tolerance");
  const expected = await hmacHex(secret, `${t}.${payload}`);
  if (!safeEqual(expected, v1)) throw new Error("Invalid webhook signature");
  return JSON.parse(payload) as WebhookEvent<T>;
}
