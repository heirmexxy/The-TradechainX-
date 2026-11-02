// Runs the indexer (and the partner webhook dispatcher) as its own process — recommended in production
// so API restarts don't pause indexing.
import { env } from "../env.ts";
import { Indexer } from "./indexer.ts";
import { WebhookDispatcher } from "../partner/dispatcher.ts";

const indexer = new Indexer();
const dispatcher = env.PARTNER_API_ENABLED ? new WebhookDispatcher() : null;
for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.on(sig, () => {
    indexer.stop();
    dispatcher?.stop();
  });
if (dispatcher) void dispatcher.start();
await indexer.start();
