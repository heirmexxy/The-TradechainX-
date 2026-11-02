import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, desc, eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { Tier, kycTrackFor, KYC_TIER_FOR, type UserType } from "@tradechainx/shared";
import { db, schema } from "../db/client.ts";
import { requireAdmin, requireUser, requireWallet } from "../plugins/auth.ts";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors.ts";
import { recordRef } from "../lib/hash.ts";
import { call } from "../lib/calls.ts";
import { contracts } from "../chain.ts";
import { ownedDocuments, publicDoc } from "./documents.ts";
import { nowSec } from "../lib/util.ts";

// Minimal personal data: enough for a reviewer to match the documents. Full ID numbers are not
// stored — they're on the uploaded documents, which live in encrypted private storage.
const individualDetails = z.object({
  fullName: z.string().trim().min(2).max(120),
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  nationality: z.string().trim().min(2).max(60),
  idType: z.enum(["nin", "passport", "drivers_licence", "voters_card", "other"]),
  idLast4: z.string().regex(/^[A-Za-z0-9]{4}$/),
  phone: z.string().trim().min(7).max(20),
  address: z.string().trim().min(5).max(300),
});

const businessDetails = z.object({
  companyName: z.string().trim().min(2).max(200),
  registrationNumber: z.string().trim().min(3).max(40),
  country: z.string().trim().min(2).max(60),
  registeredAddress: z.string().trim().min(5).max(300),
  facilityAddress: z.string().trim().max(300).optional(),
  signatoryName: z.string().trim().min(2).max(120),
  signatoryRole: z.string().trim().min(2).max(80),
  phone: z.string().trim().min(7).max(20),
});

const REQUIRED_DOCS: Record<"individual" | "business", string[]> = {
  individual: ["government_id", "selfie"],
  business: ["cac_certificate", "signatory_id", "proof_of_address"],
};

export async function kycRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------- applicant

  app.get("/kyc/me", async (req) => {
    const user = requireUser(req);
    const [c] = await db
      .select()
      .from(schema.kycCases)
      .where(eq(schema.kycCases.userId, user.id))
      .orderBy(desc(schema.kycCases.submittedAt))
      .limit(1);
    const track = user.userType ? kycTrackFor(user.userType) : null;
    return {
      track,
      requiredDocuments: track ? REQUIRED_DOCS[track] : [],
      case: c ? { id: c.id, status: c.status === "approved" ? "pending" : c.status, submittedAt: c.submittedAt, message: c.status === "needs_info" ? c.reviewerNote : null } : null,
    };
  });

  app.post("/kyc", async (req) => {
    const user = requireWallet(req);
    if (!user.userType) throw badRequest("Choose your account type first.");
    const track = kycTrackFor(user.userType);
    const body = z
      .object({ details: z.record(z.unknown()), documentIds: z.array(z.string().uuid()).min(1).max(10) })
      .parse(req.body);
    const details = (track === "individual" ? individualDetails : businessDetails).parse(body.details);

    const docs = await ownedDocuments(user.id, body.documentIds);
    const kinds = new Set(docs.map((d) => d.kind));
    const missing = REQUIRED_DOCS[track].filter((k) => !kinds.has(k));
    if (missing.length) throw badRequest(`Missing documents: ${missing.join(", ")}`, "missing_documents");

    const [latest] = await db
      .select()
      .from(schema.kycCases)
      .where(eq(schema.kycCases.userId, user.id))
      .orderBy(desc(schema.kycCases.submittedAt))
      .limit(1);

    if (latest && ["pending", "approved", "verified"].includes(latest.status)) {
      throw conflict("Your verification is already in progress.");
    }
    if (latest?.status === "needs_info") {
      const [updated] = await db
        .update(schema.kycCases)
        .set({ details, documentIds: body.documentIds, status: "pending", submittedAt: new Date() })
        .where(eq(schema.kycCases.id, latest.id))
        .returning();
      return { case: { id: updated!.id, status: "pending" } };
    }
    const id = randomUUID();
    const [created] = await db
      .insert(schema.kycCases)
      .values({ id, userId: user.id, track, status: "pending", details, documentIds: body.documentIds, recordRef: recordRef("kyc", id) })
      .returning();
    return { case: { id: created!.id, status: "pending" } };
  });

  // ---------------------------------------------------------------- reviewer

  app.get("/admin/kyc", async (req) => {
    requireAdmin(req, "kyc_reviewer");
    const { status } = z
      .object({ status: z.enum(["pending", "needs_info", "approved", "verified", "rejected"]).default("pending") })
      .parse(req.query);
    const rows = await db
      .select({ c: schema.kycCases, u: schema.users })
      .from(schema.kycCases)
      .innerJoin(schema.users, eq(schema.users.id, schema.kycCases.userId))
      .where(eq(schema.kycCases.status, status))
      .orderBy(schema.kycCases.submittedAt)
      .limit(200);
    return {
      cases: rows.map(({ c, u }) => ({
        id: c.id,
        status: c.status,
        track: c.track,
        submittedAt: c.submittedAt,
        applicant: { email: u.email, userType: u.userType, name: (c.details as Record<string, string>).fullName ?? (c.details as Record<string, string>).companyName },
      })),
    };
  });

  app.get("/admin/kyc/:id", async (req) => {
    requireAdmin(req, "kyc_reviewer");
    const { id } = req.params as { id: string };
    const [row] = await db
      .select({ c: schema.kycCases, u: schema.users })
      .from(schema.kycCases)
      .innerJoin(schema.users, eq(schema.users.id, schema.kycCases.userId))
      .where(eq(schema.kycCases.id, id))
      .limit(1);
    if (!row) throw notFound();
    const docs = row.c.documentIds.length
      ? await db.select().from(schema.documents).where(inArray(schema.documents.id, row.c.documentIds))
      : [];
    const history = await db
      .select({ id: schema.kycCases.id, status: schema.kycCases.status, submittedAt: schema.kycCases.submittedAt, note: schema.kycCases.reviewerNote })
      .from(schema.kycCases)
      .where(and(eq(schema.kycCases.userId, row.u.id)))
      .orderBy(desc(schema.kycCases.submittedAt));
    return {
      case: row.c,
      applicant: { id: row.u.id, email: row.u.email, userType: row.u.userType, walletAddress: row.u.walletAddress, orgName: row.u.orgName },
      suggestedTier: row.u.userType ? KYC_TIER_FOR[row.u.userType as UserType] : null,
      documents: docs.map(publicDoc),
      history,
      // If approved but the on-chain write hasn't landed, the reviewer can resend it.
      onchainCall: row.c.status === "approved" ? setIdentityCall(row.u.walletAddress!, row.c) : null,
    };
  });

  app.post("/admin/kyc/:id/decision", async (req) => {
    const reviewer = requireAdmin(req, "kyc_reviewer");
    const { id } = req.params as { id: string };
    const body = z
      .object({
        decision: z.enum(["approve", "needs_info", "reject"]),
        note: z.string().trim().max(1000).optional(),
        tier: z.nativeEnum(Tier).optional(),
        validForDays: z.number().int().min(30).max(3 * 365).default(365),
      })
      .parse(req.body);

    const [row] = await db
      .select({ c: schema.kycCases, u: schema.users })
      .from(schema.kycCases)
      .innerJoin(schema.users, eq(schema.users.id, schema.kycCases.userId))
      .where(eq(schema.kycCases.id, id))
      .limit(1);
    if (!row) throw notFound();
    if (row.u.id === reviewer.id) throw forbidden("You can't review your own verification.");
    if (row.c.status !== "pending") throw conflict(`This case is ${row.c.status}.`);
    if (body.decision !== "approve" && !body.note) throw badRequest("Add a note explaining what's needed.");

    if (body.decision !== "approve") {
      await db
        .update(schema.kycCases)
        .set({ status: body.decision === "reject" ? "rejected" : "needs_info", reviewerNote: body.note, reviewedBy: reviewer.id, reviewedAt: new Date() })
        .where(eq(schema.kycCases.id, id));
      return { status: body.decision === "reject" ? "rejected" : "needs_info", onchainCall: null };
    }

    if (!row.u.walletAddress) throw conflict("The applicant has no wallet yet.");
    const tier = body.tier ?? (row.u.userType ? KYC_TIER_FOR[row.u.userType as UserType] : Tier.Individual);
    if (tier === Tier.None || tier === Tier.Platform) throw badRequest("Choose Individual, Business or Institutional.");
    const validUntil = nowSec() + body.validForDays * 86_400;

    const [updated] = await db
      .update(schema.kycCases)
      .set({ status: "approved", approvedTier: tier, approvedValidUntil: validUntil, reviewerNote: body.note ?? null, reviewedBy: reviewer.id, reviewedAt: new Date() })
      .where(eq(schema.kycCases.id, id))
      .returning();
    return { status: "approved", onchainCall: setIdentityCall(row.u.walletAddress, updated!) };
  });
}

function setIdentityCall(wallet: string, c: typeof schema.kycCases.$inferSelect) {
  return call(
    "identityRegistry",
    contracts.identityRegistry.address,
    "setIdentity",
    [wallet, c.approvedTier, BigInt(c.approvedValidUntil!), c.recordRef],
    `Record verification on-chain: tier ${Object.keys(Tier).find((k) => Tier[k as keyof typeof Tier] === c.approvedTier)} until ${new Date(c.approvedValidUntil! * 1000).toISOString().slice(0, 10)}`,
  );
}
