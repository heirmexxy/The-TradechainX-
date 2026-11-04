// Production wiring for the Distribution service: Postgres repo, chain-backed holdings, and a custodian.
import { keccak256, toHex, getAddress, type Address } from "viem";
import { commodityUnitsAbi } from "@tradechainx/shared";
import { pool } from "../db/client.ts";
import { deployment, publicClient } from "../chain.ts";
import { env } from "../env.ts";
import { HttpError } from "../lib/errors.ts";
import { PgRepo } from "./pgRepo.ts";
import { DistributionService } from "./service.ts";
import type { Custodian, Holdings } from "./model.ts";

/** Reads a customer's balance of a class from the CommodityUnits registry. */
export const chainHoldings: Holdings = {
  async unitsOf(walletAddress, classId) {
    const { rows } = await pool.query("SELECT chain_class_id FROM commodity_classes WHERE id = $1", [classId]);
    const chainClassId = rows[0]?.chain_class_id as string | null | undefined;
    if (chainClassId == null) throw new HttpError(409, "class_not_on_chain", "This commodity class has not been created on-chain yet.");
    return publicClient.readContract({
      address: deployment.commodityUnits as Address,
      abi: commodityUnitsAbi,
      functionName: "balanceOf",
      args: [walletAddress as Address, BigInt(chainClassId)],
    }) as Promise<bigint>;
  },
};

/** Until a licensed custodian is signed, wallet creation is refused rather than faked. */
const unconfiguredCustodian: Custodian = {
  async provisionWallet() {
    throw new HttpError(503, "custodian_not_configured", "No custodian is configured, so customer wallets cannot be created yet.");
  },
};

/**
 * SANDBOX ONLY. Derives a stable address from the customer id so integrations can be tried end to end.
 * It is not a wallet: nobody holds a key for it. Refused in production by the env check.
 */
const sandboxCustodian: Custodian = {
  async provisionWallet(customerId) {
    const address = getAddress(`0x${keccak256(toHex(`sandbox:${customerId}`)).slice(26)}`);
    return { address, custodianRef: `sandbox:${customerId}` };
  },
};

export function buildDistributionService(): DistributionService {
  return new DistributionService({
    repo: new PgRepo(pool),
    custodian: env.DISTRIBUTION_SANDBOX_WALLETS ? sandboxCustodian : unconfiguredCustodian,
    holdings: chainHoldings,
    clock: { now: () => new Date() },
  });
}
