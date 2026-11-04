// Mirrors of on-chain enums. Numeric values MUST match the Solidity declaration order.
// Covered by enums.test.ts against the generated ABIs where the ABI exposes them.

/** IIdentityRegistry.Tier */
export const Tier = {
  None: 0,
  Individual: 1,
  Business: 2,
  Institutional: 3,
  Platform: 4,
} as const;
export type Tier = (typeof Tier)[keyof typeof Tier];

/** Submission status — identical in WarehouseReceipt, LPOToken, CarbonCredits. */
export const SubmissionStatus = {
  None: 0,
  Pending: 1,
  NeedsInfo: 2,
  Approved: 3,
  Rejected: 4,
  Withdrawn: 5,
} as const;
export type SubmissionStatus = (typeof SubmissionStatus)[keyof typeof SubmissionStatus];

/** WarehouseReceipt.RequestKind */
export const ReceiptRequestKind = {
  None: 0,
  Redeem: 1,
  PartialRedeem: 2,
  Void: 3,
  ExtendExpiry: 4,
} as const;
export type ReceiptRequestKind = (typeof ReceiptRequestKind)[keyof typeof ReceiptRequestKind];

/** LPOToken.RequestKind */
export const LpoRequestKind = {
  None: 0,
  SettledOffChain: 1,
  Cancel: 2,
  ExtendDueDate: 3,
} as const;
export type LpoRequestKind = (typeof LpoRequestKind)[keyof typeof LpoRequestKind];

/** XOwnVault.State */
export const VaultState = {
  Fundraising: 0,
  Active: 1,
  Failed: 2,
  Dissolved: 3,
} as const;
export type VaultState = (typeof VaultState)[keyof typeof VaultState];

/** XOwnFactory.ProposalStatus */
export const ProposalStatus = {
  None: 0,
  Pending: 1,
  Approved: 2,
  Rejected: 3,
} as const;

/** Marketplace.AssetKind */
export const AssetKind = {
  None: 0,
  ERC721: 1,
  ERC1155: 2,
} as const;

/** Off-chain names for the four product lines. Used in URLs, DB rows and API payloads. */
export const ASSET_TYPES = ["warehouse-receipt", "lpo", "carbon", "xown"] as const;
export type AssetType = (typeof ASSET_TYPES)[number];

export function isAssetType(v: string): v is AssetType {
  return (ASSET_TYPES as readonly string[]).includes(v);
}

export const ASSET_TYPE_LABEL: Record<AssetType, string> = {
  "warehouse-receipt": "Warehouse receipt",
  lpo: "Purchase order (LPO)",
  carbon: "Carbon credits",
  xown: "XOwn equipment share",
};

/** CommodityUnits.LotStatus */
export const LotStatus = {
  None: 0,
  Pending: 1,
  Attested: 2,
  Live: 3,
  Rejected: 4,
  Withdrawn: 5,
  Depleted: 6,
} as const;
export type LotStatus = (typeof LotStatus)[keyof typeof LotStatus];

/** CommodityUnits.SaleStatus */
export const SaleStatus = {
  None: 0,
  Proposed: 1,
  Approved: 2,
  Completed: 3,
  Cancelled: 4,
} as const;
export type SaleStatus = (typeof SaleStatus)[keyof typeof SaleStatus];
