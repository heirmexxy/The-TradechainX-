import { decodeEventLog, type Abi, type Address, type Log } from "viem";
import { contracts, vaultAbi, type ContractName } from "../chain.ts";

export type DecodedEvent = {
  contract: Address; // lowercase
  contractName: ContractName;
  event: string;
  args: Record<string, unknown>;
  blockNumber: bigint;
  txHash: `0x${string}`;
  logIndex: number;
};

const STATIC: Record<string, { name: ContractName; abi: Abi }> = Object.fromEntries(
  Object.values(contracts).map((c) => [c.address, { name: c.name as ContractName, abi: c.abi as Abi }]),
);

export function staticAddresses(): Address[] {
  return Object.keys(STATIC) as Address[];
}

/** Decodes a raw log from any platform contract. Returns null for events we don't track. */
export function decode(log: Log, vaults: Set<string>): DecodedEvent | null {
  const address = log.address.toLowerCase() as Address;
  const entry = STATIC[address] ?? (vaults.has(address) ? { name: "XOwnVault" as const, abi: vaultAbi as Abi } : undefined);
  if (!entry || log.blockNumber === null || log.transactionHash === null || log.logIndex === null) return null;
  try {
    const { eventName, args } = decodeEventLog({ abi: entry.abi, data: log.data, topics: log.topics, strict: true });
    if (!eventName) return null;
    return {
      contract: address,
      contractName: entry.name,
      event: eventName,
      args: (args ?? {}) as Record<string, unknown>,
      blockNumber: log.blockNumber,
      txHash: log.transactionHash,
      logIndex: log.logIndex,
    };
  } catch {
    return null;
  }
}
