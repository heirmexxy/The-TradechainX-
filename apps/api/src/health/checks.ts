// Our own health checks. Each returns a status and a one-line, plain-English detail for the admin page.
import { eq, and, gte, sql } from "drizzle-orm";
import { formatEther, parseAbi, type Address } from "viem";
import { db, pool, schema } from "../db/client.ts";
import { env } from "../env.ts";
import { contracts, publicClient } from "../chain.ts";
import { storageRoundTrip } from "../lib/storage.ts";
import { jwks } from "../auth/walletToken.ts";
import { gasStationBalance, gasStationEnabled } from "../services/gasStation.ts";
import { ramp } from "../ramps/index.ts";
import { CURSOR } from "../indexer/indexer.ts";
import type { HealthStatus } from "../db/schema.ts";
import { statusPagesConfigError } from "./suppliers.ts";

export type CheckResult = { status: HealthStatus; detail: string; data?: Record<string, unknown> };
export type Check = { name: string; label: string; run: () => Promise<CheckResult> };

const started = Date.now();

async function database(): Promise<CheckResult> {
  const r = await pool.query<{ n: string }>("select count(*)::text as n from pg_stat_activity");
  return { status: "ok", detail: "Database responding", data: { connections: Number(r.rows[0]?.n ?? 0) } };
}

async function rpc(): Promise<CheckResult> {
  const [chainId, block] = await Promise.all([publicClient.getChainId(), publicClient.getBlock()]);
  if (chainId !== env.CHAIN_ID) return { status: "down", detail: `RPC is on chain ${chainId}, expected ${env.CHAIN_ID}` };
  const ageSec = Math.floor(Date.now() / 1000) - Number(block.timestamp);
  const data = { chainId, block: Number(block.number), blockAgeSeconds: ageSec };
  // A local anvil chain only mines on demand, so stale blocks are normal there.
  if (env.CHAIN_ID !== 31337 && ageSec > 300) return { status: "degraded", detail: `Latest block is ${ageSec}s old — node may be stuck`, data };
  return { status: "ok", detail: `Block ${block.number} (${ageSec}s old)`, data };
}

async function indexer(): Promise<CheckResult> {
  const [cursor] = await db.select().from(schema.chainCursor).where(eq(schema.chainCursor.name, CURSOR)).limit(1);
  if (!cursor) return { status: "unknown", detail: "Indexer hasn't recorded progress yet" };
  const head = Number(await publicClient.getBlockNumber());
  const lag = Math.max(0, head - env.INDEXER_CONFIRMATIONS - cursor.lastBlock);
  const data = { head, indexed: cursor.lastBlock, lagBlocks: lag, maxLagBlocks: env.INDEXER_MAX_LAG_BLOCKS };
  if (lag > env.INDEXER_MAX_LAG_BLOCKS * 5) return { status: "down", detail: `${lag} blocks behind — is the indexer running?`, data };
  if (lag > env.INDEXER_MAX_LAG_BLOCKS) return { status: "degraded", detail: `${lag} blocks behind the chain`, data };
  return { status: "ok", detail: lag === 0 ? "Up to date" : `${lag} blocks behind (within limit)`, data };
}

async function email(): Promise<CheckResult> {
  if (env.EMAIL_PROVIDER === "console") return { status: "disabled", detail: "Development mode: login codes go to the API log" };
  // Validates the API key without sending mail.
  const res = await fetch("https://api.sendgrid.com/v3/scopes", {
    headers: { Authorization: `Bearer ${env.SENDGRID_API_KEY}` },
    signal: AbortSignal.timeout(8000),
  });
  if (res.status === 401 || res.status === 403) return { status: "down", detail: "SendGrid rejected the API key" };
  if (!res.ok) return { status: "degraded", detail: `SendGrid returned ${res.status}` };
  const { scopes } = (await res.json()) as { scopes?: string[] };
  if (scopes && !scopes.includes("mail.send")) return { status: "down", detail: "SendGrid key lacks the Mail Send permission" };
  return { status: "ok", detail: "SendGrid key valid (Mail Send)" };
}

async function storageCheck(): Promise<CheckResult> {
  await storageRoundTrip();
  return {
    status: "ok",
    detail: env.STORAGE_PROVIDER === "s3" ? `Write/read OK (${env.S3_ENDPOINT ? new URL(env.S3_ENDPOINT).host : "AWS S3"})` : "Local disk (development)",
  };
}

async function walletProvider(): Promise<CheckResult> {
  if (env.WALLET_PROVIDER === "dev") return { status: "disabled", detail: "Development wallet (not for real funds)" };
  const { keys } = await jwks();
  if (!keys.length) return { status: "down", detail: "No signing key published at /.well-known/jwks.json" };
  if (!env.WALLET_TOKEN_PRIVATE_KEY) return { status: "degraded", detail: "Using a temporary signing key — set WALLET_TOKEN_PRIVATE_KEY" };
  return {
    status: "ok",
    detail: `${env.WALLET_PROVIDER} configured; sign-in keys published (provider's own status is under Suppliers)`,
    data: { provider: env.WALLET_PROVIDER, kid: keys[0]?.kid },
  };
}

async function rampCheck(): Promise<CheckResult> {
  if (env.RAMP_PROVIDER === "none") return { status: "disabled", detail: "No fiat ramp configured" };
  let r;
  try {
    r = ramp();
  } catch (e) {
    return { status: "down", detail: (e as Error).message };
  }
  if (!r) return { status: "disabled", detail: "No fiat ramp configured" };
  const h = await r.health();
  const since = new Date(Date.now() - 86_400_000);
  const [failed] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.rampTransactions)
    .where(and(eq(schema.rampTransactions.status, "failed"), gte(schema.rampTransactions.updatedAt, since)));
  return { status: h.status, detail: h.detail, data: { provider: r.name, failedLast24h: failed?.n ?? 0 } };
}

async function gasStation(): Promise<CheckResult> {
  if (!gasStationEnabled()) return { status: "disabled", detail: "Off (gas is sponsored by the wallet provider, or dev mode)" };
  const bal = (await gasStationBalance()) ?? 0n;
  const topUp = Number(env.GAS_STATION_TOP_UP);
  const left = Number(formatEther(bal));
  const topUpsLeft = Math.floor(left / topUp);
  const data = { balance: left, topUpsLeft };
  if (topUpsLeft < 5) return { status: "down", detail: `Only ${left.toFixed(3)} left (${topUpsLeft} top-ups) — refill now`, data };
  if (topUpsLeft < 25) return { status: "degraded", detail: `${left.toFixed(3)} left (${topUpsLeft} top-ups) — refill soon`, data };
  return { status: "ok", detail: `${left.toFixed(3)} left (${topUpsLeft} top-ups)`, data };
}

const pausedAbi = parseAbi(["function paused() view returns (bool)"]);

async function contractsCheck(): Promise<CheckResult> {
  const entries = Object.entries(contracts) as [string, { address: Address }][];
  const results = await Promise.all(
    entries.map(async ([key, c]) => {
      try {
        return [key, await publicClient.readContract({ address: c.address, abi: pausedAbi, functionName: "paused" })] as const;
      } catch {
        return [key, null] as const; // not pausable
      }
    }),
  );
  const paused = results.filter(([, p]) => p === true).map(([k]) => k);
  if (paused.length) return { status: "degraded", detail: `Paused: ${paused.join(", ")}`, data: { paused } };
  return { status: "ok", detail: "All contracts running", data: { paused: [] } };
}

async function webhooks(): Promise<CheckResult> {
  if (!env.PARTNER_API_ENABLED) return { status: "disabled", detail: "Partner API is off" };
  const r = await pool.query<{ pending: number; failed: number; oldest: number | null }>(`
    select
      count(*) filter (where status = 'pending')::int as pending,
      count(*) filter (where status = 'failed' and created_at > now() - interval '24 hours')::int as failed,
      extract(epoch from now() - min(created_at) filter (where status = 'pending'))::int as oldest
    from webhook_deliveries`);
  const { pending, failed, oldest } = r.rows[0] ?? { pending: 0, failed: 0, oldest: null };
  const data = { pending, failedLast24h: failed, oldestPendingSeconds: oldest };
  if ((oldest ?? 0) > 3600) return { status: "degraded", detail: `${pending} deliveries waiting; oldest ${Math.round(oldest! / 60)} min`, data };
  return { status: "ok", detail: `${pending} waiting, ${failed} gave up in the last 24h`, data };
}

async function config(): Promise<CheckResult> {
  const problems = [statusPagesConfigError()].filter(Boolean) as string[];
  if (env.NODE_ENV !== "production") problems.push(`Running in ${env.NODE_ENV} mode`);
  return problems.length ? { status: "degraded", detail: problems.join("; ") } : { status: "ok", detail: "Production configuration" };
}

async function api(): Promise<CheckResult> {
  const mins = Math.floor((Date.now() - started) / 60000);
  return { status: "ok", detail: `Up ${mins < 120 ? `${mins} min` : `${Math.floor(mins / 60)} h`}`, data: { uptimeMinutes: mins } };
}

export const PLATFORM_CHECKS: Check[] = [
  { name: "api", label: "API", run: api },
  { name: "database", label: "Database", run: database },
  { name: "rpc", label: "Blockchain node (RPC)", run: rpc },
  { name: "indexer", label: "Indexer", run: indexer },
  { name: "contracts", label: "Smart contracts", run: contractsCheck },
  { name: "config", label: "Configuration", run: config },
];

export const PROVIDER_CHECKS: Check[] = [
  { name: "email", label: "Email", run: email },
  { name: "storage", label: "Document storage", run: storageCheck },
  { name: "wallet", label: "Wallet provider", run: walletProvider },
  { name: "ramp", label: "Fiat ramp", run: rampCheck },
  { name: "gas_station", label: "Gas station", run: gasStation },
  { name: "webhooks", label: "Partner webhooks", run: webhooks },
];
