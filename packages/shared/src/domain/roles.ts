import { Tier } from "./enums.ts";

// Who does what. User types come from PRD §4.1; admin roles from §4.4.

export const USER_TYPES = ["trader", "warehouse", "sme", "originator", "investor", "lender"] as const;
export type UserType = (typeof USER_TYPES)[number];

export const USER_TYPE_LABEL: Record<UserType, string> = {
  trader: "Commodity trader / aggregator",
  warehouse: "Warehouse operator",
  sme: "SME / agribusiness (LPO holder)",
  originator: "Carbon credit originator",
  investor: "Investor",
  lender: "Lender / financial institution",
};

/** PRD §4.2 step 3: individuals get light KYC, businesses full KYB, institutions are onboarded off-platform. */
export const KYC_TIER_FOR: Record<UserType, Tier> = {
  trader: Tier.Individual,
  investor: Tier.Individual,
  warehouse: Tier.Business,
  sme: Tier.Business,
  originator: Tier.Business,
  lender: Tier.Institutional,
};

export type KycRequirement = { key: string; label: string };

export const KYC_REQUIREMENTS: Record<"individual" | "business", KycRequirement[]> = {
  individual: [
    { key: "government_id", label: "Government-issued ID" },
    { key: "selfie", label: "Selfie for liveness check" },
  ],
  business: [
    { key: "cac_certificate", label: "Business registration (CAC certificate)" },
    { key: "signatory_id", label: "Authorised signatory's ID" },
    { key: "proof_of_address", label: "Proof of address / facility" },
  ],
};

export function kycTrackFor(type: UserType): "individual" | "business" {
  const t = KYC_TIER_FOR[type];
  return t === Tier.Individual ? "individual" : "business";
}

/** What each user type can do once verified. Drives navigation; the contracts enforce the real rules. */
export const CAPABILITIES: Record<UserType, readonly string[]> = {
  trader: ["hold", "trade", "pledge", "redeem"],
  investor: ["hold", "trade", "xown"],
  warehouse: ["hold", "trade", "issue_receipts", "confirm_releases"],
  sme: ["hold", "trade", "issue_lpos", "settle_lpos"],
  originator: ["hold", "trade", "issue_carbon", "retire"],
  lender: ["hold", "trade", "finance"],
};

export function can(type: UserType, capability: string): boolean {
  return CAPABILITIES[type].includes(capability);
}

// Admin roles map 1:1 to on-chain roles. The contract is the source of truth; the DB copy is for
// showing the right screens.
export const ADMIN_ROLES = [
  "kyc_reviewer",
  "listing_reviewer",
  "warehouse_registrar",
  "asset_manager",
  "pauser",
  "super_admin",
] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

export const ADMIN_ROLE_LABEL: Record<AdminRole, string> = {
  kyc_reviewer: "KYC/KYB reviewer",
  listing_reviewer: "Listing reviewer",
  warehouse_registrar: "Warehouse registrar",
  asset_manager: "XOwn asset manager",
  pauser: "Emergency pauser",
  super_admin: "Super admin",
};

/** Solidity role name (keccak256 of this string is the role id) — DEFAULT_ADMIN_ROLE is bytes32(0). */
export const ONCHAIN_ROLE_NAME: Record<Exclude<AdminRole, "super_admin">, string> = {
  kyc_reviewer: "KYC_REVIEWER_ROLE",
  listing_reviewer: "LISTING_REVIEWER_ROLE",
  warehouse_registrar: "WAREHOUSE_REGISTRAR_ROLE",
  asset_manager: "ASSET_MANAGER_ROLE",
  pauser: "PAUSER_ROLE",
};
