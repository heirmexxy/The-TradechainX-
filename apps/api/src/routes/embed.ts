// Public data for embeddable widgets (apps/web/public/embed.js) — read-only, cacheable, CORS "*".
// Widgets never take payment on the partner's site: the buy button opens TradeChainX, where the
// buyer signs in, is verified, and completes the purchase. The partner's referral code travels along.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, desc, eq, isNotNull } from "drizzle-orm";
import { formatUsdc } from "@tradechainx/shared";
import { db, schema } from "../db/client.ts";
import { env } from "../env.ts";
import { notFound } from "../lib/errors.ts";
import { requireUser } from "../plugins/auth.ts";
import { assetView, draftsById } from "./assets.ts";
import { publicFields } from "../services/public.ts";

const webUrl = () => (env.PUBLIC_WEB_URL || env.WEB_ORIGIN).replace(/\/$/, "");
const refParam = z.string().regex(/^[a-z0-9]{4,16}$/).optional();

async function activeRef(ref: string | undefined): Promise<string | undefined> {
  if (!ref) return undefined;
  const [p] = await db.select({ status: schema.partners.status }).from(schema.partners).where(eq(schema.partners.referralCode, ref)).limit(1);
  return p?.status === "active" ? ref : undefined;
}

const withRef = (url: string, ref?: string) => (ref ? `${url}?ref=${ref}` : url);

const VAULT_STATE = ["fundraising", "active", "failed", "dissolved"] as const;

function offeringCard(o: typeof schema.xownOfferings.$inferSelect, fields: Record<string, unknown> | undefined, ref?: string) {
  const f = publicFields("xown", fields);
  const sold = BigInt(o.sharesSold);
  const max = BigInt(o.maxShares);
  return {
    kind: "xown-offering",
    vault: o.vault,
    name: o.name,
    symbol: o.symbol,
    description: typeof f.description === "string" ? f.description.slice(0, 240) : null,
    equipmentType: (f.equipmentType as string | undefined) ?? null,
    location: (f.location as string | undefined) ?? null,
    expectedAnnualYieldPct: (f.expectedAnnualYieldPct as number | undefined) ?? null,
    pricePerShareUsdc: formatUsdc(BigInt(o.pricePerShare)),
    sharesSold: sold.toString(),
    maxShares: max.toString(),
    percentFunded: max === 0n ? 0 : Number((sold * 1000n) / max) / 10,
    deadline: o.deadline,
    state: o.vaultState === null ? "pending" : VAULT_STATE[o.vaultState] ?? "unknown",
    url: withRef(`${webUrl()}/xown/${o.vault}`, ref),
  };
}

export async function embedRoutes(app: FastifyInstance) {
  app.addHook("onSend", async (req, reply) => {
    if (req.method === "GET" && reply.statusCode === 200) reply.header("Cache-Control", "public, max-age=30, stale-while-revalidate=120");
  });

  app.get("/embed/v1/offerings", async (req) => {
    const { ref: rawRef, limit } = z.object({ ref: refParam, limit: z.coerce.number().int().min(1).max(24).default(6) }).parse(req.query);
    const ref = await activeRef(rawRef);
    const rows = await db
      .select()
      .from(schema.xownOfferings)
      .where(and(isNotNull(schema.xownOfferings.vault), eq(schema.xownOfferings.vaultState, 0)))
      .orderBy(desc(schema.xownOfferings.updatedBlock))
      .limit(limit);
    const drafts = await draftsById(rows.map((r) => r.draftId));
    return { offerings: rows.map((o) => offeringCard(o, drafts.get(o.draftId ?? "")?.fields, ref)) };
  });

  app.get("/embed/v1/offerings/:vault", async (req) => {
    const { vault } = z.object({ vault: z.string().regex(/^0x[0-9a-fA-F]{40}$/) }).parse(req.params);
    const ref = await activeRef(z.object({ ref: refParam }).parse(req.query).ref);
    const [o] = await db.select().from(schema.xownOfferings).where(eq(schema.xownOfferings.vault, vault.toLowerCase())).limit(1);
    if (!o) throw notFound("Offering not found.");
    const drafts = await draftsById([o.draftId]);
    return { offering: offeringCard(o, drafts.get(o.draftId ?? "")?.fields, ref) };
  });

  app.get("/embed/v1/listings/:id", async (req) => {
    const { id } = z.object({ id: z.string().regex(/^\d+$/) }).parse(req.params);
    const ref = await activeRef(z.object({ ref: refParam }).parse(req.query).ref);
    const [row] = await db
      .select({ l: schema.listings, a: schema.assets })
      .from(schema.listings)
      .innerJoin(schema.assets, and(eq(schema.assets.assetType, schema.listings.assetType), eq(schema.assets.tokenId, schema.listings.tokenId)))
      .where(eq(schema.listings.listingId, id))
      .limit(1);
    if (!row) throw notFound("Listing not found.");
    const drafts = await draftsById([row.a.draftId]);
    const view = assetView(row.a, drafts.get(row.a.draftId ?? ""), { listed: row.l.active });
    return {
      listing: {
        kind: "listing",
        listingId: row.l.listingId,
        assetType: row.l.assetType,
        title: view.title,
        status: row.l.active ? "for_sale" : "closed",
        pricePerUnitUsdc: formatUsdc(BigInt(row.l.pricePerUnit)),
        remaining: row.l.remaining,
        url: withRef(`${webUrl()}/marketplace/${row.l.listingId}`, ref),
      },
    };
  });

  /** The web app reports a completed purchase that arrived via a partner link (for attribution). */
  app.post("/referrals", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req) => {
    const user = requireUser(req);
    const b = z
      .object({
        ref: z.string().regex(/^[a-z0-9]{4,16}$/),
        targetType: z.enum(["listing", "xown"]),
        targetId: z.string().max(64),
        txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional(),
      })
      .parse(req.body);
    const [p] = await db.select().from(schema.partners).where(eq(schema.partners.referralCode, b.ref)).limit(1);
    if (!p || p.status !== "active") return { ok: true, recorded: false };
    await db.insert(schema.referrals).values({ partnerId: p.id, userId: user.id, targetType: b.targetType, targetId: b.targetId, txHash: b.txHash ?? null });
    return { ok: true, recorded: true };
  });
}
