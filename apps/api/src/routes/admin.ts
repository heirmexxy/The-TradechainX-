import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, desc, eq, ilike, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import { keccak256, toBytes, zeroHash } from "viem";
import { ADMIN_ROLES, ONCHAIN_ROLE_NAME, SubmissionStatus, type AdminRole } from "@tradechainx/shared";
import { db, schema } from "../db/client.ts";
import { requireAdmin } from "../plugins/auth.ts";
import { badRequest, notFound } from "../lib/errors.ts";
import { call, type PreparedCall } from "../lib/calls.ts";
import { contracts } from "../chain.ts";
import { assetView, draftsById } from "./assets.ts";
import { offeringView } from "./portfolio.ts";
import { publicDoc } from "./documents.ts";

const REVIEWABLE = ["warehouse-receipt", "lpo", "carbon"] as const;

export async function adminRoutes(app: FastifyInstance) {
  app.get("/admin/overview", async (req) => {
    requireAdmin(req, ...ADMIN_ROLES);
    const count = (q: Promise<{ n: number }[]>) => q.then((r) => r[0]?.n ?? 0);
    const n = sql<number>`count(*)::int`;
    const [kyc, kycOnchain, subs, requests, proposals, listings, trades30] = await Promise.all([
      count(db.select({ n }).from(schema.kycCases).where(eq(schema.kycCases.status, "pending"))),
      count(db.select({ n }).from(schema.kycCases).where(eq(schema.kycCases.status, "approved"))),
      db
        .select({ assetType: schema.submissions.assetType, n })
        .from(schema.submissions)
        .where(eq(schema.submissions.status, SubmissionStatus.Pending))
        .groupBy(schema.submissions.assetType),
      count(db.select({ n }).from(schema.assets).where(and(isNotNull(schema.assets.pendingRequest), isNull(schema.assets.burnedAs)))),
      count(db.select({ n }).from(schema.xownOfferings).where(eq(schema.xownOfferings.proposalStatus, 1))),
      count(db.select({ n }).from(schema.listings).where(eq(schema.listings.active, true))),
      db
        .select({ volume: sql<string>`coalesce(sum(${schema.trades.total}),0)::text`, fees: sql<string>`coalesce(sum(${schema.trades.fee}),0)::text`, n })
        .from(schema.trades)
        .where(sql`${schema.trades.blockTime} > now() - interval '30 days'`),
    ]);
    return {
      queues: {
        kycPending: kyc,
        kycAwaitingOnchain: kycOnchain,
        submissions: Object.fromEntries(subs.map((s) => [s.assetType, s.n])),
        statusRequests: requests,
        xownProposals: proposals,
      },
      market: { activeListings: listings, trades30d: trades30[0]?.n ?? 0, volume30d: trades30[0]?.volume ?? "0", fees30d: trades30[0]?.fees ?? "0" },
    };
  });

  // ---------------------------------------------------------------- listing review (PRD §4.3 steps 2–3)

  app.get("/admin/submissions", async (req) => {
    requireAdmin(req, "listing_reviewer");
    const q = z
      .object({ type: z.enum(REVIEWABLE).optional(), status: z.coerce.number().int().default(SubmissionStatus.Pending) })
      .parse(req.query);
    const rows = await db
      .select({ s: schema.submissions, d: schema.drafts, u: schema.users })
      .from(schema.submissions)
      .leftJoin(schema.drafts, eq(schema.drafts.id, schema.submissions.draftId))
      .leftJoin(schema.users, eq(schema.users.id, schema.drafts.ownerUserId))
      .where(and(eq(schema.submissions.status, q.status), q.type ? eq(schema.submissions.assetType, q.type) : undefined))
      .orderBy(schema.submissions.updatedBlock)
      .limit(200);
    return {
      submissions: rows.map(({ s, d, u }) => ({
        assetType: s.assetType,
        submissionId: s.submissionId,
        status: s.status,
        submitter: s.submitter,
        holder: s.holder,
        fields: d?.fields ?? null,
        submittedBy: u ? { email: u.email, orgName: u.orgName } : null,
      })),
    };
  });

  app.get("/admin/submissions/:type/:id", async (req) => {
    requireAdmin(req, "listing_reviewer");
    const p = z.object({ type: z.enum(REVIEWABLE), id: z.string().regex(/^\d+$/) }).parse(req.params);
    const [row] = await db
      .select({ s: schema.submissions, d: schema.drafts, u: schema.users })
      .from(schema.submissions)
      .leftJoin(schema.drafts, eq(schema.drafts.id, schema.submissions.draftId))
      .leftJoin(schema.users, eq(schema.users.id, schema.drafts.ownerUserId))
      .where(and(eq(schema.submissions.assetType, p.type), eq(schema.submissions.submissionId, p.id)))
      .limit(1);
    if (!row) throw notFound();
    const { s, d, u } = row;
    const docs = d?.documentIds.length ? await db.select().from(schema.documents).where(inArray(schema.documents.id, d.documentIds)) : [];

    const checks = await automatedChecks(p.type, s, d);
    const id = BigInt(p.id);
    const address = p.type === "warehouse-receipt" ? contracts.warehouseReceipt.address : p.type === "lpo" ? contracts.lpoToken.address : contracts.carbonCredits.address;
    const key = p.type === "warehouse-receipt" ? "warehouseReceipt" : p.type === "lpo" ? "lpoToken" : "carbonCredits";

    return {
      submission: s,
      draft: d,
      submittedBy: u ? { email: u.email, orgName: u.orgName, userType: u.userType } : null,
      documents: docs.map(publicDoc),
      checks,
      calls: {
        approve: call(key, address, "approveSubmission", [id], "Approve and issue the token"),
        // Reason text is kept off-chain; only its hash goes on-chain.
        requestInfo: call(key, address, "requestInfo", [id, zeroHash], "Ask the submitter for more information"),
        reject: call(key, address, "rejectSubmission", [id, zeroHash], "Reject the submission"),
      },
    };
  });

  /**
   * Stores a reviewer's note (request-info, rejection, declined change). Only its hash goes on-chain
   * as reasonRef; the text is shown to the submitter. Call after the on-chain action succeeds.
   */
  app.post("/admin/review-notes", async (req) => {
    const author = requireAdmin(req, "listing_reviewer", "kyc_reviewer", "asset_manager");
    const body = z
      .object({ entityType: z.string().min(1).max(64), entityId: z.string().min(1).max(80), note: z.string().trim().min(1).max(2000) })
      .parse(req.body);
    const reasonRef = keccak256(toBytes(body.note));
    await db.insert(schema.reviewNotes).values({ ...body, reasonRef, authorId: author.id });
    return { reasonRef };
  });

  // ---------------------------------------------------------------- status changes (PRD §4.3 step 6)

  app.get("/admin/status-requests", async (req) => {
    requireAdmin(req, "listing_reviewer");
    const rows = await db
      .select()
      .from(schema.assets)
      .where(and(isNotNull(schema.assets.pendingRequest), isNull(schema.assets.burnedAs)))
      .orderBy(schema.assets.updatedBlock);
    const drafts = await draftsById(rows.map((r) => r.draftId));
    return {
      requests: rows.map((a) => {
        const address = a.assetType === "warehouse-receipt" ? contracts.warehouseReceipt.address : contracts.lpoToken.address;
        const key = a.assetType === "warehouse-receipt" ? "warehouseReceipt" : "lpoToken";
        const id = BigInt(a.tokenId);
        return {
          asset: assetView(a, drafts.get(a.draftId ?? "")),
          request: a.pendingRequest,
          calls: {
            approve: call(key, address, "approveStatusRequest", [id], "Approve the change"),
            reject: call(key, address, "rejectStatusRequest", [id, zeroHash], "Reject the change"),
          },
        };
      }),
    };
  });

  // ---------------------------------------------------------------- XOwn proposals

  app.get("/admin/xown/proposals", async (req) => {
    requireAdmin(req, "listing_reviewer", "asset_manager");
    const { status } = z.object({ status: z.coerce.number().int().default(1) }).parse(req.query);
    const rows = await db.select().from(schema.xownOfferings).where(eq(schema.xownOfferings.proposalStatus, status)).orderBy(desc(schema.xownOfferings.updatedBlock));
    const drafts = await draftsById(rows.map((r) => r.draftId));
    return {
      proposals: rows.map((o) => {
        const d = drafts.get(o.draftId ?? "");
        const id = BigInt(o.proposalId);
        return {
          offering: offeringView(o, d?.fields),
          fields: d?.fields ?? null,
          documentIds: d?.documentIds ?? [],
          calls: {
            approve: call("xownFactory", contracts.xownFactory.address, "approve", [id], "Approve offering and create its vault"),
            reject: call("xownFactory", contracts.xownFactory.address, "reject", [id, zeroHash], "Reject the proposal"),
          },
        };
      }),
    };
  });

  // ---------------------------------------------------------------- people & roles (Super Admin)

  app.get("/admin/users", async (req) => {
    requireAdmin(req, "super_admin", "kyc_reviewer");
    const { q } = z.object({ q: z.string().trim().max(100).default("") }).parse(req.query);
    const rows = await db
      .select()
      .from(schema.users)
      .where(q ? or(ilike(schema.users.email, `%${q}%`), ilike(schema.users.orgName, `%${q}%`), eq(schema.users.walletAddress, q.toLowerCase())) : undefined)
      .orderBy(desc(schema.users.createdAt))
      .limit(100);
    return {
      users: rows.map((u) => ({ id: u.id, email: u.email, userType: u.userType, orgName: u.orgName, walletAddress: u.walletAddress, adminRoles: u.adminRoles, createdAt: u.createdAt })),
    };
  });

  /**
   * Updates which admin screens a person sees, and returns the on-chain grants/revokes the Super Admin
   * multisig must sign. The contracts only honour roles granted on-chain.
   */
  app.put("/admin/users/:id/roles", async (req) => {
    const actor = requireAdmin(req, "super_admin");
    const { id } = req.params as { id: string };
    const { roles } = z.object({ roles: z.array(z.enum(ADMIN_ROLES)).max(ADMIN_ROLES.length) }).parse(req.body);
    const [u] = await db.select().from(schema.users).where(eq(schema.users.id, id)).limit(1);
    if (!u) throw notFound();
    if (u.id === actor.id && !roles.includes("super_admin")) throw badRequest("You can't remove your own super admin access here.");
    if (!u.walletAddress) throw badRequest("This person needs a wallet before they can hold admin roles.");

    const before = new Set(u.adminRoles as AdminRole[]);
    const after = new Set(roles);
    const calls: PreparedCall[] = [];
    for (const role of ADMIN_ROLES) {
      if (role === "super_admin") continue; // DEFAULT_ADMIN_ROLE moves only via the 2-step transfer.
      const grant = after.has(role) && !before.has(role);
      const revoke = !after.has(role) && before.has(role);
      if (!grant && !revoke) continue;
      const roleId = keccak256(toBytes(ONCHAIN_ROLE_NAME[role]));
      for (const target of roleTargets(role)) {
        calls.push(call(target.key, target.address, grant ? "grantRole" : "revokeRole", [roleId, u.walletAddress], `${grant ? "Grant" : "Revoke"} ${role} on ${target.label}`));
      }
    }
    await db.update(schema.users).set({ adminRoles: roles, updatedAt: new Date() }).where(eq(schema.users.id, id));
    return { roles, onchainCalls: calls };
  });
}

function roleTargets(role: Exclude<AdminRole, "super_admin">) {
  const c = contracts;
  const t = (key: Parameters<typeof call>[0], address: `0x${string}`, label: string) => ({ key, address, label });
  switch (role) {
    case "kyc_reviewer":
      return [t("identityRegistry", c.identityRegistry.address, "IdentityRegistry")];
    case "warehouse_registrar":
      return [t("warehouseRegistry", c.warehouseRegistry.address, "WarehouseRegistry")];
    case "asset_manager":
      return [t("xownFactory", c.xownFactory.address, "XOwnFactory")];
    case "listing_reviewer":
      return [
        t("warehouseReceipt", c.warehouseReceipt.address, "WarehouseReceipt"),
        t("lpoToken", c.lpoToken.address, "LPOToken"),
        t("carbonCredits", c.carbonCredits.address, "CarbonCredits"),
        t("xownFactory", c.xownFactory.address, "XOwnFactory"),
      ];
    case "pauser":
      return [
        t("warehouseReceipt", c.warehouseReceipt.address, "WarehouseReceipt"),
        t("lpoToken", c.lpoToken.address, "LPOToken"),
        t("carbonCredits", c.carbonCredits.address, "CarbonCredits"),
        t("marketplace", c.marketplace.address, "Marketplace"),
        t("xownFactory", c.xownFactory.address, "XOwnFactory"),
      ];
  }
}

/**
 * PRD §4.3 step 2: automated checks shown to the reviewer next to the documents. The contract already
 * blocks exact duplicates; these flag the near-misses a fraudster would try.
 */
async function automatedChecks(
  type: (typeof REVIEWABLE)[number],
  s: typeof schema.submissions.$inferSelect,
  d: typeof schema.drafts.$inferSelect | null,
) {
  const flags: { level: "info" | "warn"; message: string }[] = [];
  const f = (d?.fields ?? {}) as Record<string, string | number>;
  if (!d) flags.push({ level: "warn", message: "No off-chain details were found for this submission. It may have been submitted outside the app." });
  if (d && d.documentIds.length === 0) flags.push({ level: "warn", message: "No supporting documents are attached." });

  if (type === "warehouse-receipt" && d) {
    // Same warehouse + commodity + deposit date as another live receipt.
    const same = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.drafts)
      .where(
        and(
          eq(schema.drafts.assetType, "warehouse-receipt"),
          ne(schema.drafts.id, d.id),
          sql`${schema.drafts.fields}->>'warehouseId' = ${String(f.warehouseId)}`,
          sql`${schema.drafts.fields}->>'commodity' = ${String(f.commodity)}`,
          sql`${schema.drafts.fields}->>'depositDate' = ${String(f.depositDate)}`,
        ),
      );
    const n = same[0]?.n ?? 0;
    if (n > 0) flags.push({ level: "warn", message: `${n} other receipt(s) at this warehouse share the same commodity and deposit date. Check they're different lots.` });
  }
  if (type === "lpo" && d) {
    const outstanding = await db
      .select({ n: sql<number>`count(*)::int`, total: sql<string>`coalesce(sum((${schema.assets.terms}->>'faceValue')::numeric),0)::text` })
      .from(schema.assets)
      .innerJoin(schema.drafts, eq(schema.drafts.id, schema.assets.draftId))
      .where(
        and(
          eq(schema.assets.assetType, "lpo"),
          isNull(schema.assets.burnedAs),
          sql`${schema.drafts.fields}->>'buyerRegistrationNumber' = ${String(f.buyerRegistrationNumber)}`,
        ),
      );
    const o = outstanding[0];
    if (o && o.n > 0) flags.push({ level: "info", message: `This buyer already has ${o.n} open LPO(s) on the platform totalling ${Number(o.total) / 1e6} USDC.` });
  }
  if (type === "carbon" && d) {
    const same = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.drafts)
      .where(
        and(
          eq(schema.drafts.assetType, "carbon"),
          ne(schema.drafts.id, d.id),
          sql`${schema.drafts.fields}->>'projectId' = ${String(f.projectId)}`,
          sql`${schema.drafts.fields}->>'vintage' = ${String(f.vintage)}`,
        ),
      );
    const n = same[0]?.n ?? 0;
    if (n > 0) flags.push({ level: "warn", message: `${n} other batch(es) from the same project and vintage exist. Confirm the serial ranges don't overlap on the registry.` });
    flags.push({ level: "info", message: "Check the batch status on the registry's public site before approving." });
  }
  if (s.status !== SubmissionStatus.Pending) flags.push({ level: "info", message: "This submission is not pending." });
  return flags;
}
