// Bearer-key authentication, scopes, rate limit and daily quota for /partner/v1.
import type { FastifyReply, FastifyRequest } from "fastify";
import { and, eq, isNull, sql } from "drizzle-orm";
import { Tier } from "@tradechainx/shared";
import { db, schema } from "../db/client.ts";
import { HttpError } from "../lib/errors.ts";
import { identityIsValid } from "../services/profile.ts";
import { hashApiKey, parseApiKey, type Scope } from "./keys.ts";

export type PartnerContext = {
  partner: typeof schema.partners.$inferSelect;
  key: typeof schema.apiKeys.$inferSelect;
  account: typeof schema.users.$inferSelect;
  /** True when the account wallet holds a valid Business/Institutional identity on-chain. */
  verified: boolean;
};

declare module "fastify" {
  interface FastifyRequest {
    partner?: PartnerContext;
  }
}

// Per-key fixed one-minute windows, in memory. Fine for one API instance; behind several replicas
// each enforces its own share — put Redis behind this if you scale out.
const windows = new Map<string, { start: number; count: number }>();

function rateLimited(keyId: string, perMinute: number, reply: FastifyReply): boolean {
  const now = Date.now();
  const w = windows.get(keyId);
  if (!w || now - w.start >= 60_000) {
    windows.set(keyId, { start: now, count: 1 });
    reply.header("X-RateLimit-Limit", perMinute).header("X-RateLimit-Remaining", perMinute - 1);
    return false;
  }
  w.count++;
  const remaining = Math.max(0, perMinute - w.count);
  reply.header("X-RateLimit-Limit", perMinute).header("X-RateLimit-Remaining", remaining);
  if (w.count > perMinute) {
    reply.header("Retry-After", Math.ceil((60_000 - (now - w.start)) / 1000));
    return true;
  }
  return false;
}

const err = (status: number, code: string, message: string) => new HttpError(status, code, message);

export async function partnerAuth(req: FastifyRequest, reply: FastifyReply) {
  const header = req.headers.authorization ?? "";
  const key = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!key || !parseApiKey(key)) throw err(401, "invalid_api_key", "Send your API key as: Authorization: Bearer tcx_…");

  const [row] = await db
    .select({ key: schema.apiKeys, partner: schema.partners, account: schema.users })
    .from(schema.apiKeys)
    .innerJoin(schema.partners, eq(schema.partners.id, schema.apiKeys.partnerId))
    .innerJoin(schema.users, eq(schema.users.id, schema.partners.accountUserId))
    .where(and(eq(schema.apiKeys.keyHash, hashApiKey(key)), isNull(schema.apiKeys.revokedAt)))
    .limit(1);
  if (!row) throw err(401, "invalid_api_key", "This API key is not valid or has been revoked.");
  if (row.partner.status !== "active") throw err(403, "partner_suspended", "This partner account is suspended. Contact TradeChainX.");

  if (rateLimited(row.key.id, row.key.rateLimitPerMinute, reply)) {
    throw err(429, "rate_limited", `Rate limit is ${row.key.rateLimitPerMinute} requests per minute for this key.`);
  }

  const [usage] = await db
    .insert(schema.apiUsage)
    .values({ apiKeyId: row.key.id, day: sql`current_date` as unknown as string, requests: 1 })
    .onConflictDoUpdate({ target: [schema.apiUsage.apiKeyId, schema.apiUsage.day], set: { requests: sql`${schema.apiUsage.requests} + 1` } })
    .returning({ requests: schema.apiUsage.requests });
  if ((usage?.requests ?? 0) > row.key.dailyQuota) {
    throw err(429, "quota_exceeded", `Daily quota of ${row.key.dailyQuota} requests reached. It resets at 00:00 UTC.`);
  }
  if (!row.key.lastUsedAt || Date.now() - row.key.lastUsedAt.getTime() > 60_000) {
    await db.update(schema.apiKeys).set({ lastUsedAt: new Date() }).where(eq(schema.apiKeys.id, row.key.id));
  }

  let verified = false;
  if (row.account.walletAddress) {
    const [id] = await db.select().from(schema.identities).where(eq(schema.identities.address, row.account.walletAddress)).limit(1);
    verified = identityIsValid(id) && (id!.tier === Tier.Business || id!.tier === Tier.Institutional);
  }
  req.partner = { partner: row.partner, key: row.key, account: row.account, verified };
}

export function requireScope(req: FastifyRequest, scope: Scope): PartnerContext {
  const ctx = req.partner;
  if (!ctx) throw err(401, "invalid_api_key", "Missing API key.");
  if (!ctx.key.scopes.includes(scope)) throw err(403, "insufficient_scope", `This key doesn't have the "${scope}" scope.`);
  return ctx;
}

/** Issue and trade need the partner's own account to be a currently verified business. */
export function requireVerifiedAccount(ctx: PartnerContext): PartnerContext & { account: { walletAddress: string } } {
  if (!ctx.account.walletAddress) throw err(409, "wallet_required", "The partner account has no wallet yet. Sign in to TradeChainX once to create it.");
  if (!ctx.verified) {
    throw err(403, "not_verified", "The partner account must be a verified business on TradeChainX (and not expired or frozen).");
  }
  return ctx as PartnerContext & { account: { walletAddress: string } };
}
