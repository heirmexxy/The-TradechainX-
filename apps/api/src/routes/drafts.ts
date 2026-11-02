import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { SubmissionStatus, Tier } from "@tradechainx/shared";
import { db, schema } from "../db/client.ts";
import { requireAdmin, requireUser, requireWallet, type User } from "../plugins/auth.ts";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors.ts";
import { call, type PreparedCall } from "../lib/calls.ts";
import { contracts } from "../chain.ts";
import { jsonSafe } from "../lib/util.ts";
import { identityIsValid } from "../services/profile.ts";
import { ownedDocuments, publicDoc } from "./documents.ts";
import {
  buildReceipt,
  buildLpo,
  buildCarbon,
  buildXown,
  buildWarehouse,
  assertNoLiveDuplicate,
} from "../services/drafts.ts";

export const TYPES = ["warehouse-receipt", "lpo", "carbon", "xown", "warehouse"] as const;
export type DraftType = (typeof TYPES)[number];

const BUILDERS = {
  "warehouse-receipt": buildReceipt,
  lpo: buildLpo,
  carbon: buildCarbon,
  xown: buildXown,
  warehouse: buildWarehouse,
} as const;

type Built = Awaited<ReturnType<(typeof BUILDERS)[DraftType]>>;

async function assertCanDraft(req: Parameters<typeof requireUser>[0], type: DraftType): Promise<User> {
  if (type === "xown") return requireAdmin(req, "asset_manager");
  if (type === "warehouse") return requireAdmin(req, "warehouse_registrar");
  const user = requireWallet(req);
  await assertIdentityCanSubmit(user, type);
  return user;
}

/** The on-chain identity rules for submitting an asset (the contracts enforce the same). */
export async function assertIdentityCanSubmit(user: User & { walletAddress: string }, type: DraftType) {
  const [id] = await db.select().from(schema.identities).where(eq(schema.identities.address, user.walletAddress)).limit(1);
  if (!identityIsValid(id)) throw forbidden("Finish verification before submitting assets.");
  if ((type === "lpo" || type === "carbon") && id!.tier !== Tier.Business && id!.tier !== Tier.Institutional) {
    throw forbidden("Only verified businesses can submit this asset.");
  }
}

/**
 * Create a draft and return the call that submits it on-chain. Shared by the app and the partner API
 * (which passes attribution). The submission then goes through the normal review gate.
 */
export async function createDraft(
  user: User,
  type: DraftType,
  input: { fields: Record<string, unknown>; documentIds: string[] },
  attribution: { partnerId: string; apiKeyId: string } | null = null,
) {
  if (type !== "warehouse" && input.documentIds.length === 0) throw badRequest("Attach at least one supporting document.");
  const docs = await ownedDocuments(user.id, input.documentIds);

  const id = randomUUID();
  const built = await BUILDERS[type](user, id, input.fields, docs.map((d) => d.sha256));
  await assertNoLiveDuplicate(type, built.keyHash);

  const [draft] = await db
    .insert(schema.drafts)
    .values({
      id,
      assetType: type,
      ownerUserId: user.id,
      fields: built.fields as Record<string, unknown>,
      terms: jsonSafe({ ...built.terms, ...built.extra }) as Record<string, unknown>,
      keyHash: built.keyHash,
      documentIds: input.documentIds,
      partnerId: attribution?.partnerId ?? null,
      apiKeyId: attribution?.apiKeyId ?? null,
    })
    .returning();
  return { draft: draftView(draft!), call: callFor(type, built, null) };
}

/** The contract call that sends this draft on-chain (first submission or correction). */
function callFor(type: DraftType, built: Built, submissionId: bigint | null): PreparedCall {
  const t = built.terms as Record<string, unknown>;
  switch (type) {
    case "warehouse-receipt": {
      const holder = (built.extra as { holder: string }).holder;
      return submissionId
        ? call("warehouseReceipt", contracts.warehouseReceipt.address, "resubmit", [submissionId, t, holder], "Resubmit corrected warehouse receipt")
        : call("warehouseReceipt", contracts.warehouseReceipt.address, "submitReceipt", [t, holder], "Submit warehouse receipt for review");
    }
    case "lpo":
      return submissionId
        ? call("lpoToken", contracts.lpoToken.address, "resubmit", [submissionId, t], "Resubmit corrected purchase order")
        : call("lpoToken", contracts.lpoToken.address, "submitLPO", [t], "Submit purchase order for review");
    case "carbon":
      return submissionId
        ? call("carbonCredits", contracts.carbonCredits.address, "resubmit", [submissionId, t], "Resubmit corrected carbon batch")
        : call("carbonCredits", contracts.carbonCredits.address, "submitBatch", [t], "Submit carbon credit batch for review");
    case "xown":
      return call("xownFactory", contracts.xownFactory.address, "propose", [t], "Propose XOwn offering for review");
    case "warehouse":
      return call(
        "warehouseRegistry",
        contracts.warehouseRegistry.address,
        "registerWarehouse",
        [t.operator, t.licenceRef, t.metadataURI],
        "Register warehouse",
      );
  }
}

export async function draftRoutes(app: FastifyInstance) {
  app.post("/drafts/:type", async (req) => {
    const type = z.enum(TYPES).parse((req.params as { type: string }).type);
    const user = await assertCanDraft(req, type);
    const body = z
      .object({ fields: z.record(z.unknown()), documentIds: z.array(z.string().uuid()).max(20).default([]) })
      .parse(req.body);
    return createDraft(user, type, body);
  });

  /** Correct a draft. Allowed before it reaches the chain, or when the reviewer asked for more info. */
  app.patch("/drafts/:id", async (req) => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    const [draft] = await db.select().from(schema.drafts).where(eq(schema.drafts.id, id)).limit(1);
    if (!draft || draft.ownerUserId !== user.id) throw notFound();
    const type = draft.assetType as DraftType;
    await assertCanDraft(req, type);

    let submissionId: bigint | null = null;
    if (draft.submissionId) {
      const [sub] = await db
        .select()
        .from(schema.submissions)
        .where(and(eq(schema.submissions.assetType, type), eq(schema.submissions.submissionId, draft.submissionId)))
        .limit(1);
      if (!sub || sub.status !== SubmissionStatus.NeedsInfo) throw conflict("This submission can't be changed now.");
      submissionId = BigInt(draft.submissionId);
    }

    const body = z
      .object({ fields: z.record(z.unknown()), documentIds: z.array(z.string().uuid()).max(20) })
      .parse(req.body);
    const docs = await ownedDocuments(user.id, body.documentIds);
    const built = await BUILDERS[type](user, id, body.fields, docs.map((d) => d.sha256));
    if (submissionId && built.keyHash !== draft.keyHash) {
      throw badRequest("The reference number can't change on a correction. Withdraw and submit a new one instead.");
    }
    await assertNoLiveDuplicate(type, built.keyHash, id);

    const [updated] = await db
      .update(schema.drafts)
      .set({
        fields: built.fields as Record<string, unknown>,
        terms: jsonSafe({ ...built.terms, ...built.extra }) as Record<string, unknown>,
        keyHash: built.keyHash,
        documentIds: body.documentIds,
        updatedAt: new Date(),
      })
      .where(eq(schema.drafts.id, id))
      .returning();
    return { draft: draftView(updated!), call: callFor(type, built, submissionId) };
  });

  app.post("/drafts/:id/tx", async (req) => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    const { txHash } = z.object({ txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/) }).parse(req.body);
    const [draft] = await db.select().from(schema.drafts).where(eq(schema.drafts.id, id)).limit(1);
    if (!draft || draft.ownerUserId !== user.id) throw notFound();
    // Only a hint for the UI ("waiting for confirmation"). The indexer links the real submission.
    await db.update(schema.drafts).set({ txHash, updatedAt: new Date() }).where(eq(schema.drafts.id, id));
    return { ok: true };
  });

  app.get("/drafts/mine", async (req) => {
    const user = requireUser(req);
    const rows = await db
      .select({ d: schema.drafts, s: schema.submissions })
      .from(schema.drafts)
      .leftJoin(
        schema.submissions,
        and(eq(schema.submissions.draftId, schema.drafts.id)),
      )
      .where(eq(schema.drafts.ownerUserId, user.id))
      .orderBy(desc(schema.drafts.createdAt))
      .limit(200);
    // Latest reviewer note per submission, so "Needs info" says what's needed.
    const keys = rows.filter(({ s }) => s).map(({ d, s }) => `${d.assetType}-submission:${s!.submissionId}`);
    const notes = keys.length
      ? await db
          .select()
          .from(schema.reviewNotes)
          .where(inArray(sql`${schema.reviewNotes.entityType} || ':' || ${schema.reviewNotes.entityId}`, keys))
          .orderBy(desc(schema.reviewNotes.createdAt))
      : [];
    const latest = new Map<string, string>();
    for (const n of notes) {
      const k = `${n.entityType}:${n.entityId}`;
      if (!latest.has(k)) latest.set(k, n.note);
    }
    return {
      drafts: rows.map(({ d, s }) => ({
        ...draftView(d),
        submission: s ? submissionView(s) : null,
        reviewerNote: s ? latest.get(`${d.assetType}-submission:${s.submissionId}`) ?? null : null,
      })),
    };
  });

  app.get("/drafts/:id", async (req) => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    const [draft] = await db.select().from(schema.drafts).where(eq(schema.drafts.id, id)).limit(1);
    if (!draft) throw notFound();
    const reviewer = user.adminRoles.length > 0;
    if (draft.ownerUserId !== user.id && !reviewer) throw notFound();
    const [sub] = await db.select().from(schema.submissions).where(eq(schema.submissions.draftId, id)).limit(1);
    const docs = draft.documentIds.length ? await ownedDocuments(draft.ownerUserId, draft.documentIds) : [];
    return { draft: draftView(draft), submission: sub ? submissionView(sub) : null, documents: docs.map(publicDoc) };
  });
}

export function draftView(d: typeof schema.drafts.$inferSelect) {
  return {
    id: d.id,
    assetType: d.assetType,
    fields: d.fields,
    terms: d.terms,
    keyHash: d.keyHash,
    documentIds: d.documentIds,
    submissionId: d.submissionId,
    txHash: d.txHash,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  };
}

export function submissionView(s: typeof schema.submissions.$inferSelect) {
  return {
    assetType: s.assetType,
    submissionId: s.submissionId,
    status: s.status,
    tokenId: s.tokenId,
    submitter: s.submitter,
    holder: s.holder,
  };
}
