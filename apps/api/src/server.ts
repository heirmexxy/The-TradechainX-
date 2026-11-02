import { buildApp } from "./app.ts";
import { env } from "./env.ts";
import { migrate } from "./db/migrate.ts";
import { Indexer } from "./indexer/indexer.ts";
import { startHealthMonitor } from "./health/monitor.ts";
import { WebhookDispatcher } from "./partner/dispatcher.ts";

await migrate(env.DATABASE_URL, (m) => console.log(`[migrate] ${m}`));
const app = await buildApp();

// In development the indexer runs inside the API process for convenience. In production run it as its
// own process (`pnpm --filter @tradechainx/api indexer`) and set RUN_INDEXER=false here.
let indexer: Indexer | null = null;
let dispatcher: WebhookDispatcher | null = null;
if (process.env.RUN_INDEXER !== "false") {
  indexer = new Indexer(app.log);
  void indexer.start();
  if (env.PARTNER_API_ENABLED) {
    dispatcher = new WebhookDispatcher(app.log);
    void dispatcher.start();
  }
}

// System health checks + alerts (one runner across replicas, via an advisory lock).
const stopHealth = process.env.RUN_HEALTH_MONITOR !== "false" ? startHealthMonitor(app.log) : () => {};

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    indexer?.stop();
    dispatcher?.stop();
    stopHealth();
    await app.close();
    process.exit(0);
  });
}

await app.listen({ port: env.PORT, host: "0.0.0.0" });
