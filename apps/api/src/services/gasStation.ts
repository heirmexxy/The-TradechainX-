// Gas station: tops up verified users' wallets with a little native gas (POL on Polygon) so they can
// transact before a paymaster / gas sponsorship is switched on in the wallet provider.
//
// Only sends to wallets with an active on-chain identity, only when below the threshold, and at most
// once per wallet per GAS_STATION_COOLDOWN_HOURS. Keep the station wallet funded with a small float
// only — it's a hot key. Disable (GAS_STATION_ENABLED=false) once gas sponsorship is live.
import { createWalletClient, http, parseEther, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { and, desc, eq, gte } from "drizzle-orm";
import { chain, publicClient } from "../chain.ts";
import { env } from "../env.ts";
import { db, schema } from "../db/client.ts";
import { identityIsValid } from "./profile.ts";

export function gasStationEnabled() {
  return env.GAS_STATION_ENABLED && !!env.GAS_STATION_KEY;
}

export async function topUpGas(address: Address): Promise<"sent" | "not_needed" | "skipped"> {
  if (!gasStationEnabled()) return "skipped";
  const a = address.toLowerCase();
  const [id] = await db.select().from(schema.identities).where(eq(schema.identities.address, a)).limit(1);
  if (!identityIsValid(id)) return "skipped";

  const since = new Date(Date.now() - env.GAS_STATION_COOLDOWN_HOURS * 3600_000);
  const [recent] = await db
    .select({ id: schema.gasTopups.id })
    .from(schema.gasTopups)
    .where(and(eq(schema.gasTopups.address, a), gte(schema.gasTopups.createdAt, since)))
    .orderBy(desc(schema.gasTopups.createdAt))
    .limit(1);
  if (recent) return "skipped";

  const balance = await publicClient.getBalance({ address });
  if (balance >= parseEther(env.GAS_STATION_MIN_BALANCE)) return "not_needed";

  const account = privateKeyToAccount(env.GAS_STATION_KEY as `0x${string}`);
  const wallet = createWalletClient({ account, chain, transport: http(env.RPC_URL) });
  const value = parseEther(env.GAS_STATION_TOP_UP);
  const hash = await wallet.sendTransaction({ to: address, value });
  await db.insert(schema.gasTopups).values({ address: a, amountWei: value.toString(), txHash: hash });
  await publicClient.waitForTransactionReceipt({ hash });
  return "sent";
}

export async function gasStationBalance(): Promise<bigint | null> {
  if (!gasStationEnabled()) return null;
  const account = privateKeyToAccount(env.GAS_STATION_KEY as `0x${string}`);
  return publicClient.getBalance({ address: account.address });
}
