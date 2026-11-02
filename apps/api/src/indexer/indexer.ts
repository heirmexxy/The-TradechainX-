import { eq, isNotNull, sql } from "drizzle-orm";
import type { Address, Log } from "viem";
import { db, schema } from "../db/client.ts";
import { env } from "../env.ts";
import { publicClient, deployment } from "../chain.ts";
import { jsonSafe } from "../lib/util.ts";
import { decode, staticAddresses, type DecodedEvent } from "./decode.ts";
import { effectOf, refreshId, type RefreshKey, type Derived } from "./effects.ts";
import { refresh, type Write } from "./refresh.ts";
import { enqueuePartnerEvents } from "../partner/events.ts";

export const CURSOR = `main-${env.CHAIN_ID}`;

// Writes run in this order so later ones can see earlier ones (e.g. an asset links to its submission's draft).
const ORDER: RefreshKey["kind"][] = [
  "identity",
  "warehouse",
  "submission",
  "offering",
  "vault",
  "asset",
  "carbonBalance",
  "listing",
  "holding",
];

type Logger = { info: (o: object | string, m?: string) => void; error: (o: object | string, m?: string) => void };

export class Indexer {
  private vaults = new Set<string>();
  private stopped = false;

  constructor(private log: Logger = console as unknown as Logger) {}

  async start() {
    const known = await db.select({ vault: schema.xownOfferings.vault }).from(schema.xownOfferings).where(isNotNull(schema.xownOfferings.vault));
    for (const k of known) this.vaults.add(k.vault!);
    this.log.info({ chainId: env.CHAIN_ID, vaults: this.vaults.size }, "indexer started");
    while (!this.stopped) {
      try {
        const progressed = await this.tick();
        if (!progressed) await sleep(env.INDEXER_POLL_MS);
      } catch (err) {
        this.log.error({ err }, "indexer tick failed; retrying");
        await sleep(env.INDEXER_POLL_MS * 2);
      }
    }
  }

  stop() {
    this.stopped = true;
  }

  /** Processes one block range. Returns false when caught up. */
  async tick(): Promise<boolean> {
    const head = await publicClient.getBlockNumber();
    const safe = head - BigInt(env.INDEXER_CONFIRMATIONS);
    const [cursor] = await db.select().from(schema.chainCursor).where(eq(schema.chainCursor.name, CURSOR)).limit(1);
    const from = cursor ? BigInt(cursor.lastBlock) + 1n : BigInt(deployment.startBlock);
    if (from > safe) return false;
    const to = from + BigInt(env.INDEXER_BATCH_BLOCKS) - 1n < safe ? from + BigInt(env.INDEXER_BATCH_BLOCKS) - 1n : safe;

    // 1. Logs for every known contract.
    let logs = await this.getLogs([...staticAddresses(), ...([...this.vaults] as Address[])], from, to);
    let events = logs.map((l) => decode(l, this.vaults)).filter((e): e is DecodedEvent => e !== null);

    // 2. Vaults created in this range emit events in the same range — fetch those too.
    const created = events.filter((e) => e.event === "OfferingCreated").map((e) => String(e.args.vault).toLowerCase());
    const fresh = created.filter((v) => !this.vaults.has(v));
    if (fresh.length) {
      for (const v of fresh) this.vaults.add(v);
      logs = await this.getLogs(fresh as Address[], from, to);
      events = events.concat(logs.map((l) => decode(l, this.vaults)).filter((e): e is DecodedEvent => e !== null));
    }
    events.sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1));

    // 3. Work out what changed.
    const refreshKeys = new Map<string, RefreshKey>();
    const derived: { e: DecodedEvent; d: Derived }[] = [];
    const burns = new Map<string, "redeemed" | "settled" | "voided" | "cancelled">();
    const entity = new Map<DecodedEvent, { type?: string; id?: string }>();
    for (const e of events) {
      const eff = effectOf(e);
      entity.set(e, { type: eff.entityType, id: eff.entityId });
      for (const k of eff.refresh) refreshKeys.set(refreshId(k), k);
      for (const d of eff.derived) {
        derived.push({ e, d });
        if (d.kind === "burned") burns.set(`${d.assetType}:${d.tokenId}`, d.as);
      }
    }

    // 4. Read current state (outside the transaction).
    const blockTimes = await this.blockTimes([...new Set(events.map((e) => e.blockNumber))]);
    const writes: { kind: RefreshKey["kind"]; write: Write }[] = [];
    const keys = [...refreshKeys.values()];
    for (let i = 0; i < keys.length; i += 16) {
      const chunk = keys.slice(i, i + 16);
      const results = await Promise.all(chunk.map((k) => refresh(k, to, burns)));
      results.forEach((write, j) => writes.push({ kind: chunk[j]!.kind, write }));
    }
    writes.sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));

    // 5. One transaction: audit trail, derived facts, mirrored state, cursor.
    await db.transaction(async (tx) => {
      for (const e of events) {
        const ent = entity.get(e)!;
        await tx
          .insert(schema.chainEvents)
          .values({
            chainId: env.CHAIN_ID,
            txHash: e.txHash,
            logIndex: e.logIndex,
            blockNumber: Number(e.blockNumber),
            blockTime: blockTimes.get(e.blockNumber)!,
            contract: e.contract,
            contractName: e.contractName,
            event: e.event,
            args: jsonSafe(e.args) as Record<string, unknown>,
            entityType: ent.type ?? null,
            entityId: ent.id ?? null,
          })
          .onConflictDoNothing();
      }

      for (const { e, d } of derived) {
        const time = blockTimes.get(e.blockNumber)!;
        if (d.kind === "trade") {
          await tx
            .insert(schema.trades)
            .values({
              txHash: e.txHash,
              logIndex: e.logIndex,
              listingId: d.listingId.toString(),
              buyer: d.buyer,
              seller: d.seller,
              amount: d.amount.toString(),
              total: d.total.toString(),
              fee: d.fee.toString(),
              blockTime: time,
            })
            .onConflictDoNothing();
        } else if (d.kind === "retirement") {
          await tx
            .insert(schema.retirements)
            .values({
              retirementId: d.retirementId.toString(),
              batchId: d.batchId.toString(),
              holder: d.holder,
              amount: d.amount.toString(),
              beneficiaryRef: d.beneficiaryRef,
              reasonRef: d.reasonRef,
              txHash: e.txHash,
              blockTime: time,
            })
            .onConflictDoNothing();
        } else if (d.kind === "kycVerified") {
          await tx
            .update(schema.kycCases)
            .set({ status: "verified", verifiedAt: time })
            .where(sql`${schema.kycCases.recordRef} = ${d.recordRef} AND ${schema.kycCases.status} = 'approved'`);
        }
      }

      for (const w of writes) await w.write(tx);

      // Partner webhooks: queued in the same transaction, so each event is queued exactly once.
      if (env.PARTNER_API_ENABLED) await enqueuePartnerEvents(tx, events, blockTimes);

      await tx
        .insert(schema.chainCursor)
        .values({ name: CURSOR, chainId: env.CHAIN_ID, lastBlock: Number(to) })
        .onConflictDoUpdate({ target: schema.chainCursor.name, set: { lastBlock: Number(to) } });
    });

    if (events.length) this.log.info({ from: from.toString(), to: to.toString(), events: events.length }, "indexed");
    return to < safe;
  }

  private async getLogs(address: Address[], fromBlock: bigint, toBlock: bigint): Promise<Log[]> {
    if (address.length === 0) return [];
    return publicClient.getLogs({ address, fromBlock, toBlock });
  }

  private async blockTimes(blocks: bigint[]): Promise<Map<bigint, Date>> {
    const out = new Map<bigint, Date>();
    for (let i = 0; i < blocks.length; i += 16) {
      const chunk = blocks.slice(i, i + 16);
      const got = await Promise.all(chunk.map((n) => publicClient.getBlock({ blockNumber: n })));
      got.forEach((b, j) => out.set(chunk[j]!, new Date(Number(b.timestamp) * 1000)));
    }
    return out;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
