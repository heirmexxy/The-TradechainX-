import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, desc, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import type { Address } from "viem";
import { db, schema } from "../db/client.ts";
import { requireWallet, requireUser } from "../plugins/auth.ts";
import { notFound } from "../lib/errors.ts";
import { publicClient, usdc, vaultAbi } from "../chain.ts";
import { assetView, draftsById, listingView } from "./assets.ts";
import { publicFields } from "../services/public.ts";

export async function portfolioRoutes(app: FastifyInstance) {
  /** Everything the signed-in user holds, has listed, has financed, or needs to act on. */
  app.get("/portfolio", async (req) => {
    const user = requireWallet(req);
    const me = user.walletAddress;

    const [owned, myListings, financed, carbon, holdings, retirements, balance] = await Promise.all([
      db.select().from(schema.assets).where(and(eq(schema.assets.owner, me), isNull(schema.assets.burnedAs))),
      db
        .select({ l: schema.listings, a: schema.assets })
        .from(schema.listings)
        .innerJoin(schema.assets, and(eq(schema.assets.assetType, schema.listings.assetType), eq(schema.assets.tokenId, schema.listings.tokenId)))
        .where(and(eq(schema.listings.seller, me), eq(schema.listings.active, true))),
      db.select().from(schema.assets).where(and(sql`${schema.assets.lien}->>'lienholder' = ${me}`, isNull(schema.assets.burnedAs))),
      db
        .select({ b: schema.carbonBalances, a: schema.assets })
        .from(schema.carbonBalances)
        .innerJoin(schema.assets, and(eq(schema.assets.assetType, "carbon"), eq(schema.assets.tokenId, schema.carbonBalances.batchId)))
        .where(eq(schema.carbonBalances.holder, me)),
      db
        .select({ h: schema.xownHoldings, o: schema.xownOfferings })
        .from(schema.xownHoldings)
        .innerJoin(schema.xownOfferings, eq(schema.xownOfferings.vault, schema.xownHoldings.vault))
        .where(eq(schema.xownHoldings.holder, me)),
      db.select().from(schema.retirements).where(eq(schema.retirements.holder, me)).orderBy(desc(schema.retirements.blockTime)).limit(50),
      publicClient.readContract({ ...usdc, functionName: "balanceOf", args: [me as Address] }),
    ]);

    const drafts = await draftsById([
      ...owned.map((a) => a.draftId),
      ...myListings.map((r) => r.a.draftId),
      ...financed.map((a) => a.draftId),
      ...carbon.map((r) => r.a.draftId),
      ...holdings.map((r) => r.o.draftId),
    ]);

    // Yield is accrued continuously on-chain; read it live rather than mirroring it.
    const claimable = await Promise.all(
      holdings.map((r) =>
        publicClient
          .readContract({ address: r.h.vault as Address, abi: vaultAbi, functionName: "claimableYield", args: [me as Address] })
          .catch(() => 0n),
      ),
    );

    return {
      wallet: me,
      usdcBalance: balance.toString(),
      assets: owned.map((a) => assetView(a, drafts.get(a.draftId ?? ""))),
      listings: myListings.map(({ l, a }) => ({ ...listingView(l), asset: assetView(a, drafts.get(a.draftId ?? ""), { listed: true }) })),
      financing: financed.map((a) => assetView(a, drafts.get(a.draftId ?? ""))),
      carbon: carbon.map(({ b, a }) => ({ amount: b.amount, asset: assetView(a, drafts.get(a.draftId ?? "")) })),
      xown: holdings.map(({ h, o }, i) => ({
        vault: h.vault,
        shares: h.shares,
        claimableYield: claimable[i]!.toString(),
        offering: offeringView(o, drafts.get(o.draftId ?? "")?.fields),
      })),
      retirements,
    };
  });

  /** Things a warehouse operator or LPO originator must act on, and what they've issued. */
  app.get("/issuer/queue", async (req) => {
    const user = requireWallet(req);
    const me = user.walletAddress;
    const myWarehouses = await db.select().from(schema.warehouses).where(eq(schema.warehouses.operator, me));
    const whIds = myWarehouses.map((w) => w.id);

    const receiptsAtMyWarehouses = whIds.length
      ? await db
          .select()
          .from(schema.assets)
          .where(and(eq(schema.assets.assetType, "warehouse-receipt"), sql`${schema.assets.terms}->>'warehouseId' = ANY(${whIds})`))
      : [];
    const issuedByMe = await db.select().from(schema.assets).where(eq(schema.assets.originator, me)).orderBy(desc(schema.assets.issuedBlock)).limit(200);
    const drafts = await draftsById([...receiptsAtMyWarehouses, ...issuedByMe].map((a) => a.draftId));

    return {
      warehouses: myWarehouses,
      // Holder asked to collect goods; the warehouse must confirm release before a reviewer can approve.
      releasesToConfirm: receiptsAtMyWarehouses
        .filter((a) => a.pendingRequest && [1, 2].includes(Number(a.pendingRequest.kind)) && !a.pendingRequest.warehouseConfirmed)
        .map((a) => assetView(a, drafts.get(a.draftId ?? ""))),
      receipts: receiptsAtMyWarehouses.map((a) => assetView(a, drafts.get(a.draftId ?? ""))),
      issued: issuedByMe.map((a) => assetView(a, drafts.get(a.draftId ?? ""))),
    };
  });

  // ---------------------------------------------------------------- XOwn

  app.get("/xown/offerings", async () => {
    const rows = await db
      .select()
      .from(schema.xownOfferings)
      .where(isNotNull(schema.xownOfferings.vault))
      .orderBy(desc(schema.xownOfferings.updatedBlock));
    const drafts = await draftsById(rows.map((r) => r.draftId));
    return { offerings: rows.map((o) => offeringView(o, drafts.get(o.draftId ?? "")?.fields)) };
  });

  app.get("/xown/offerings/:vault", async (req) => {
    const { vault } = z.object({ vault: z.string().regex(/^0x[0-9a-fA-F]{40}$/) }).parse(req.params);
    const v = vault.toLowerCase();
    const [o] = await db.select().from(schema.xownOfferings).where(eq(schema.xownOfferings.vault, v)).limit(1);
    if (!o) throw notFound("Offering not found.");
    const drafts = await draftsById([o.draftId]);
    const history = await db
      .select()
      .from(schema.chainEvents)
      .where(and(eq(schema.chainEvents.entityType, "xown-vault"), eq(schema.chainEvents.entityId, v)))
      .orderBy(desc(schema.chainEvents.blockNumber))
      .limit(100);
    const [holders] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.xownHoldings).where(eq(schema.xownHoldings.vault, v));

    let mine = null;
    if (req.user?.walletAddress) {
      const me = req.user.walletAddress as Address;
      const [shares, claimable] = await Promise.all([
        publicClient.readContract({ address: v as Address, abi: vaultAbi, functionName: "balanceOf", args: [me] }),
        publicClient.readContract({ address: v as Address, abi: vaultAbi, functionName: "claimableYield", args: [me] }),
      ]);
      mine = { shares: shares.toString(), claimableYield: claimable.toString() };
    }
    return {
      offering: offeringView(o, drafts.get(o.draftId ?? "")?.fields),
      holders: holders?.n ?? 0,
      mine,
      history: history.map((h) => ({ event: h.event, blockTime: h.blockTime, txHash: h.txHash, args: h.args })),
    };
  });
}

export function offeringView(o: typeof schema.xownOfferings.$inferSelect, fields?: Record<string, unknown>) {
  return {
    proposalId: o.proposalId,
    vault: o.vault,
    name: o.name,
    symbol: o.symbol,
    operator: o.operator,
    maxShares: o.maxShares,
    pricePerShare: o.pricePerShare,
    deadline: o.deadline,
    proposalStatus: o.proposalStatus,
    vaultState: o.vaultState,
    sharesSold: o.sharesSold,
    totalYield: o.totalYield,
    proceeds: o.proceeds,
    equipment: o.equipment,
    details: publicFields("xown", fields),
  };
}
