// Runs every check on a timer, stores the latest result per check, logs status changes, and alerts.
//
// Alerts are debounced: a change must still hold on the next run before anyone is notified, so a
// single slow response doesn't page the team. Supplier pages alert only for "down" (major outage).
// A Postgres advisory lock makes sure only one process runs the monitor even with several API replicas.
import { and, eq, lt } from "drizzle-orm";
import { db, pool, schema } from "../db/client.ts";
import { env } from "../env.ts";
import type { HealthStatus } from "../db/schema.ts";
import { PLATFORM_CHECKS, PROVIDER_CHECKS, type Check, type CheckResult } from "./checks.ts";
import { checkSupplier, suppliers } from "./suppliers.ts";
import { sendAlert, type Alert } from "./alerts.ts";

const LOCK_KEY = 72_041_991; // arbitrary constant for pg_try_advisory_lock
const TIMEOUT_MS = 12_000;

type Row = { name: string; label: string; category: "platform" | "provider" | "supplier"; result: CheckResult; latencyMs: number; page?: string };

async function timed(check: Check): Promise<{ result: CheckResult; latencyMs: number }> {
  const t = Date.now();
  try {
    const result = await Promise.race([
      check.run(),
      new Promise<CheckResult>((_, rej) => setTimeout(() => rej(new Error(`timed out after ${TIMEOUT_MS / 1000}s`)), TIMEOUT_MS)),
    ]);
    return { result, latencyMs: Date.now() - t };
  } catch (e) {
    return { result: { status: "down", detail: `Check failed: ${(e as Error).message}` }, latencyMs: Date.now() - t };
  }
}

/** Run every check once and store the results. Returns the rows (used by "Run checks now"). */
export async function runHealthChecks(): Promise<Row[]> {
  const own = await Promise.all(
    [...PLATFORM_CHECKS.map((c) => ({ c, category: "platform" as const })), ...PROVIDER_CHECKS.map((c) => ({ c, category: "provider" as const }))].map(
      async ({ c, category }) => ({ name: c.name, label: c.label, category, ...(await timed(c)) }),
    ),
  );
  const sup = await Promise.all(
    suppliers().map(async (s) => {
      const t = Date.now();
      const result = await checkSupplier(s);
      return { name: `supplier:${s.name}`, label: s.name, category: "supplier" as const, result, latencyMs: Date.now() - t, page: s.page };
    }),
  );
  const rows: Row[] = [...own, ...sup];
  const now = new Date();

  type HealthRow = typeof schema.healthChecks.$inferSelect;
  const existing = new Map<string, HealthRow>((await db.select().from(schema.healthChecks)).map((r: HealthRow) => [r.name, r] as const));
  for (const r of rows) {
    const prev = existing.get(r.name);
    const changed = !prev || prev.status !== r.result.status;
    await db
      .insert(schema.healthChecks)
      .values({
        name: r.name,
        category: r.category,
        status: r.result.status,
        detail: r.result.detail,
        latencyMs: r.latencyMs,
        data: { ...(r.result.data ?? {}), label: r.label, ...(r.page ? { page: r.page } : {}) },
        checkedAt: now,
        changedAt: changed ? now : prev!.changedAt,
      })
      .onConflictDoUpdate({
        target: schema.healthChecks.name,
        set: {
          category: r.category,
          status: r.result.status,
          detail: r.result.detail,
          latencyMs: r.latencyMs,
          data: { ...(r.result.data ?? {}), label: r.label, ...(r.page ? { page: r.page } : {}) },
          checkedAt: now,
          changedAt: changed ? now : prev!.changedAt,
        },
      });
    if (prev && changed) {
      await db.insert(schema.healthEvents).values({ name: r.name, fromStatus: prev.status, toStatus: r.result.status, detail: r.result.detail });
    }
  }
  // Checks that no longer exist (e.g. a supplier removed from config).
  const current = new Set(rows.map((r) => r.name));
  for (const name of existing.keys()) if (!current.has(name)) await db.delete(schema.healthChecks).where(eq(schema.healthChecks.name, name));

  await flushAlerts(now);
  return rows;
}

const BAD: HealthStatus[] = ["down", "degraded"];

function shouldAlert(name: string, from: string | null, to: HealthStatus): Alert["severity"] | null {
  const supplier = name.startsWith("supplier:");
  if (supplier) {
    if (to === "down") return "down";
    if (to === "ok" && from === "down") return "recovered";
    return null;
  }
  if (to === "down" || to === "degraded") return to;
  if (to === "ok" && from && BAD.includes(from as HealthStatus)) return "recovered";
  return null;
}

/** Send alerts for status changes that have held for at least one more run. */
async function flushAlerts(now: Date) {
  const cutoff = new Date(now.getTime() - (env.HEALTH_CHECK_INTERVAL_SECONDS * 1000) / 2);
  const pending = await db
    .select()
    .from(schema.healthEvents)
    .where(and(eq(schema.healthEvents.alerted, false), lt(schema.healthEvents.createdAt, cutoff)));
  if (!pending.length) return;
  const latest = new Map<string, typeof schema.healthChecks.$inferSelect>(
    (await db.select().from(schema.healthChecks)).map((r: typeof schema.healthChecks.$inferSelect) => [r.name, r] as const),
  );
  const alerts: { severity: Alert["severity"]; line: string }[] = [];
  for (const e of pending) {
    const cur = latest.get(e.name);
    const held = cur && cur.status === e.toStatus;
    const sev = held ? shouldAlert(e.name, e.fromStatus, e.toStatus as HealthStatus) : null;
    if (sev) {
      const label = (cur!.data as { label?: string }).label ?? e.name;
      alerts.push({ severity: sev, line: `${label}: ${e.fromStatus ?? "new"} → ${e.toStatus} — ${cur!.detail}` });
    }
    await db.update(schema.healthEvents).set({ alerted: true }).where(eq(schema.healthEvents.id, e.id));
  }
  if (!alerts.length) return;
  const worst = alerts.some((a) => a.severity === "down") ? "down" : alerts.some((a) => a.severity === "degraded") ? "degraded" : "recovered";
  const title =
    worst === "recovered" ? "Recovered" : `${alerts.filter((a) => a.severity !== "recovered").length} check(s) need attention`;
  await sendAlert({ severity: worst, title, lines: alerts.map((a) => a.line) });
}

/** Start the background loop. Safe to call in several processes: only the lock holder runs checks. */
export function startHealthMonitor(log: { info: (o: unknown, m?: string) => void; error: (o: unknown, m?: string) => void }) {
  let stopped = false;
  const loop = async () => {
    while (!stopped) {
      const client = await pool.connect().catch(() => null);
      try {
        if (client) {
          const { rows } = await client.query<{ ok: boolean }>("select pg_try_advisory_lock($1) as ok", [LOCK_KEY]);
          if (rows[0]?.ok) {
            try {
              await runHealthChecks();
            } finally {
              await client.query("select pg_advisory_unlock($1)", [LOCK_KEY]);
            }
          }
        }
      } catch (err) {
        log.error({ err }, "health monitor run failed");
      } finally {
        client?.release();
      }
      await new Promise((r) => setTimeout(r, env.HEALTH_CHECK_INTERVAL_SECONDS * 1000));
    }
  };
  void loop();
  log.info({ intervalSeconds: env.HEALTH_CHECK_INTERVAL_SECONDS }, "health monitor started");
  return () => {
    stopped = true;
  };
}
