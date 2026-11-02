// Delivers queued partner webhooks with retries.
//
// Each delivery is a POST with a JSON body and headers:
//   TradeChainX-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>
//   TradeChainX-Event:     <type>
//   TradeChainX-Delivery:  <delivery id>   (the same on every retry)
// A 2xx response within 10 seconds counts as delivered. Otherwise it's retried after
// 1 min, 5 min, 30 min, 2 h, 6 h, 12 h, 24 h — then marked failed (visible to admins and the partner).
// Rows are claimed with FOR UPDATE SKIP LOCKED, so several dispatchers can run safely.
import { pool } from "../db/client.ts";
import { signWebhook, webhookSecret } from "./keys.ts";
import { assertPublicUrl } from "./safeUrl.ts";

const BACKOFF_SECONDS = [60, 300, 1800, 7200, 21600, 43200, 86400];
const BATCH = 25;

type Logger = { info: (o: object | string, m?: string) => void; error: (o: object | string, m?: string) => void };

type Due = { id: string; webhook_id: string; event_type: string; payload: unknown; attempts: number; url: string; secret_version: number };

export class WebhookDispatcher {
  private stopped = false;
  constructor(private log: Logger = console as unknown as Logger) {}

  async start() {
    this.log.info({}, "webhook dispatcher started");
    while (!this.stopped) {
      try {
        const n = await this.tick();
        if (n === 0) await sleep(2000);
      } catch (err) {
        this.log.error({ err }, "webhook dispatcher tick failed");
        await sleep(5000);
      }
    }
  }

  stop() {
    this.stopped = true;
  }

  async tick(): Promise<number> {
    const client = await pool.connect();
    let due: Due[] = [];
    try {
      await client.query("BEGIN");
      const r = await client.query<Due>(
        `SELECT d.id, d.webhook_id, d.event_type, d.payload, d.attempts, w.url, w.secret_version
           FROM webhook_deliveries d JOIN webhooks w ON w.id = d.webhook_id
          WHERE d.status = 'pending' AND d.next_attempt_at <= now() AND w.active
          ORDER BY d.next_attempt_at
          LIMIT $1
          FOR UPDATE OF d SKIP LOCKED`,
        [BATCH],
      );
      due = r.rows;
      // Push claimed rows forward so another dispatcher doesn't pick them while we're sending.
      if (due.length) {
        await client.query(`UPDATE webhook_deliveries SET next_attempt_at = now() + interval '2 minutes' WHERE id = ANY($1::uuid[])`, [due.map((d) => d.id)]);
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
    await Promise.all(due.map((d) => this.deliver(d)));
    return due.length;
  }

  private async deliver(d: Due) {
    const body = JSON.stringify(d.payload);
    let statusCode: number | null = null;
    let error: string | null = null;
    try {
      await assertPublicUrl(d.url);
      const res = await fetch(d.url, {
        method: "POST",
        redirect: "manual",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "TradeChainX-Webhooks/1",
          "TradeChainX-Signature": signWebhook(webhookSecret(d.webhook_id, d.secret_version), body),
          "TradeChainX-Event": d.event_type,
          "TradeChainX-Delivery": d.id,
        },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      statusCode = res.status;
      if (!res.ok) error = `HTTP ${res.status}`;
    } catch (e) {
      error = (e as Error).message.slice(0, 300);
    }

    const attempts = d.attempts + 1;
    if (!error) {
      await pool.query(
        `UPDATE webhook_deliveries SET status='delivered', attempts=$2, last_status_code=$3, last_error=NULL, delivered_at=now() WHERE id=$1`,
        [d.id, attempts, statusCode],
      );
      return;
    }
    const wait = BACKOFF_SECONDS[attempts - 1];
    if (wait === undefined) {
      await pool.query(`UPDATE webhook_deliveries SET status='failed', attempts=$2, last_status_code=$3, last_error=$4 WHERE id=$1`, [
        d.id,
        attempts,
        statusCode,
        error,
      ]);
    } else {
      await pool.query(
        `UPDATE webhook_deliveries SET attempts=$2, last_status_code=$3, last_error=$4, next_attempt_at = now() + ($5 || ' seconds')::interval WHERE id=$1`,
        [d.id, attempts, statusCode, error, String(wait)],
      );
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
