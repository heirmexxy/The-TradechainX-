// Typed view of migrations/*.sql for Drizzle queries. The SQL files are the source of truth for the
// database; keep this in sync when adding a migration.
import {
  pgTable,
  uuid,
  text,
  integer,
  bigint,
  boolean,
  timestamp,
  jsonb,
  numeric,
  primaryKey,
  date,
  serial,
} from "drizzle-orm/pg-core";

const big = (name: string) => numeric(name, { precision: 78, scale: 0 });
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const blockNo = (name: string) => bigint(name, { mode: "number" });

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  userType: text("user_type").$type<"trader" | "warehouse" | "sme" | "originator" | "investor" | "lender">(),
  displayName: text("display_name"),
  orgName: text("org_name"),
  walletAddress: text("wallet_address").unique(),
  adminRoles: text("admin_roles").array().notNull().default([]),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const loginCodes = pgTable("login_codes", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull(),
  codeHash: text("code_hash").notNull(),
  expiresAt: ts("expires_at").notNull(),
  attempts: integer("attempts").notNull().default(0),
  consumedAt: ts("consumed_at"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const walletChallenges = pgTable("wallet_challenges", {
  userId: uuid("user_id").primaryKey().references(() => users.id),
  nonce: text("nonce").notNull(),
  expiresAt: ts("expires_at").notNull(),
});

export const documents = pgTable("documents", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerUserId: uuid("owner_user_id").notNull().references(() => users.id),
  kind: text("kind").notNull(),
  filename: text("filename").notNull(),
  mime: text("mime").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  sha256: text("sha256").notNull(),
  storageKey: text("storage_key").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export type KycCaseStatus = "pending" | "needs_info" | "approved" | "verified" | "rejected";

export const kycCases = pgTable("kyc_cases", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id),
  track: text("track").$type<"individual" | "business">().notNull(),
  status: text("status").$type<KycCaseStatus>().notNull(),
  details: jsonb("details").$type<Record<string, unknown>>().notNull(),
  documentIds: uuid("document_ids").array().notNull().default([]),
  recordRef: text("record_ref").notNull().unique(),
  approvedTier: integer("approved_tier"),
  approvedValidUntil: bigint("approved_valid_until", { mode: "number" }),
  reviewerNote: text("reviewer_note"),
  reviewedBy: uuid("reviewed_by").references(() => users.id),
  submittedAt: ts("submitted_at").notNull().defaultNow(),
  reviewedAt: ts("reviewed_at"),
  verifiedAt: ts("verified_at"),
});

export type DraftAssetType = "warehouse-receipt" | "lpo" | "carbon" | "xown" | "warehouse";

export const drafts = pgTable("drafts", {
  id: uuid("id").primaryKey().defaultRandom(),
  assetType: text("asset_type").$type<DraftAssetType>().notNull(),
  ownerUserId: uuid("owner_user_id").notNull().references(() => users.id),
  fields: jsonb("fields").$type<Record<string, unknown>>().notNull(),
  terms: jsonb("terms").$type<Record<string, unknown>>().notNull(),
  keyHash: text("key_hash").notNull(),
  documentIds: uuid("document_ids").array().notNull().default([]),
  submissionId: big("submission_id"),
  txHash: text("tx_hash"),
  partnerId: uuid("partner_id"),
  apiKeyId: uuid("api_key_id"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const chainCursor = pgTable("chain_cursor", {
  name: text("name").primaryKey(),
  chainId: integer("chain_id").notNull(),
  lastBlock: blockNo("last_block").notNull(),
});

export const chainEvents = pgTable(
  "chain_events",
  {
    chainId: integer("chain_id").notNull(),
    txHash: text("tx_hash").notNull(),
    logIndex: integer("log_index").notNull(),
    blockNumber: blockNo("block_number").notNull(),
    blockTime: ts("block_time").notNull(),
    contract: text("contract").notNull(),
    contractName: text("contract_name").notNull(),
    event: text("event").notNull(),
    args: jsonb("args").$type<Record<string, unknown>>().notNull(),
    entityType: text("entity_type"),
    entityId: text("entity_id"),
  },
  (t) => ({ pk: primaryKey({ columns: [t.chainId, t.txHash, t.logIndex] }) }),
);

export const identities = pgTable("identities", {
  address: text("address").primaryKey(),
  tier: integer("tier").notNull(),
  validUntil: bigint("valid_until", { mode: "number" }).notNull(),
  frozen: boolean("frozen").notNull(),
  recordRef: text("record_ref").notNull(),
  updatedBlock: blockNo("updated_block").notNull(),
});

export const warehouses = pgTable("warehouses", {
  id: big("id").primaryKey(),
  operator: text("operator").notNull(),
  licenceRef: text("licence_ref").notNull(),
  active: boolean("active").notNull(),
  metadataUri: text("metadata_uri").notNull(),
  updatedBlock: blockNo("updated_block").notNull(),
});

export const submissions = pgTable(
  "submissions",
  {
    assetType: text("asset_type").notNull(),
    submissionId: big("submission_id").notNull(),
    submitter: text("submitter").notNull(),
    holder: text("holder"),
    status: integer("status").notNull(),
    keyHash: text("key_hash").notNull(),
    tokenId: big("token_id"),
    terms: jsonb("terms").$type<Record<string, unknown>>().notNull(),
    draftId: uuid("draft_id").references(() => drafts.id),
    updatedBlock: blockNo("updated_block").notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.assetType, t.submissionId] }) }),
);

export type LienJson = { lienholder: string; maturity: number; agreementRef: string };
export type RequestJson = { kind: number; requester: string; [k: string]: unknown };

export const assets = pgTable(
  "assets",
  {
    assetType: text("asset_type").notNull(),
    tokenId: big("token_id").notNull(),
    owner: text("owner"),
    originator: text("originator").notNull(),
    terms: jsonb("terms").$type<Record<string, unknown>>().notNull(),
    expiresAt: bigint("expires_at", { mode: "number" }),
    burnedAs: text("burned_as").$type<"redeemed" | "settled" | "voided" | "cancelled">(),
    suspended: boolean("suspended").notNull().default(false),
    totalSupply: big("total_supply"),
    retired: big("retired"),
    lien: jsonb("lien").$type<LienJson | null>(),
    pendingRequest: jsonb("pending_request").$type<RequestJson | null>(),
    submissionId: big("submission_id"),
    draftId: uuid("draft_id").references(() => drafts.id),
    issuedBlock: blockNo("issued_block").notNull(),
    updatedBlock: blockNo("updated_block").notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.assetType, t.tokenId] }) }),
);

export const carbonBalances = pgTable(
  "carbon_balances",
  {
    batchId: big("batch_id").notNull(),
    holder: text("holder").notNull(),
    amount: big("amount").notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.batchId, t.holder] }) }),
);

export const retirements = pgTable("retirements", {
  retirementId: big("retirement_id").primaryKey(),
  batchId: big("batch_id").notNull(),
  holder: text("holder").notNull(),
  amount: big("amount").notNull(),
  beneficiaryRef: text("beneficiary_ref").notNull(),
  reasonRef: text("reason_ref").notNull(),
  txHash: text("tx_hash").notNull(),
  blockTime: ts("block_time").notNull(),
});

export const listings = pgTable("listings", {
  listingId: big("listing_id").primaryKey(),
  seller: text("seller").notNull(),
  assetType: text("asset_type").notNull(),
  assetAddress: text("asset_address").notNull(),
  tokenId: big("token_id").notNull(),
  remaining: big("remaining").notNull(),
  pricePerUnit: big("price_per_unit").notNull(),
  feeBps: integer("fee_bps").notNull(),
  active: boolean("active").notNull(),
  createdBlock: blockNo("created_block").notNull(),
  updatedBlock: blockNo("updated_block").notNull(),
});

export const trades = pgTable(
  "trades",
  {
    txHash: text("tx_hash").notNull(),
    logIndex: integer("log_index").notNull(),
    listingId: big("listing_id").notNull(),
    buyer: text("buyer").notNull(),
    seller: text("seller").notNull(),
    amount: big("amount").notNull(),
    total: big("total").notNull(),
    fee: big("fee").notNull(),
    blockTime: ts("block_time").notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.txHash, t.logIndex] }) }),
);

export const xownOfferings = pgTable("xown_offerings", {
  proposalId: big("proposal_id").primaryKey(),
  vault: text("vault").unique(),
  proposer: text("proposer").notNull(),
  operator: text("operator").notNull(),
  name: text("name").notNull(),
  symbol: text("symbol").notNull(),
  maxShares: big("max_shares").notNull(),
  pricePerShare: big("price_per_share").notNull(),
  deadline: bigint("deadline", { mode: "number" }).notNull(),
  proposalStatus: integer("proposal_status").notNull(),
  vaultState: integer("vault_state"),
  equipmentId: big("equipment_id"),
  equipment: jsonb("equipment").$type<Record<string, unknown>>().notNull(),
  sharesSold: big("shares_sold").notNull().default("0"),
  totalYield: big("total_yield").notNull().default("0"),
  proceeds: big("proceeds").notNull().default("0"),
  draftId: uuid("draft_id").references(() => drafts.id),
  updatedBlock: blockNo("updated_block").notNull(),
});

export const xownHoldings = pgTable(
  "xown_holdings",
  {
    vault: text("vault").notNull(),
    holder: text("holder").notNull(),
    shares: big("shares").notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.vault, t.holder] }) }),
);

export const reviewNotes = pgTable("review_notes", {
  id: uuid("id").primaryKey().defaultRandom(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull(),
  note: text("note").notNull(),
  reasonRef: text("reason_ref").notNull(),
  authorId: uuid("author_id").notNull().references(() => users.id),
  createdAt: ts("created_at").notNull().defaultNow(),
});

// ---------------------------------------------------------------- operations (0003)

export const gasTopups = pgTable("gas_topups", {
  id: uuid("id").primaryKey().defaultRandom(),
  address: text("address").notNull(),
  amountWei: big("amount_wei").notNull(),
  txHash: text("tx_hash").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export type RampStatus = "created" | "pending" | "completed" | "failed" | "cancelled";

export const rampTransactions = pgTable("ramp_transactions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id),
  provider: text("provider").notNull(),
  providerRef: text("provider_ref"),
  direction: text("direction").$type<"deposit" | "withdraw">().notNull(),
  status: text("status").$type<RampStatus>().notNull(),
  fiatCurrency: text("fiat_currency").notNull(),
  fiatAmount: numeric("fiat_amount", { precision: 20, scale: 2 }),
  usdcAmount: big("usdc_amount"),
  walletAddress: text("wallet_address").notNull(),
  txHash: text("tx_hash"),
  raw: jsonb("raw").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export type HealthStatus = "ok" | "degraded" | "down" | "unknown" | "disabled";

export const healthChecks = pgTable("health_checks", {
  name: text("name").primaryKey(),
  category: text("category").$type<"platform" | "provider" | "supplier">().notNull(),
  status: text("status").$type<HealthStatus>().notNull(),
  detail: text("detail").notNull(),
  latencyMs: integer("latency_ms"),
  data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
  checkedAt: ts("checked_at").notNull(),
  changedAt: ts("changed_at").notNull(),
});

export const healthEvents = pgTable("health_events", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  fromStatus: text("from_status"),
  toStatus: text("to_status").notNull(),
  detail: text("detail").notNull(),
  alerted: boolean("alerted").notNull().default(false),
  createdAt: ts("created_at").notNull().defaultNow(),
});

// ---------------------------------------------------------------- partner API (0004)

export type PartnerScope = "read" | "issue" | "trade";

export const partners = pgTable("partners", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  accountUserId: uuid("account_user_id").notNull().unique().references(() => users.id),
  contactEmail: text("contact_email").notNull(),
  website: text("website"),
  referralCode: text("referral_code").notNull().unique(),
  status: text("status").$type<"active" | "suspended">().notNull().default("active"),
  createdBy: uuid("created_by").notNull().references(() => users.id),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const apiKeys = pgTable("api_keys", {
  id: uuid("id").primaryKey().defaultRandom(),
  partnerId: uuid("partner_id").notNull().references(() => partners.id),
  name: text("name").notNull(),
  prefix: text("prefix").notNull().unique(),
  keyHash: text("key_hash").notNull().unique(),
  scopes: text("scopes").array().$type<PartnerScope[]>().notNull(),
  rateLimitPerMinute: integer("rate_limit_per_minute").notNull().default(60),
  dailyQuota: integer("daily_quota").notNull().default(10000),
  lastUsedAt: ts("last_used_at"),
  revokedAt: ts("revoked_at"),
  createdBy: uuid("created_by").notNull().references(() => users.id),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const apiUsage = pgTable(
  "api_usage",
  {
    apiKeyId: uuid("api_key_id").notNull(),
    day: date("day").notNull(),
    requests: integer("requests").notNull().default(0),
  },
  (t) => ({ pk: primaryKey({ columns: [t.apiKeyId, t.day] }) }),
);

export const webhooks = pgTable("webhooks", {
  id: uuid("id").primaryKey().defaultRandom(),
  partnerId: uuid("partner_id").notNull().references(() => partners.id),
  url: text("url").notNull(),
  events: text("events").array().notNull(),
  secretVersion: integer("secret_version").notNull().default(1),
  active: boolean("active").notNull().default(true),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const webhookDeliveries = pgTable("webhook_deliveries", {
  id: uuid("id").primaryKey().defaultRandom(),
  webhookId: uuid("webhook_id").notNull().references(() => webhooks.id),
  eventId: text("event_id").notNull(),
  eventType: text("event_type").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  status: text("status").$type<"pending" | "delivered" | "failed">().notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  nextAttemptAt: ts("next_attempt_at").notNull().defaultNow(),
  lastStatusCode: integer("last_status_code"),
  lastError: text("last_error"),
  createdAt: ts("created_at").notNull().defaultNow(),
  deliveredAt: ts("delivered_at"),
});

export const referrals = pgTable("referrals", {
  id: uuid("id").primaryKey().defaultRandom(),
  partnerId: uuid("partner_id").notNull().references(() => partners.id),
  userId: uuid("user_id").references(() => users.id),
  targetType: text("target_type").$type<"listing" | "xown">().notNull(),
  targetId: text("target_id").notNull(),
  txHash: text("tx_hash"),
  createdAt: ts("created_at").notNull().defaultNow(),
});
