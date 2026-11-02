import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { getAddress, type Hex } from "viem";
import { parseUsdc, toBytes32Code, normalizeReference, Tier } from "@tradechainx/shared";
import { db, schema } from "../db/client.ts";
import { env } from "../env.ts";
import { badRequest, conflict } from "../lib/errors.ts";
import { referenceHash, receiptKey, lpoKey, batchKey, documentBundleHash } from "../lib/hash.ts";
import { identityIsValid } from "./profile.ts";
import type { User } from "../plugins/auth.ts";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const toUnix = (d: string) => Math.floor(Date.parse(`${d}T00:00:00Z`) / 1000);
const code = z.string().trim().min(1).max(31);

export const metadataUri = (draftId: string) => `${env.PUBLIC_API_URL}/metadata/draft/${draftId}`;

async function verifiedWalletFor(email: string, opts: { entity?: boolean } = {}) {
  const [u] = await db.select().from(schema.users).where(eq(schema.users.email, email.trim().toLowerCase())).limit(1);
  if (!u?.walletAddress) throw badRequest(`${email} doesn't have a TradeChainX account yet.`, "unknown_counterparty");
  const [id] = await db.select().from(schema.identities).where(eq(schema.identities.address, u.walletAddress)).limit(1);
  if (!identityIsValid(id)) throw badRequest(`${email} hasn't finished verification yet.`, "counterparty_unverified");
  if (opts.entity && id!.tier !== Tier.Business && id!.tier !== Tier.Institutional) {
    throw badRequest(`${email} must be a verified business.`, "counterparty_not_business");
  }
  return getAddress(u.walletAddress);
}

// ---------------------------------------------------------------- warehouse receipts

export const receiptFields = z.object({
  warehouseId: z.coerce.number().int().positive(),
  receiptNumber: z.string().trim().min(1).max(64),
  commodity: code,
  grade: code,
  quantity: z.coerce.number().int().positive().max(1e12),
  unit: z.enum(["kg", "tonne", "bag"]).default("kg"),
  depositDate: date,
  expiryDate: date,
  holderEmail: z.string().email(),
  notes: z.string().max(1000).optional(),
});

export async function buildReceipt(user: User, draftId: string, raw: unknown, docShas: string[]) {
  const f = receiptFields.parse(raw);
  const [wh] = await db.select().from(schema.warehouses).where(eq(schema.warehouses.id, String(f.warehouseId))).limit(1);
  if (!wh || !wh.active) throw badRequest("That warehouse isn't active.");
  if (wh.operator !== user.walletAddress) throw badRequest("You're not the operator of that warehouse.");
  if (toUnix(f.expiryDate) <= toUnix(f.depositDate)) throw badRequest("Expiry must be after the deposit date.");

  const holder = await verifiedWalletFor(f.holderEmail);
  const receiptNumberHash = referenceHash(f.receiptNumber);
  const terms = {
    warehouseId: BigInt(f.warehouseId),
    receiptNumberHash,
    commodity: toBytes32Code(f.commodity),
    grade: toBytes32Code(f.grade),
    quantity: BigInt(f.quantity),
    depositDate: BigInt(toUnix(f.depositDate)),
    expiryDate: BigInt(toUnix(f.expiryDate)),
    documentHash: documentBundleHash(docShas),
    metadataURI: metadataUri(draftId),
  };
  return {
    fields: { ...f, receiptNumber: normalizeReference(f.receiptNumber) },
    terms,
    extra: { holder },
    keyHash: receiptKey(terms.warehouseId, receiptNumberHash),
  };
}

// ---------------------------------------------------------------- LPOs

export const lpoFields = z.object({
  lpoNumber: z.string().trim().min(1).max(64),
  buyerName: z.string().trim().min(2).max(200),
  buyerRegistrationNumber: z.string().trim().min(3).max(40),
  description: code,
  faceValue: z.string().trim().min(1),
  issueDate: date,
  dueDate: date,
  notes: z.string().max(1000).optional(),
});

export async function buildLpo(_user: User, draftId: string, raw: unknown, docShas: string[]) {
  const f = lpoFields.parse(raw);
  const faceValue = parseUsdc(f.faceValue);
  if (faceValue <= 0n) throw badRequest("Face value must be more than zero.");
  if (toUnix(f.dueDate) <= toUnix(f.issueDate)) throw badRequest("Due date must be after the issue date.");
  const lpoNumberHash = referenceHash(f.lpoNumber);
  const buyerRefHash = referenceHash(f.buyerRegistrationNumber);
  const terms = {
    lpoNumberHash,
    buyerRefHash,
    description: toBytes32Code(f.description),
    faceValue,
    issueDate: BigInt(toUnix(f.issueDate)),
    dueDate: BigInt(toUnix(f.dueDate)),
    documentHash: documentBundleHash(docShas),
    metadataURI: metadataUri(draftId),
  };
  return {
    fields: { ...f, lpoNumber: normalizeReference(f.lpoNumber), buyerRegistrationNumber: normalizeReference(f.buyerRegistrationNumber) },
    terms,
    extra: {},
    keyHash: lpoKey(buyerRefHash, lpoNumberHash),
  };
}

// ---------------------------------------------------------------- carbon

export const carbonFields = z.object({
  registry: z.enum(["VERRA", "GOLD_STANDARD", "PURO_EARTH", "ISOMETRIC", "OTHER"]),
  registryBatchId: z.string().trim().min(1).max(128),
  projectId: z.string().trim().min(1).max(64),
  projectName: z.string().trim().min(2).max(200),
  methodology: code,
  vintage: z.coerce.number().int().min(2000).max(new Date().getUTCFullYear()),
  quantity: z.coerce.number().int().positive().max(1e12),
  country: z.string().trim().max(60).optional(),
  notes: z.string().max(1000).optional(),
});

export async function buildCarbon(_user: User, draftId: string, raw: unknown, docShas: string[]) {
  const f = carbonFields.parse(raw);
  const registry = toBytes32Code(f.registry);
  const registryBatchIdHash = referenceHash(f.registryBatchId);
  const terms = {
    registry,
    registryBatchIdHash,
    projectIdHash: referenceHash(f.projectId),
    methodology: toBytes32Code(f.methodology),
    vintage: f.vintage,
    quantity: BigInt(f.quantity),
    documentHash: documentBundleHash(docShas),
    metadataURI: metadataUri(draftId),
  };
  return { fields: f, terms, extra: {}, keyHash: batchKey(registry, registryBatchIdHash) };
}

// ---------------------------------------------------------------- XOwn offerings (asset manager)

export const xownFields = z.object({
  name: z.string().trim().min(3).max(80),
  symbol: z.string().trim().regex(/^[A-Z0-9-]{2,12}$/, "2–12 capital letters, digits or dashes"),
  operatorEmail: z.string().email(),
  maxShares: z.coerce.number().int().min(1).max(1_000_000),
  pricePerShare: z.string().trim().min(1),
  subscriptionDeadline: date,
  equipmentType: code,
  serialNumber: z.string().trim().min(1).max(64),
  description: z.string().trim().min(10).max(2000),
  location: z.string().trim().min(2).max(200),
  expectedAnnualYieldPct: z.coerce.number().min(0).max(100).optional(),
});

export async function buildXown(_user: User, draftId: string, raw: unknown, docShas: string[]) {
  const f = xownFields.parse(raw);
  const operator = await verifiedWalletFor(f.operatorEmail, { entity: true });
  const pricePerShare = parseUsdc(f.pricePerShare);
  if (pricePerShare <= 0n) throw badRequest("Price per share must be more than zero.");
  const serialHash = referenceHash(f.serialNumber);
  const terms = {
    name: f.name,
    symbol: f.symbol,
    operator,
    maxShares: BigInt(f.maxShares),
    pricePerShare,
    subscriptionDeadline: BigInt(toUnix(f.subscriptionDeadline)),
    equipment: {
      assetType: toBytes32Code(f.equipmentType),
      serialHash,
      documentHash: documentBundleHash(docShas),
      metadataURI: metadataUri(draftId),
    },
  };
  return { fields: { ...f, serialNumber: normalizeReference(f.serialNumber) }, terms, extra: {}, keyHash: serialHash };
}

// ---------------------------------------------------------------- warehouses (registrar)

export const warehouseFields = z.object({
  operatorEmail: z.string().email(),
  name: z.string().trim().min(2).max(120),
  licenceNumber: z.string().trim().min(2).max(64),
  address: z.string().trim().min(5).max(300),
  state: z.string().trim().min(2).max(60),
  capacityTonnes: z.coerce.number().int().positive().max(10_000_000),
  commodities: z.array(code).min(1).max(20),
});

export async function buildWarehouse(_user: User, draftId: string, raw: unknown, _docShas: string[]) {
  const f = warehouseFields.parse(raw);
  const operator = await verifiedWalletFor(f.operatorEmail, { entity: true });
  const licenceRef = referenceHash(f.licenceNumber);
  return {
    fields: { ...f, licenceNumber: normalizeReference(f.licenceNumber) },
    terms: { operator, licenceRef, metadataURI: metadataUri(draftId) },
    extra: {},
    keyHash: licenceRef,
  };
}

// ---------------------------------------------------------------- helpers

/** Refuses a second live draft for the same on-chain key (e.g. the same receipt number twice). */
export async function assertNoLiveDuplicate(assetType: string, keyHash: Hex, exceptDraftId?: string) {
  const rows = await db
    .select({ id: schema.drafts.id })
    .from(schema.drafts)
    .where(and(eq(schema.drafts.assetType, assetType as never), eq(schema.drafts.keyHash, keyHash)));
  const others = rows.filter((r) => r.id !== exceptDraftId);
  if (others.length === 0) return;
  // A previous draft with this key is only a problem if it reached the chain and wasn't rejected/withdrawn.
  const live = await db
    .select({ status: schema.submissions.status })
    .from(schema.submissions)
    .where(and(eq(schema.submissions.assetType, assetType), eq(schema.submissions.keyHash, keyHash)));
  if (live.some((s) => s.status === 1 || s.status === 2 || s.status === 3)) {
    throw conflict("This reference has already been submitted.", "duplicate");
  }
}
