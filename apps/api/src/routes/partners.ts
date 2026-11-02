// Admin management of partners, API keys and webhooks (Super Admin only).
// A partner must be linked to a TradeChainX account that is a verified business on-chain.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { Tier } from "@tradechainx/shared";
import { db, schema } from "../db/client.ts";
import { env } from "../env.ts";
import { requireAdmin } from "../plugins/auth.ts";
import { badRequest, conflict, notFound } from "../lib/errors.ts";
import { identityIsValid } from "../services/profile.ts";
import { generateApiKey, referralCode, SCOPES, webhookSecret } from "../partner/keys.ts";
import { EVENT_TYPES, enqueueTestEvent } from "../partner/events.ts";
import { assertPublicUrl } from "../partner/safeUrl.ts";

const eventList = z.array(z.string()).min(1).refine((a) => a.every((e) => e === "*" || e in EVENT_TYPES), "unknown event type");

async function assertVerifiedBusiness(user: typeof schema.users.$inferSelect) {
  if (!user.walletAddress) throw badRequest("That account hasn't set up its wallet yet — they need to sign in once.");
  const [id] = await db.select().from(schema.identities).where(eq(schema.identities.address, user.walletAddress)).limit(1);
  if (!identityIsValid(id) || (id!.tier !== Tier.Business && id!.tier !== Tier.Institutional)) {
    throw badRequest("Partners must be verified businesses. Approve their business verification first.");
  }
}

export async function partnerAdminRoutes(app: FastifyInstance) {
  app.get("/admin/partners", async (req) => {
    requireAdmin(req, "super_admin");
    const since = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
    const rows = await db
      .select({
        p: schema.partners,
        email: schema.users.email,
        wallet: schema.users.walletAddress,
        keys: sql<number>`(select count(*)::int from api_keys k where k.partner_id = ${schema.partners.id} and k.revoked_at is null)`,
        hooks: sql<number>`(select count(*)::int from webhooks w where w.partner_id = ${schema.partners.id} and w.active)`,
        requests7d: sql<number>`(select coalesce(sum(u.requests),0)::int from api_usage u join api_keys k on k.id = u.api_key_id where k.partner_id = ${schema.partners.id} and u.day >= ${since}::date)`,
        drafts: sql<number>`(select count(*)::int from drafts d where d.partner_id = ${schema.partners.id})`,
      })
      .from(schema.partners)
      .innerJoin(schema.users, eq(schema.users.id, schema.partners.accountUserId))
      .orderBy(desc(schema.partners.createdAt));
    return {
      enabled: env.PARTNER_API_ENABLED,
      partners: rows.map((r) => ({ ...r.p, accountEmail: r.email, accountWallet: r.wallet, activeKeys: r.keys, activeWebhooks: r.hooks, requests7d: r.requests7d, drafts: r.drafts })),
      scopes: SCOPES,
      events: Object.entries(EVENT_TYPES).map(([type, description]) => ({ type, description })),
    };
  });

  app.post("/admin/partners", async (req) => {
    const admin = requireAdmin(req, "super_admin");
    const b = z
      .object({
        name: z.string().trim().min(2).max(120),
        accountEmail: z.string().email().transform((s) => s.toLowerCase()),
        contactEmail: z.string().email(),
        website: z.string().url().optional().or(z.literal("")),
      })
      .parse(req.body);
    const [user] = await db.select().from(schema.users).where(eq(schema.users.email, b.accountEmail)).limit(1);
    if (!user) throw notFound("No TradeChainX account with that email. The business must sign up and get verified first.");
    await assertVerifiedBusiness(user);
    const [exists] = await db.select().from(schema.partners).where(eq(schema.partners.accountUserId, user.id)).limit(1);
    if (exists) throw conflict("That account is already a partner.");
    const [p] = await db
      .insert(schema.partners)
      .values({ name: b.name, accountUserId: user.id, contactEmail: b.contactEmail, website: b.website || null, referralCode: referralCode(), createdBy: admin.id })
      .returning();
    return { partner: p };
  });

  app.get("/admin/partners/:id", async (req) => {
    requireAdmin(req, "super_admin");
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const [p] = await db.select().from(schema.partners).where(eq(schema.partners.id, id)).limit(1);
    if (!p) throw notFound();
    const [account] = await db.select().from(schema.users).where(eq(schema.users.id, p.accountUserId)).limit(1);
    const keys = await db.select().from(schema.apiKeys).where(eq(schema.apiKeys.partnerId, id)).orderBy(desc(schema.apiKeys.createdAt));
    const hooks = await db.select().from(schema.webhooks).where(eq(schema.webhooks.partnerId, id));
    const since = new Date(Date.now() - 14 * 86_400_000).toISOString().slice(0, 10);
    const usage = await db
      .select({ day: schema.apiUsage.day, requests: sql<number>`sum(${schema.apiUsage.requests})::int` })
      .from(schema.apiUsage)
      .innerJoin(schema.apiKeys, eq(schema.apiKeys.id, schema.apiUsage.apiKeyId))
      .where(and(eq(schema.apiKeys.partnerId, id), gte(schema.apiUsage.day, since)))
      .groupBy(schema.apiUsage.day)
      .orderBy(schema.apiUsage.day);
    const deliveries = hooks.length
      ? await db
          .select({ d: schema.webhookDeliveries })
          .from(schema.webhookDeliveries)
          .innerJoin(schema.webhooks, eq(schema.webhooks.id, schema.webhookDeliveries.webhookId))
          .where(eq(schema.webhooks.partnerId, id))
          .orderBy(desc(schema.webhookDeliveries.createdAt))
          .limit(50)
      : [];
    const drafts = await db
      .select({ id: schema.drafts.id, assetType: schema.drafts.assetType, createdAt: schema.drafts.createdAt, submissionId: schema.drafts.submissionId })
      .from(schema.drafts)
      .where(eq(schema.drafts.partnerId, id))
      .orderBy(desc(schema.drafts.createdAt))
      .limit(50);
    return {
      partner: p,
      account: account ? { email: account.email, walletAddress: account.walletAddress, orgName: account.orgName } : null,
      keys: keys.map(({ keyHash: _h, ...k }) => k),
      webhooks: hooks,
      usage,
      deliveries: deliveries.map(({ d }) => ({ ...d, payload: undefined })),
      drafts,
    };
  });

  app.patch("/admin/partners/:id", async (req) => {
    requireAdmin(req, "super_admin");
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({ status: z.enum(["active", "suspended"]) }).parse(req.body);
    if (b.status === "active") {
      const [p] = await db.select().from(schema.partners).where(eq(schema.partners.id, id)).limit(1);
      if (!p) throw notFound();
      const [user] = await db.select().from(schema.users).where(eq(schema.users.id, p.accountUserId)).limit(1);
      await assertVerifiedBusiness(user!);
    }
    const [p] = await db.update(schema.partners).set({ status: b.status, updatedAt: new Date() }).where(eq(schema.partners.id, id)).returning();
    if (!p) throw notFound();
    return { partner: p };
  });

  /** Create a key. The full key is returned ONCE — it can't be shown again. */
  app.post("/admin/partners/:id/keys", async (req) => {
    const admin = requireAdmin(req, "super_admin");
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z
      .object({
        name: z.string().trim().min(1).max(80),
        scopes: z.array(z.enum(SCOPES)).min(1),
        rateLimitPerMinute: z.number().int().min(1).max(6000).default(60),
        dailyQuota: z.number().int().min(1).max(10_000_000).default(10_000),
      })
      .parse(req.body);
    const [p] = await db.select().from(schema.partners).where(eq(schema.partners.id, id)).limit(1);
    if (!p) throw notFound();
    const { key, prefix, hash } = generateApiKey();
    const [row] = await db
      .insert(schema.apiKeys)
      .values({ partnerId: id, name: b.name, prefix, keyHash: hash, scopes: [...new Set(b.scopes)], rateLimitPerMinute: b.rateLimitPerMinute, dailyQuota: b.dailyQuota, createdBy: admin.id })
      .returning();
    const { keyHash: _h, ...safe } = row!;
    return { key, apiKey: safe };
  });

  app.post("/admin/partners/:id/keys/:keyId/revoke", async (req) => {
    requireAdmin(req, "super_admin");
    const { id, keyId } = z.object({ id: z.string().uuid(), keyId: z.string().uuid() }).parse(req.params);
    await db.update(schema.apiKeys).set({ revokedAt: new Date() }).where(and(eq(schema.apiKeys.id, keyId), eq(schema.apiKeys.partnerId, id)));
    return { ok: true };
  });

  /** Add a webhook. The signing secret is returned ONCE. */
  app.post("/admin/partners/:id/webhooks", async (req) => {
    requireAdmin(req, "super_admin");
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({ url: z.string(), events: eventList }).parse(req.body);
    try {
      await assertPublicUrl(b.url);
    } catch (e) {
      throw badRequest((e as Error).message);
    }
    if (!env.WEBHOOK_SECRET_PEPPER) throw badRequest("Set WEBHOOK_SECRET_PEPPER on the API before adding webhooks.");
    const [h] = await db.insert(schema.webhooks).values({ partnerId: id, url: b.url, events: b.events }).returning();
    return { webhook: h, secret: webhookSecret(h!.id, h!.secretVersion) };
  });

  app.patch("/admin/webhooks/:id", async (req) => {
    requireAdmin(req, "super_admin");
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({ active: z.boolean().optional(), events: eventList.optional() }).parse(req.body);
    const [h] = await db.update(schema.webhooks).set(b).where(eq(schema.webhooks.id, id)).returning();
    if (!h) throw notFound();
    return { webhook: h };
  });

  app.post("/admin/webhooks/:id/rotate", async (req) => {
    requireAdmin(req, "super_admin");
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const [h] = await db
      .update(schema.webhooks)
      .set({ secretVersion: sql`${schema.webhooks.secretVersion} + 1` })
      .where(eq(schema.webhooks.id, id))
      .returning();
    if (!h) throw notFound();
    return { webhook: h, secret: webhookSecret(h.id, h.secretVersion) };
  });

  app.post("/admin/webhooks/:id/test", async (req) => {
    requireAdmin(req, "super_admin");
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return { eventId: await enqueueTestEvent(id) };
  });

  app.post("/admin/webhook-deliveries/:id/retry", async (req) => {
    requireAdmin(req, "super_admin");
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    await db
      .update(schema.webhookDeliveries)
      .set({ status: "pending", nextAttemptAt: new Date(), attempts: 0 })
      .where(eq(schema.webhookDeliveries.id, id));
    return { ok: true };
  });
}
