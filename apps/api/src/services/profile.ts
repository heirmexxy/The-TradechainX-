import { desc, eq } from "drizzle-orm";
import type { KycStatus } from "@tradechainx/shared";
import { db, schema } from "../db/client.ts";
import type { User } from "../plugins/auth.ts";
import { nowSec } from "../lib/util.ts";

export type Identity = typeof schema.identities.$inferSelect;

export function identityIsValid(id: Identity | undefined): boolean {
  return !!id && id.tier > 0 && !id.frozen && id.validUntil >= nowSec();
}

/**
 * What the user sees (PRD §4.2: Pending / Verified / Needs Info — never internal review steps).
 * "approved" off-chain but not yet written on-chain still shows as Pending.
 */
export function userFacingKycStatus(caseStatus: string | undefined, identity: Identity | undefined): KycStatus {
  if (identity && identity.tier > 0) {
    if (identity.frozen) return "pending";
    return identity.validUntil >= nowSec() ? "verified" : "expired";
  }
  switch (caseStatus) {
    case undefined:
      return "not_started";
    case "needs_info":
      return "needs_info";
    case "rejected":
      return "rejected";
    default:
      return "pending";
  }
}

export async function profileFor(user: User) {
  const [kyc] = await db
    .select({ status: schema.kycCases.status, track: schema.kycCases.track, note: schema.kycCases.reviewerNote })
    .from(schema.kycCases)
    .where(eq(schema.kycCases.userId, user.id))
    .orderBy(desc(schema.kycCases.submittedAt))
    .limit(1);
  const identity = user.walletAddress
    ? (await db.select().from(schema.identities).where(eq(schema.identities.address, user.walletAddress)).limit(1))[0]
    : undefined;

  const status = userFacingKycStatus(kyc?.status, identity);
  return {
    id: user.id,
    email: user.email,
    userType: user.userType,
    displayName: user.displayName,
    orgName: user.orgName,
    walletAddress: user.walletAddress,
    adminRoles: user.adminRoles,
    kyc: {
      status,
      track: kyc?.track ?? null,
      // Reviewer notes are only shown when we're asking the user for something.
      message: status === "needs_info" ? kyc?.note ?? null : null,
    },
    identity: identity
      ? { tier: identity.tier, validUntil: identity.validUntil, active: identityIsValid(identity) }
      : null,
  };
}

export type Profile = Awaited<ReturnType<typeof profileFor>>;
