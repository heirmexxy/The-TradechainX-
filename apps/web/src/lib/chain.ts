import { createPublicClient, http, defineChain, type Abi, type Address, type Chain } from "viem";
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
} from "@tradechainx/shared";

export const CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? 31337);
export const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL ?? "http://127.0.0.1:8545";

export const chain: Chain =
  [foundry, polygonAmoy, polygon, base, arbitrum, celo].find((c) => c.id === CHAIN_ID) ??
  defineChain({
    id: CHAIN_ID,
    name: `Chain ${CHAIN_ID}`,
    nativeCurrency: { name: "Native", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [RPC_URL] } },
  });

export const publicClient = createPublicClient({ chain, transport: http(RPC_URL) });
export const deployment = getDeployment(CHAIN_ID);

export type ContractKey =
  | "identityRegistry"
  | "warehouseRegistry"
  | "warehouseReceipt"
  | "lpoToken"
  | "carbonCredits"
  | "marketplace"
  | "xownFactory"
  | "xownVault"
  | "usdc";

export const ABIS: Record<ContractKey, Abi> = {
  identityRegistry: identityRegistryAbi,
  warehouseRegistry: warehouseRegistryAbi,
  warehouseReceipt: warehouseReceiptAbi,
  lpoToken: lpoTokenAbi,
  carbonCredits: carbonCreditsAbi,
  marketplace: marketplaceAbi,
  xownFactory: xownFactoryAbi,
  xownVault: xownVaultAbi,
  usdc: mockUsdcAbi,
};

export const ADDRESSES = {
  identityRegistry: deployment.identityRegistry,
  warehouseRegistry: deployment.warehouseRegistry,
  warehouseReceipt: deployment.warehouseReceipt,
  lpoToken: deployment.lpoToken,
  carbonCredits: deployment.carbonCredits,
  marketplace: deployment.marketplace,
  xownFactory: deployment.xownFactory,
  usdc: deployment.usdc,
} satisfies Partial<Record<ContractKey, Address>>;

export const ASSET_ADDRESS: Record<"warehouse-receipt" | "lpo" | "carbon", Address> = {
  "warehouse-receipt": deployment.warehouseReceipt,
  lpo: deployment.lpoToken,
  carbon: deployment.carbonCredits,
};

export const ASSET_CONTRACT_KEY: Record<"warehouse-receipt" | "lpo" | "carbon", ContractKey> = {
  "warehouse-receipt": "warehouseReceipt",
  lpo: "lpoToken",
  carbon: "carbonCredits",
};

export function explorerTx(hash: string): string | null {
  const root = chain.blockExplorers?.default.url;
  return root ? `${root}/tx/${hash}` : null;
}
