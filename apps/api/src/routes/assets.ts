import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  resolveAssetStatus,
  fromBytes32Code,
  humanizeCode,
  ASSET_TYPE_LABEL,
  formatUsdc,
  type AssetType,
} from "@tradechainx/shared";
import { db, schema } from "../db/client.ts";
import { notFound } from "../lib/errors.ts";
import { publicFields } from "../services/public.ts";
import { explorerTxUrl } from "../chain.ts";
import { nowSec } from "../lib/util.ts";

type AssetRow = typeof schema.assets.$inferSelect;
type DraftRow = typeof schema.drafts.$inferSelect;

/** Human title for an asset, e.g. "Maize · Grade 1 · 60,000 kg". */
export function assetTitle(a: AssetRow, fields: Record<string, unknown>): string {
  const t = a.terms as Record<string, string>;
  if (a.assetType === "warehouse-receipt") {
    const qty = Number(t.quantity ?? 0).toLocaleString("en-US");
    return `${humanizeCode(fromBytes32Code(t.commodity ?? ""))} · ${humanizeCode(fromBytes32Code(t.grade ?? ""))} · ${qty} ${fields.unit ?? "kg"}`;
  }
  if (a.assetType === "lpo") {
    const buyer = fields.buyerName ? ` from ${fields.buyerName}` : "";
    return `${formatUsdc(BigInt(t.faceValue ?? "0"))} USDC purchase order${buyer}`;
  }
  if (a.assetType === "carbon") {
    const name = (fields.projectName as string | undefined) ?? humanizeCode(fromBytes32Code(t.registry ?? ""));
    return `${name} · vintage ${t.vintage}`;
  }
  return ASSET_TYPE_LABEL[a.assetType as AssetType] ?? "Asset";
}

export function assetView(a: AssetRow, draft: DraftRow | undefined, opts: { listed?: boolean } = {}) {
  const fields = publicFields(a.assetType, draft?.fields);
  const status = resolveAssetStatus({
    burnedAs: a.burnedAs ?? undefined,
    suspended: a.suspended,
    expiresAt: a.expiresAt ?? undefined,
    now: nowSec(),
    pendingChange: !!a.pendingRequest,
    pledged: !!a.lien,
    listed: opts.listed,
  });
  return {
    assetType: a.assetType,
    tokenId: a.tokenId,
    title: assetTitle(a, fields),
    status,
    owner: a.owner,
    originator: a.originator,
    terms: a.terms,
    details: fields,
    expiresAt: a.expiresAt,
    lien: a.lien,
    pendingRequest: a.pendingRequest,
    totalSupply: a.totalSupply,
    retired: a.retired,
    suspended: a.suspended,
  };
}

export async function draftsById(ids: (string | null)[]) {
  const clean = [...new Set(ids.filter((x): x is string => !!x))];
  if (clean.length === 0) return new Map<string, DraftRow>();
  const rows = await db.select().from(schema.drafts).where(inArray(schema.drafts.id, clean));
  return new Map(rows.map((d) => [d.id, d]));
}

export async function assetRoutes(app: FastifyInstance) {
  app.get("/assets", async (req) => {
    const q = z
      .object({
        type: z.enum(["warehouse-receipt", "lpo", "carbon"]).optional(),
        includeClosed: z.coerce.boolean().default(false),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      })
      .parse(req.query);
    const where = and(
      q.type ? eq(schema.assets.assetType, q.type) : undefined,
      q.includeClosed ? undefined : isNull(schema.assets.burnedAs),
    );
    const rows = await db.select().from(schema.assets).where(where).orderBy(desc(schema.assets.issuedBlock)).limit(q.limit);
    const drafts = await draftsById(rows.map((r) => r.draftId));
    const listed = await activeListingKeys();
    return { assets: rows.map((a) => assetView(a, drafts.get(a.draftId ?? ""), { listed: listed.has(`${a.assetType}:${a.tokenId}`) })) };
  });

  /** Public, shareable asset page (PRD §4.3 step 5). */
  app.get("/assets/:type/:id", async (req) => {
    const p = z.object({ type: z.enum(["warehouse-receipt", "lpo", "carbon"]), id: z.string().regex(/^\d+$/) }).parse(req.params);
    const [a] = await db
      .select()
      .from(schema.assets)
      .where(and(eq(schema.assets.assetType, p.type), eq(schema.assets.tokenId, p.id)))
      .limit(1);
    if (!a) throw notFound("Asset not found.");
    const drafts = await draftsById([a.draftId]);
    const draft = drafts.get(a.draftId ?? "");

    const listings = await db
      .select()
      .from(schema.listings)
      .where(and(eq(schema.listings.assetType, p.type), eq(schema.listings.tokenId, p.id), eq(schema.listings.active, true)));

    let warehouse = null;
    if (p.type === "warehouse-receipt") {
      const whId = String((a.terms as Record<string, unknown>).warehouseId);
      const [w] = await db.select().from(schema.warehouses).where(eq(schema.warehouses.id, whId)).limit(1);
      if (w) {
        const [wd] = await db
          .select()
          .from(schema.drafts)
          .where(and(eq(schema.drafts.assetType, "warehouse"), eq(schema.drafts.keyHash, w.licenceRef)))
          .limit(1);
        warehouse = { id: w.id, active: w.active, operator: w.operator, ...publicFields("warehouse", wd?.fields) };
      }
    }

    const history = await db
      .select()
      .from(schema.chainEvents)
      .where(and(eq(schema.chainEvents.entityType, p.type), eq(schema.chainEvents.entityId, p.id)))
      .orderBy(schema.chainEvents.blockNumber, schema.chainEvents.logIndex)
      .limit(200);

    const retirements =
      p.type === "carbon"
        ? await db.select().from(schema.retirements).where(eq(schema.retirements.batchId, p.id)).orderBy(desc(schema.retirements.blockTime)).limit(50)
        : [];

    return {
      asset: assetView(a, draft, { listed: listings.length > 0 }),
      documentHash: (a.terms as Record<string, unknown>).documentHash,
      warehouse,
      listings: listings.map(listingView),
      retirements,
      history: history.map((h) => ({
        event: h.event,
        blockTime: h.blockTime,
        txHash: h.txHash,
        explorerUrl: explorerTxUrl(h.txHash),
        args: h.args,
      })),
    };
  });

  app.get("/warehouses", async () => {
    const rows = await db.select().from(schema.warehouses).orderBy(schema.warehouses.id);
    const drafts = await db
      .select()
      .from(schema.drafts)
      .where(and(eq(schema.drafts.assetType, "warehouse"), inArray(schema.drafts.keyHash, rows.map((r) => r.licenceRef).concat(["-"]))));
    const byKey = new Map<string, DraftRow>(drafts.map((d) => [d.keyHash, d] as [string, DraftRow]));
    return {
      warehouses: rows.map((w) => ({ id: w.id, active: w.active, operator: w.operator, ...publicFields("warehouse", byKey.get(w.licenceRef)?.fields) })),
    };
  });

  /** ERC-721/1155 metadata for tokens, served by draft id. Public fields only. */
  app.get("/metadata/draft/:id", async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const [d] = await db.select().from(schema.drafts).where(eq(schema.drafts.id, id)).limit(1);
    if (!d) throw notFound();
    const fields = publicFields(d.assetType, d.fields);
    reply.header("Cache-Control", "public, max-age=300");
    return {
      name: String(fields.name ?? fields.projectName ?? ASSET_TYPE_LABEL[d.assetType as AssetType] ?? "TradeChainX asset"),
      description: `Verified ${ASSET_TYPE_LABEL[d.assetType as AssetType] ?? "asset"} on TradeChainX. Supporting documents are anchored by hash.`,
      external_url: undefined,
      attributes: Object.entries(fields).map(([trait_type, value]) => ({ trait_type, value })),
      properties: { documentHash: (d.terms as Record<string, unknown>).documentHash ?? null },
    };
  });

  app.get("/activity", async (req) => {
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(100).default(30) }).parse(req.query);
    const rows = await db
      .select({ event: schema.chainEvents.event, entityType: schema.chainEvents.entityType, entityId: schema.chainEvents.entityId, blockTime: schema.chainEvents.blockTime, txHash: schema.chainEvents.txHash })
      .from(schema.chainEvents)
      .where(sql`${schema.chainEvents.event} IN ('ReceiptIssued','LPOIssued','BatchIssued','Sold','CreditsRetired','LPOSettled','OfferingCreated','FullySubscribed')`)
      .orderBy(desc(schema.chainEvents.blockNumber))
      .limit(limit);
    return { activity: rows };
  });
}

export async function activeListingKeys(): Promise<Set<string>> {
  const rows = await db
    .select({ t: schema.listings.assetType, id: schema.listings.tokenId })
    .from(schema.listings)
    .where(eq(schema.listings.active, true));
  return new Set(rows.map((r) => `${r.t}:${r.id}`));
}

export function listingView(l: typeof schema.listings.$inferSelect) {
  return {
    listingId: l.listingId,
    seller: l.seller,
    assetType: l.assetType,
    tokenId: l.tokenId,
    remaining: l.remaining,
    pricePerUnit: l.pricePerUnit,
    feeBps: l.feeBps,
    active: l.active,
  };
}
