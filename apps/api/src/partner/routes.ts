// Partner API v1 — mounted at /partner/v1 when PARTNER_API_ENABLED=true. Reference: docs/PARTNER_API.md.
//
// Principles:
//   * Server-to-server only (no CORS). Keys never belong in a browser.
//   * TradeChainX never signs for a partner. "issue" and "trade" endpoints return prepared contract
//     calls for the partner's OWN verified account wallet to sign and send; the contracts enforce
//     identity, tradability and review rules exactly as for the TradeChainX app.
//   * Everything a partner submits goes through the same reviewer queue (the review gate).
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import type { Address } from "viem";
import { db, schema } from "../db/client.ts";
import { env } from "../env.ts";
import { badRequest, notFound } from "../lib/errors.ts";
import { call } from "../lib/calls.ts";
import { contracts, usdc, ASSET_CONTRACT } from "../chain.ts";
import { assetView, draftsById, listingView } from "../routes/assets.ts";
import { offeringView } from "../routes/portfolio.ts";
import { createDraft, draftView, submissionView, assertIdentityCanSubmit } from "../routes/drafts.ts";
import { publicDoc, saveUploadedDocument } from "../routes/documents.ts";
import { partnerAuth, requireScope, requireVerifiedAccount } from "./auth.ts";
import { EVENT_TYPES } from "./events.ts";

const R = { config: { rateLimit: false } } as const; // partner keys have their own limits (auth.ts)
const addr = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform((s) => s.toLowerCase());
const uint = z.string().regex(/^\d+$/, "must be an integer string");
const ASSET_KEY = { "warehouse-receipt": "warehouseReceipt", lpo: "lpoToken", carbon: "carbonCredits" } as const;

export async function partnerRoutes(app: FastifyInstance) {
  app.addHook("onRequest", partnerAuth);

  // ------------------------------------------------------------------ account

  app.get("/me", R, async (req) => {
    const ctx = req.partner!;
    const [today] = await db
      .select({ requests: schema.apiUsage.requests })
      .from(schema.apiUsage)
      .where(and(eq(schema.apiUsage.apiKeyId, ctx.key.id), sql`${schema.apiUsage.day} = current_date`));
    return {
      partner: { id: ctx.partner.id, name: ctx.partner.name, referralCode: ctx.partner.referralCode },
      account: { walletAddress: ctx.account.walletAddress, verifiedBusiness: ctx.verified },
      key: {
        prefix: ctx.key.prefix,
        scopes: ctx.key.scopes,
        rateLimitPerMinute: ctx.key.rateLimitPerMinute,
        dailyQuota: ctx.key.dailyQuota,
        usedToday: today?.requests ?? 0,
      },
      chain: { chainId: env.CHAIN_ID, usdc: usdc.address, contracts: Object.fromEntries(Object.entries(contracts).map(([k, c]) => [k, c.address])) },
    };
  });

  app.get("/events", R, async () => ({ events: Object.entries(EVENT_TYPES).map(([type, description]) => ({ type, description })) }));

  // ------------------------------------------------------------------ read

  app.get("/offerings", R, async (req) => {
    requireScope(req, "read");
    const rows = await db.select().from(schema.xownOfferings).where(isNotNull(schema.xownOfferings.vault)).orderBy(desc(schema.xownOfferings.updatedBlock));
    const drafts = await draftsById(rows.map((r) => r.draftId));
    return { offerings: rows.map((o) => offeringView(o, drafts.get(o.draftId ?? "")?.fields)) };
  });

  app.get("/offerings/:vault", R, async (req) => {
    requireScope(req, "read");
    const { vault } = z.object({ vault: addr }).parse(req.params);
    const [o] = await db.select().from(schema.xownOfferings).where(eq(schema.xownOfferings.vault, vault)).limit(1);
    if (!o) throw notFound("Offering not found.");
    const drafts = await draftsById([o.draftId]);
    const [holders] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.xownHoldings).where(eq(schema.xownHoldings.vault, vault));
    return { offering: { ...offeringView(o, drafts.get(o.draftId ?? "")?.fields), holders: holders?.n ?? 0 } };
  });

  app.get("/assets", R, async (req) => {
    requireScope(req, "read");
    const q = z
      .object({
        type: z.enum(["warehouse-receipt", "lpo", "carbon"]).optional(),
        owner: addr.optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
        cursor: z.coerce.number().int().min(0).optional(), // issued_block of the last item
      })
      .parse(req.query);
    const rows = await db
      .select()
      .from(schema.assets)
      .where(
        and(
          q.type ? eq(schema.assets.assetType, q.type) : undefined,
          q.owner ? eq(schema.assets.owner, q.owner) : undefined,
          q.cursor !== undefined ? sql`${schema.assets.issuedBlock} < ${q.cursor}` : undefined,
        ),
      )
      .orderBy(desc(schema.assets.issuedBlock))
      .limit(q.limit);
    const drafts = await draftsById(rows.map((a) => a.draftId));
    return {
      assets: rows.map((a) => assetView(a, drafts.get(a.draftId ?? ""))),
      nextCursor: rows.length === q.limit ? rows[rows.length - 1]!.issuedBlock : null,
    };
  });

  app.get("/assets/:type/:id", R, async (req) => {
    requireScope(req, "read");
    const { type, id } = z.object({ type: z.enum(["warehouse-receipt", "lpo", "carbon"]), id: uint }).parse(req.params);
    const [a] = await db
      .select()
      .from(schema.assets)
      .where(and(eq(schema.assets.assetType, type), eq(schema.assets.tokenId, id)))
      .limit(1);
    if (!a) throw notFound("Asset not found.");
    const drafts = await draftsById([a.draftId]);
    return { asset: assetView(a, drafts.get(a.draftId ?? "")) };
  });

  app.get("/listings", R, async (req) => {
    requireScope(req, "read");
    const q = z
      .object({ type: z.enum(["warehouse-receipt", "lpo", "carbon"]).optional(), seller: addr.optional(), limit: z.coerce.number().int().min(1).max(100).default(50) })
      .parse(req.query);
    const rows = await db
      .select({ l: schema.listings, a: schema.assets })
      .from(schema.listings)
      .innerJoin(schema.assets, and(eq(schema.assets.assetType, schema.listings.assetType), eq(schema.assets.tokenId, schema.listings.tokenId)))
      .where(and(eq(schema.listings.active, true), q.type ? eq(schema.listings.assetType, q.type) : undefined, q.seller ? eq(schema.listings.seller, q.seller) : undefined))
      .orderBy(desc(schema.listings.createdBlock))
      .limit(q.limit);
    const drafts = await draftsById(rows.map((r) => r.a.draftId));
    return { listings: rows.map(({ l, a }) => ({ ...listingView(l), asset: assetView(a, drafts.get(a.draftId ?? ""), { listed: true }) })) };
  });

  app.get("/listings/:id", R, async (req) => {
    requireScope(req, "read");
    const { id } = z.object({ id: uint }).parse(req.params);
    const [row] = await db
      .select({ l: schema.listings, a: schema.assets })
      .from(schema.listings)
      .innerJoin(schema.assets, and(eq(schema.assets.assetType, schema.listings.assetType), eq(schema.assets.tokenId, schema.listings.tokenId)))
      .where(eq(schema.listings.listingId, id))
      .limit(1);
    if (!row) throw notFound("Listing not found.");
    const drafts = await draftsById([row.a.draftId]);
    return { listing: { ...listingView(row.l), asset: assetView(row.a, drafts.get(row.a.draftId ?? ""), { listed: row.l.active }) } };
  });

  // ------------------------------------------------------------------ issue (submit drafts for review)

  app.post("/documents", R, async (req) => {
    const ctx = requireVerifiedAccount(requireScope(req, "issue"));
    return { document: publicDoc(await saveUploadedDocument(req, ctx.account.id)) };
  });

  app.post("/drafts/:type", R, async (req) => {
    const ctx = requireVerifiedAccount(requireScope(req, "issue"));
    const { type } = z.object({ type: z.enum(["warehouse-receipt", "lpo", "carbon"]) }).parse(req.params);
    await assertIdentityCanSubmit(ctx.account, type);
    const body = z.object({ fields: z.record(z.unknown()), documentIds: z.array(z.string().uuid()).min(1).max(20) }).parse(req.body);
    const { draft, call: c } = await createDraft(ctx.account, type, body, { partnerId: ctx.partner.id, apiKeyId: ctx.key.id });
    return {
      draft,
      calls: [c],
      signer: ctx.account.walletAddress,
      next: "Sign and send `calls` from the signer wallet, then POST /drafts/{id}/tx with the transaction hash. You'll get submission.* webhooks as it moves through review.",
    };
  });

  app.post("/drafts/:id/tx", R, async (req) => {
    const ctx = requireScope(req, "issue");
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { txHash } = z.object({ txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/) }).parse(req.body);
    const [d] = await db.select().from(schema.drafts).where(and(eq(schema.drafts.id, id), eq(schema.drafts.partnerId, ctx.partner.id))).limit(1);
    if (!d) throw notFound("Draft not found.");
    await db.update(schema.drafts).set({ txHash, updatedAt: new Date() }).where(eq(schema.drafts.id, id));
    return { ok: true };
  });

  app.get("/drafts", R, async (req) => {
    const ctx = requireScope(req, "issue");
    const rows = await db
      .select({ d: schema.drafts, s: schema.submissions })
      .from(schema.drafts)
      .leftJoin(schema.submissions, eq(schema.submissions.draftId, schema.drafts.id))
      .where(eq(schema.drafts.partnerId, ctx.partner.id))
      .orderBy(desc(schema.drafts.createdAt))
      .limit(200);
    return { drafts: rows.map(({ d, s }) => ({ ...draftView(d), submission: s ? submissionView(s) : null })) };
  });

  // ------------------------------------------------------------------ trade (prepared calls)

  app.post("/trade/buy", R, async (req) => {
    const ctx = requireVerifiedAccount(requireScope(req, "trade"));
    const b = z.object({ listingId: uint, amount: uint.default("1") }).parse(req.body);
    const [l] = await db.select().from(schema.listings).where(eq(schema.listings.listingId, b.listingId)).limit(1);
    if (!l || !l.active) throw notFound("Listing not found or no longer active.");
    if (BigInt(b.amount) === 0n || BigInt(b.amount) > BigInt(l.remaining)) throw badRequest(`Amount must be between 1 and ${l.remaining}.`);
    if (l.seller === ctx.account.walletAddress.toLowerCase()) throw badRequest("You can't buy your own listing.");
    const total = BigInt(l.pricePerUnit) * BigInt(b.amount);
    return {
      signer: ctx.account.walletAddress,
      totalUsdc: total.toString(),
      calls: [
        call("usdc", usdc.address, "approve", [contracts.marketplace.address, total], "Allow the payment"),
        call("marketplace", contracts.marketplace.address, "buy", [BigInt(b.listingId), BigInt(b.amount), total], "Complete the purchase"),
      ],
    };
  });

  app.post("/trade/list", R, async (req) => {
    const ctx = requireVerifiedAccount(requireScope(req, "trade"));
    const b = z.object({ assetType: z.enum(["warehouse-receipt", "lpo", "carbon"]), tokenId: uint, amount: uint.default("1"), pricePerUnit: uint }).parse(req.body);
    const token = ASSET_CONTRACT[b.assetType];
    const key = ASSET_KEY[b.assetType];
    const permit =
      b.assetType === "carbon"
        ? call(key, token, "setApprovalForAll", [contracts.marketplace.address, true], "Allow the marketplace to hold your credits")
        : call(key, token, "approve", [contracts.marketplace.address, BigInt(b.tokenId)], "Allow the marketplace to hold this asset");
    return {
      signer: ctx.account.walletAddress,
      calls: [permit, call("marketplace", contracts.marketplace.address, "list", [token, BigInt(b.tokenId), BigInt(b.amount), BigInt(b.pricePerUnit)], "Put it up for sale")],
    };
  });

  app.post("/trade/cancel", R, async (req) => {
    const ctx = requireVerifiedAccount(requireScope(req, "trade"));
    const b = z.object({ listingId: uint }).parse(req.body);
    return { signer: ctx.account.walletAddress, calls: [call("marketplace", contracts.marketplace.address, "cancel", [BigInt(b.listingId)], "Take it off the market")] };
  });

  app.post("/trade/subscribe", R, async (req) => {
    const ctx = requireVerifiedAccount(requireScope(req, "trade"));
    const b = z.object({ vault: addr, shares: uint }).parse(req.body);
    const [o] = await db.select().from(schema.xownOfferings).where(eq(schema.xownOfferings.vault, b.vault)).limit(1);
    if (!o) throw notFound("Offering not found.");
    const cost = BigInt(o.pricePerShare) * BigInt(b.shares);
    return {
      signer: ctx.account.walletAddress,
      totalUsdc: cost.toString(),
      calls: [
        call("usdc", usdc.address, "approve", [b.vault as Address, cost], "Allow the payment"),
        call("xownVault", b.vault as Address, "subscribe", [BigInt(b.shares)], "Buy shares"),
      ],
    };
  });

  app.post("/trade/settle-lpo", R, async (req) => {
    const ctx = requireVerifiedAccount(requireScope(req, "trade"));
    const b = z.object({ tokenId: uint }).parse(req.body);
    const [a] = await db
      .select()
      .from(schema.assets)
      .where(and(eq(schema.assets.assetType, "lpo"), eq(schema.assets.tokenId, b.tokenId)))
      .limit(1);
    if (!a || a.burnedAs) throw notFound("Purchase order not found or already closed.");
    const face = BigInt((a.terms as { faceValue?: string }).faceValue ?? "0");
    return {
      signer: ctx.account.walletAddress,
      totalUsdc: face.toString(),
      calls: [
        call("usdc", usdc.address, "approve", [contracts.lpoToken.address, face], "Allow the payment"),
        call("lpoToken", contracts.lpoToken.address, "settle", [BigInt(b.tokenId)], "Pay the purchase order"),
      ],
    };
  });

  // ------------------------------------------------------------------ webhooks (self-service view)

  app.get("/webhooks", R, async (req) => {
    const ctx = requireScope(req, "read");
    const hooks = await db.select().from(schema.webhooks).where(eq(schema.webhooks.partnerId, ctx.partner.id));
    return { webhooks: hooks.map((h) => ({ id: h.id, url: h.url, events: h.events, active: h.active })) };
  });

  app.get("/webhooks/:id/deliveries", R, async (req) => {
    const ctx = requireScope(req, "read");
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const [h] = await db.select().from(schema.webhooks).where(and(eq(schema.webhooks.id, id), eq(schema.webhooks.partnerId, ctx.partner.id))).limit(1);
    if (!h) throw notFound();
    const rows = await db.select().from(schema.webhookDeliveries).where(eq(schema.webhookDeliveries.webhookId, id)).orderBy(desc(schema.webhookDeliveries.createdAt)).limit(100);
    return {
      deliveries: rows.map((d) => ({
        id: d.id,
        eventId: d.eventId,
        type: d.eventType,
        status: d.status,
        attempts: d.attempts,
        lastStatusCode: d.lastStatusCode,
        lastError: d.lastError,
        createdAt: d.createdAt,
        deliveredAt: d.deliveredAt,
      })),
    };
  });
}
