// The AssetModule registry (PRD v3 §4.1–4.2): one table describing how each asset type plugs into the
// tokenization engine and the Distribution API. Adding an asset type = adding an entry and implementing
// its module; the engine, registry, market and API shapes stay the same.

export const DistributionAssetType = {
  CommodityUnit: "commodity_unit",
  WarehouseReceipt: "warehouse_receipt",
  Lpo: "lpo",
  CarbonCredit: "carbon_credit",
  Xown: "xown",
} as const;
export type DistributionAssetType = (typeof DistributionAssetType)[keyof typeof DistributionAssetType];

export type TradingMode = "pooled" | "unique" | "primary_only" | "primary_and_resale";
export type PriceSource = "reference_price" | "issuer_set" | "face_value_discount" | "offering_price";
export type CustomerTier = "retail" | "qualified" | "institutional";

export interface AssetModule {
  type: DistributionAssetType;
  label: string;
  tradingMode: TradingMode;
  priceSource: PriceSource;
  /** How a holder realises value. */
  exits: readonly string[];
  /** Does Kitovu quote both sides (instant buyback)? Only for pooled commodity units at launch. */
  marketMaking: boolean;
  /**
   * Default eligibility. These are PRODUCT DEFAULTS pending counsel's view (PRD v3 §9.3); each
   * distributor's agreement can narrow them but never widen them without a compliance sign-off.
   */
  defaultEligibleTiers: readonly CustomerTier[];
  /** Does every individual offering need its own approval before distribution? */
  perOfferingApproval: boolean;
  /** Disclosure pack that must be accepted by the distributor and shown to the customer. */
  disclosures: readonly string[];
  /** Contract that implements the asset (name in the deployment file). */
  contract: "commodityUnits" | "warehouseReceipt" | "lpoToken" | "carbonCredits" | "xownFactory";
}

export const assetModules: Record<DistributionAssetType, AssetModule> = {
  commodity_unit: {
    type: "commodity_unit",
    label: "Commodity Units",
    tradingMode: "pooled",
    priceSource: "reference_price",
    exits: ["sell to another user", "instant buyback", "processor sale"],
    marketMaking: true,
    defaultEligibleTiers: ["retail", "qualified", "institutional"],
    perOfferingApproval: false,
    disclosures: ["price_risk", "no_fixed_return", "holding_cost", "buyback_limits", "stock_proof"],
    contract: "commodityUnits",
  },
  warehouse_receipt: {
    type: "warehouse_receipt",
    label: "Warehouse receipts",
    tradingMode: "unique",
    priceSource: "issuer_set",
    exits: ["resale", "pledge", "redemption of goods"],
    marketMaking: false,
    defaultEligibleTiers: ["qualified", "institutional"],
    perOfferingApproval: false,
    disclosures: ["asset_specific_risk", "storage_terms", "redemption_terms"],
    contract: "warehouseReceipt",
  },
  lpo: {
    type: "lpo",
    label: "LPOs",
    tradingMode: "primary_and_resale",
    priceSource: "face_value_discount",
    exits: ["buyer settlement pays holder", "resale"],
    marketMaking: false,
    defaultEligibleTiers: ["qualified", "institutional"],
    perOfferingApproval: false,
    disclosures: ["buyer_default_risk", "maturity", "discount_not_guaranteed_return"],
    contract: "lpoToken",
  },
  carbon_credit: {
    type: "carbon_credit",
    label: "Carbon credits",
    tradingMode: "primary_and_resale",
    priceSource: "issuer_set",
    exits: ["resale", "retirement with certificate"],
    marketMaking: false,
    defaultEligibleTiers: ["retail", "qualified", "institutional"],
    perOfferingApproval: false,
    disclosures: ["registry_reference", "vintage", "retirement_is_permanent"],
    contract: "carbonCredits",
  },
  xown: {
    type: "xown",
    label: "Fractional equipment ownership (XOwn)",
    tradingMode: "primary_and_resale",
    priceSource: "offering_price",
    exits: ["resale", "earnings distributions", "dissolution and redemption"],
    marketMaking: false,
    defaultEligibleTiers: ["retail", "qualified", "institutional"],
    perOfferingApproval: true,
    disclosures: ["earnings_not_guaranteed", "operator_risk", "illiquidity", "dissolution_terms"],
    contract: "xownFactory",
  },
};

export const distributionAssetTypes = Object.keys(assetModules) as DistributionAssetType[];

/**
 * The existing four product-line names (URLs, DB rows, current API payloads) use hyphens; the
 * Distribution API and its tables use underscores and add commodity units. This maps one to the other.
 */
export function toDistributionType(assetType: "warehouse-receipt" | "lpo" | "carbon" | "xown"): DistributionAssetType {
  switch (assetType) {
    case "warehouse-receipt": return "warehouse_receipt";
    case "carbon": return "carbon_credit";
    case "lpo": return "lpo";
    case "xown": return "xown";
  }
}

export interface DistributorAssetGrant {
  /** Production enablement for this distributor and asset (PRD v3 §4.2 gate). */
  enabled: boolean;
  /** Narrowing only: tiers the distributor has agreed to serve for this asset. */
  tiers: readonly CustomerTier[];
  /** Disclosure pack versions the distributor has accepted. */
  acceptedDisclosures: readonly string[];
}

/** Why a customer cannot be offered an asset through a distributor, or null if they can. */
export function eligibilityBlock(
  type: DistributionAssetType,
  customerTier: CustomerTier,
  grant: DistributorAssetGrant | undefined,
): string | null {
  const m = assetModules[type];
  if (!grant || !grant.enabled) return "asset_not_enabled_for_distributor";
  if (!m.defaultEligibleTiers.includes(customerTier)) return "tier_not_eligible_by_default";
  if (!grant.tiers.includes(customerTier)) return "tier_not_in_distributor_grant";
  for (const d of m.disclosures) {
    if (!grant.acceptedDisclosures.includes(d)) return `disclosure_not_accepted:${d}`;
  }
  return null;
}
