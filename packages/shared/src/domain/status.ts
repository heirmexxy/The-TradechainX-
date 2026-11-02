import { SubmissionStatus, ReceiptRequestKind, LpoRequestKind, VaultState } from "./enums.ts";

// User-facing wording. PRD §4.2: users see Pending / Verified / Needs Info and never the internal
// review mechanics. Admin screens may show more detail.

export type KycStatus = "not_started" | "pending" | "needs_info" | "verified" | "rejected" | "expired";

export const KYC_STATUS_LABEL: Record<KycStatus, string> = {
  not_started: "Not started",
  pending: "Pending",
  needs_info: "Needs info",
  verified: "Verified",
  rejected: "Not approved",
  expired: "Needs renewal",
};

export const SUBMISSION_STATUS_LABEL: Record<number, string> = {
  [SubmissionStatus.None]: "Draft",
  [SubmissionStatus.Pending]: "In review",
  [SubmissionStatus.NeedsInfo]: "Needs info",
  [SubmissionStatus.Approved]: "Approved",
  [SubmissionStatus.Rejected]: "Not approved",
  [SubmissionStatus.Withdrawn]: "Withdrawn",
};

export const RECEIPT_REQUEST_LABEL: Record<number, string> = {
  [ReceiptRequestKind.None]: "",
  [ReceiptRequestKind.Redeem]: "Collect goods",
  [ReceiptRequestKind.PartialRedeem]: "Collect part of the goods",
  [ReceiptRequestKind.Void]: "Void receipt",
  [ReceiptRequestKind.ExtendExpiry]: "Extend storage term",
};

export const LPO_REQUEST_LABEL: Record<number, string> = {
  [LpoRequestKind.None]: "",
  [LpoRequestKind.SettledOffChain]: "Paid outside the platform",
  [LpoRequestKind.Cancel]: "Order cancelled",
  [LpoRequestKind.ExtendDueDate]: "New due date",
};

export const VAULT_STATE_LABEL: Record<number, string> = {
  [VaultState.Fundraising]: "Open for investment",
  [VaultState.Active]: "Fully funded — earning",
  [VaultState.Failed]: "Did not fill — refunds open",
  [VaultState.Dissolved]: "Closed — redeem your shares",
};

/** Lifecycle of an issued asset as the API and UI describe it. */
export type AssetStatus =
  | "active"
  | "listed"
  | "pledged"
  | "pending_change"
  | "expired"
  | "suspended"
  | "redeemed"
  | "settled"
  | "voided"
  | "cancelled";

export const ASSET_STATUS_LABEL: Record<AssetStatus, string> = {
  active: "Active",
  listed: "For sale",
  pledged: "Pledged",
  pending_change: "Change in review",
  expired: "Expired",
  suspended: "Suspended",
  redeemed: "Redeemed",
  settled: "Paid",
  voided: "Voided",
  cancelled: "Cancelled",
};

/** Precedence when several apply (e.g. a listed asset that has also expired shows "Expired"). */
export function resolveAssetStatus(f: {
  burnedAs?: "redeemed" | "settled" | "voided" | "cancelled";
  suspended?: boolean;
  expiresAt?: number; // unix seconds
  now: number;
  pendingChange?: boolean;
  pledged?: boolean;
  listed?: boolean;
}): AssetStatus {
  if (f.burnedAs) return f.burnedAs;
  if (f.suspended) return "suspended";
  if (f.expiresAt !== undefined && f.expiresAt <= f.now) return "expired";
  if (f.pendingChange) return "pending_change";
  if (f.pledged) return "pledged";
  if (f.listed) return "listed";
  return "active";
}
