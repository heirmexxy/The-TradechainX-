import { createPublicClient, http, defineChain, type Address, type Abi, type Chain } from "viem";
import { foundry, polygonAmoy, polygon, base, arbitrum, celo } from "viem/chains";
import {
  getDeployment,
  identityRegistryAbi,
  warehouseRegistryAbi,
  warehouseReceiptAbi,
  lpoTokenAbi,
  carbonCreditsAbi,
  marketplaceAbi,
  xownFactoryAbi,
  xownVaultAbi,
  mockUsdcAbi,
  type AssetType,
} from "@tradechainx/shared";
import { env } from "./env.ts";

const KNOWN_CHAINS: Chain[] = [foundry, polygonAmoy, polygon, base, arbitrum, celo];

export const chain: Chain =
  KNOWN_CHAINS.find((c) => c.id === env.CHAIN_ID) ??
  defineChain({
    id: env.CHAIN_ID,
    name: `Chain ${env.CHAIN_ID}`,
    nativeCurrency: { name: "Native", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [env.RPC_URL] } },
  });

export const publicClient = createPublicClient({ chain, transport: http(env.RPC_URL, { retryCount: 3 }) });

export const deployment = getDeployment(env.CHAIN_ID);

export type ContractName =
  | "IdentityRegistry"
  | "WarehouseRegistry"
  | "WarehouseReceipt"
  | "LPOToken"
  | "CarbonCredits"
  | "Marketplace"
  | "XOwnFactory"
  | "XOwnVault";

type Entry = { name: ContractName; abi: Abi; address: Address };

const lc = (a: string) => a.toLowerCase() as Address;

/** Static contracts from the deployment. XOwn vaults are added as the indexer discovers them. */
export const contracts = {
  identityRegistry: { name: "IdentityRegistry", abi: identityRegistryAbi, address: lc(deployment.identityRegistry) },
  warehouseRegistry: { name: "WarehouseRegistry", abi: warehouseRegistryAbi, address: lc(deployment.warehouseRegistry) },
  warehouseReceipt: { name: "WarehouseReceipt", abi: warehouseReceiptAbi, address: lc(deployment.warehouseReceipt) },
  lpoToken: { name: "LPOToken", abi: lpoTokenAbi, address: lc(deployment.lpoToken) },
  carbonCredits: { name: "CarbonCredits", abi: carbonCreditsAbi, address: lc(deployment.carbonCredits) },
  marketplace: { name: "Marketplace", abi: marketplaceAbi, address: lc(deployment.marketplace) },
  xownFactory: { name: "XOwnFactory", abi: xownFactoryAbi, address: lc(deployment.xownFactory) },
} as const satisfies Record<string, Entry>;

export const usdc = { abi: mockUsdcAbi, address: lc(deployment.usdc) };
export const vaultAbi = xownVaultAbi;

/** Which contract backs which product line. */
export const ASSET_CONTRACT: Record<Exclude<AssetType, "xown">, Address> = {
  "warehouse-receipt": contracts.warehouseReceipt.address,
  lpo: contracts.lpoToken.address,
  carbon: contracts.carbonCredits.address,
};

export function assetTypeForAddress(address: string): Exclude<AssetType, "xown"> | undefined {
  const a = address.toLowerCase();
  for (const [type, addr] of Object.entries(ASSET_CONTRACT)) if (addr === a) return type as Exclude<AssetType, "xown">;
  return undefined;
}

export function explorerTxUrl(txHash: string): string | undefined {
  const root = chain.blockExplorers?.default.url;
  return root ? `${root}/tx/${txHash}` : undefined;
}
