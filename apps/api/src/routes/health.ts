import type { FastifyInstance } from "fastify";
import { desc } from "drizzle-orm";
import { db, schema } from "../db/client.ts";
import { env } from "../env.ts";
import { requireAdmin } from "../plugins/auth.ts";
import { runHealthChecks } from "../health/monitor.ts";
import { alertChannels } from "../health/alerts.ts";

const RANK = { down: 0, degraded: 1, unknown: 2, ok: 3, disabled: 4 } as const;

export async function healthRoutes(app: FastifyInstance) {
  /** Liveness for Docker/Caddy: the process is up. No dependencies. */
  app.get("/health/live", async () => ({ status: "ok" }));

  /** Admin System health page. */
  app.get("/admin/health", async (req) => {
    requireAdmin(req);
    const [checks, events] = await Promise.all([
      db.select().from(schema.healthChecks),
      db.select().from(schema.healthEvents).orderBy(desc(schema.healthEvents.createdAt)).limit(50),
    ]);
    const own = checks.filter((c) => c.category !== "supplier");
    const overall = own.some((c) => c.status === "down") ? "down" : own.some((c) => c.status === "degraded") ? "degraded" : own.length ? "ok" : "unknown";
    const sorted = checks.sort((a, b) => RANK[a.status] - RANK[b.status] || a.name.localeCompare(b.name));
    return {
      overall,
      lastRun: checks.reduce<Date | null>((m, c) => (!m || c.checkedAt > m ? c.checkedAt : m), null),
      intervalSeconds: env.HEALTH_CHECK_INTERVAL_SECONDS,
      alertChannels: alertChannels(),
      checks: sorted.map((c) => ({
        name: c.name,
        label: (c.data as { label?: string }).label ?? c.name,
        category: c.category,
        status: c.status,
        detail: c.detail,
        latencyMs: c.latencyMs,
        data: c.data,
        checkedAt: c.checkedAt,
        changedAt: c.changedAt,
      })),
      events: events.map((e) => ({ id: e.id, name: e.name, from: e.fromStatus, to: e.toStatus, detail: e.detail, at: e.createdAt })),
    };
  });

  app.post("/admin/health/run", { config: { rateLimit: { max: 6, timeWindow: "1 minute" } } }, async (req) => {
    requireAdmin(req);
    await runHealthChecks();
    return { ok: true };
  });
}
