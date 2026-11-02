// API keys and webhook secrets for partners.
//
// Key format: tcx_<env>_<prefix>_<secret>
//   env    = "live" in production, "test" otherwise (so a test key can never be mistaken for live)
//   prefix = 8 hex chars, stored in clear, shown in the admin UI and logs to identify the key
//   secret = 32 random bytes, base64url
// Only sha256(full key) is stored. The key is shown once, at creation.
import { createHash, createHmac, randomBytes } from "node:crypto";
import { env } from "../env.ts";

export const SCOPES = ["read", "issue", "trade"] as const;
export type Scope = (typeof SCOPES)[number];

export function generateApiKey(): { key: string; prefix: string; hash: string } {
  const prefix = randomBytes(4).toString("hex");
  const secret = randomBytes(32).toString("base64url");
  const key = `tcx_${env.NODE_ENV === "production" ? "live" : "test"}_${prefix}_${secret}`;
  return { key, prefix, hash: hashApiKey(key) };
}

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export function parseApiKey(key: string): { prefix: string } | null {
  const m = /^tcx_(live|test)_([0-9a-f]{8})_[A-Za-z0-9_-]{43}$/.exec(key);
  return m ? { prefix: m[2]! } : null;
}

/** The signing secret for a webhook. Derived, never stored; bump secret_version to rotate. */
export function webhookSecret(webhookId: string, version: number): string {
  const pepper = env.WEBHOOK_SECRET_PEPPER;
  if (!pepper) throw new Error("WEBHOOK_SECRET_PEPPER is not set");
  return `whsec_${createHmac("sha256", pepper).update(`${webhookId}:${version}`).digest("base64url")}`;
}

/**
 * Signature header value: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>.
 * Partners verify with the SDK's verifyWebhook() (packages/sdk) or the snippet in docs/PARTNER_API.md.
 */
export function signWebhook(secret: string, body: string, timestamp = Math.floor(Date.now() / 1000)): string {
  const v1 = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return `t=${timestamp},v1=${v1}`;
}

export function referralCode(): string {
  return randomBytes(5).toString("base64url").replace(/[-_]/g, "x").slice(0, 7).toLowerCase();
}
