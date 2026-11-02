import type { AssetStatus } from "@tradechainx/shared";

// Response shapes from the TradeChainX API (apps/api/src/routes/*). Numeric token values are strings.

export type AssetView = {
  assetType: "warehouse-receipt" | "lpo" | "carbon";
  tokenId: string;
  title: string;
  status: AssetStatus;
  owner: string | null;
  originator: string;
  terms: Record<string, string>;
  details: Record<string, string | number | string[]>;
  expiresAt: number | null;
  lien: { lienholder: string; maturity: number; agreementRef: string } | null;
  pendingRequest: { kind: number; requester: string; warehouseConfirmed?: boolean; newQuantity?: string; newExpiry?: string; newDueDate?: string } | null;
  totalSupply: string | null;
  retired: string | null;
  suspended: boolean;
};

export type ListingView = {
  listingId: string;
  seller: string;
  assetType: AssetView["assetType"];
  tokenId: string;
  remaining: string;
  pricePerUnit: string;
  feeBps: number;
  active: boolean;
  asset?: AssetView;
};

export type OfferingView = {
  proposalId: string;
  vault: string | null;
  name: string;
  symbol: string;
  operator: string;
  maxShares: string;
  pricePerShare: string;
  deadline: number;
  proposalStatus: number;
  vaultState: number | null;
  sharesSold: string;
  totalYield: string;
  proceeds: string;
  equipment: Record<string, string>;
  details: Record<string, string | number>;
};

export type HistoryItem = { event: string; blockTime: string; txHash: string; explorerUrl?: string | null; args: Record<string, unknown> };

export type PreparedCallJson = {
  contract: import("./chain").ContractKey;
  address: `0x${string}`;
  functionName: string;
  args: unknown[];
  summary: string;
};
