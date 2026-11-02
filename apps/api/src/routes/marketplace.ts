import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { db, schema } from "../db/client.ts";
import { notFound } from "../lib/errors.ts";
import { assetView, draftsById, listingView } from "./assets.ts";

export async function marketplaceRoutes(app: FastifyInstance) {
  app.get("/marketplace/listings", async (req) => {
    const q = z
      .object({
        type: z.enum(["warehouse-receipt", "lpo", "carbon"]).optional(),
        seller: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(60),
      })
      .parse(req.query);

    const rows = await db
      .select({ l: schema.listings, a: schema.assets })
      .from(schema.listings)
      .innerJoin(
        schema.assets,
        and(eq(schema.assets.assetType, schema.listings.assetType), eq(schema.assets.tokenId, schema.listings.tokenId)),
      )
      .where(
        and(
          eq(schema.listings.active, true),
          q.type ? eq(schema.listings.assetType, q.type) : undefined,
          q.seller ? eq(schema.listings.seller, q.seller.toLowerCase()) : undefined,
        ),
      )
      .orderBy(desc(schema.listings.createdBlock))
      .limit(q.limit);
    const drafts = await draftsById(rows.map((r) => r.a.draftId));
    return {
      listings: rows.map(({ l, a }) => ({ ...listingView(l), asset: assetView(a, drafts.get(a.draftId ?? ""), { listed: true }) })),
    };
  });

  app.get("/marketplace/listings/:id", async (req) => {
    const { id } = z.object({ id: z.string().regex(/^\d+$/) }).parse(req.params);
    const [row] = await db
      .select({ l: schema.listings, a: schema.assets })
      .from(schema.listings)
      .innerJoin(
        schema.assets,
        and(eq(schema.assets.assetType, schema.listings.assetType), eq(schema.assets.tokenId, schema.listings.tokenId)),
      )
      .where(eq(schema.listings.listingId, id))
      .limit(1);
    if (!row) throw notFound("Listing not found.");
    const drafts = await draftsById([row.a.draftId]);
    const trades = await db.select().from(schema.trades).where(eq(schema.trades.listingId, id)).orderBy(desc(schema.trades.blockTime));
    return { listing: { ...listingView(row.l), asset: assetView(row.a, drafts.get(row.a.draftId ?? ""), { listed: row.l.active }) }, trades };
  });

  /** Headline numbers for the public site — only shown once there's real activity (PRD §6.2). */
  app.get("/marketplace/stats", async () => {
    const since = new Date(Date.now() - 30 * 86_400_000);
    const [vol] = await db
      .select({ volume: sql<string>`coalesce(sum(${schema.trades.total}), 0)::text`, trades: sql<number>`count(*)::int` })
      .from(schema.trades)
      .where(gte(schema.trades.blockTime, since));
    const [issued] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.assets);
    const [active] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.listings).where(eq(schema.listings.active, true));
    return { volume30d: vol?.volume ?? "0", trades30d: vol?.trades ?? 0, assetsIssued: issued?.n ?? 0, activeListings: active?.n ?? 0 };
  });
}
