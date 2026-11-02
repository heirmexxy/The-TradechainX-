import { BaseError, ContractFunctionRevertedError } from "viem";

// Contract errors → what the person should know or do. Keyed by Solidity custom error name.
const MESSAGES: Record<string, string> = {
  HolderNotVerified: "Both sides of this transfer need to be verified.",
  NotVerified: "Finish verification before doing this.",
  NotVerifiedEntity: "Only verified businesses can do this.",
  NotActiveWarehouseOperator: "Only the operator of an active warehouse can do this.",
  DuplicateReceipt: "This receipt number has already been used at this warehouse.",
  DuplicateLPO: "This purchase order has already been submitted.",
  DuplicateBatch: "This registry batch has already been tokenised.",
  ReviewerConflict: "You can't review something you submitted, hold, or operate.",
  InvalidSubmissionState: "This submission has already been handled.",
  WarehouseInactive: "The warehouse is suspended.",
  ReceiptExpired: "This asset has passed its expiry or due date.",
  TransferBlocked: "This asset can't move right now — it may be pledged, expired, or have a change in review.",
  NotTradable: "This asset can't be sold right now.",
  PriceAboveLimit: "The price changed. Review the new price and try again.",
  AlreadyLiened: "This asset is already pledged.",
  LienNotMatured: "The pledge hasn't reached its maturity date yet.",
  LienholderNotVerifiedEntity: "The lender must be a verified business or institution.",
  InvalidMaturity: "The pledge must mature after today and before the asset expires.",
  RequestPending: "There's already a change in review for this asset.",
  WarehouseConfirmationRequired: "The warehouse needs to confirm release first.",
  HeldByPlatform: "Take it off the market before settling.",
  BatchIsSuspended: "This batch is suspended pending a registry review.",
  SelfPurchase: "You can't buy your own listing.",
  InvalidAmount: "Check the amount.",
  DeadlinePassed: "This offering has closed.",
  NothingToClaim: "There's nothing to collect yet.",
  FeeTooHigh: "The fee can't exceed 5%.",
  EnforcedPause: "Trading is paused while we check something. Your assets are safe.",
  Paused: "This is paused while we check something. Your assets are safe.",
  ERC20InsufficientBalance: "Not enough USDC in your account.",
  ERC20InsufficientAllowance: "The payment wasn't authorised. Try again.",
  AccessControlUnauthorizedAccount: "Your account doesn't have permission for this on-chain.",
};

export function friendlyError(err: unknown): string {
  if (err instanceof BaseError) {
    const revert = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError) {
      const name = revert.data?.errorName;
      if (name && MESSAGES[name]) return MESSAGES[name]!;
      if (name) return `The transaction was refused (${name}).`;
    }
    return err.shortMessage;
  }
  if (err instanceof Error) return err.message;
  return "Something went wrong.";
}
