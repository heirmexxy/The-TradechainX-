// Alert channels for health changes: email, Slack (incoming webhook), Telegram (bot). Any subset.
import { env } from "../env.ts";
import { mailer } from "../lib/mailer.ts";

export type Alert = { title: string; lines: string[]; severity: "down" | "degraded" | "recovered" };

const ICON = { down: "🔴", degraded: "🟠", recovered: "🟢" } as const;

export function alertChannels(): string[] {
  return [
    env.ALERT_EMAILS && "email",
    env.ALERT_SLACK_WEBHOOK_URL && "slack",
    env.ALERT_TELEGRAM_BOT_TOKEN && env.ALERT_TELEGRAM_CHAT_ID && "telegram",
  ].filter(Boolean) as string[];
}

export async function sendAlert(a: Alert): Promise<void> {
  const text = `${ICON[a.severity]} ${a.title}\n${a.lines.join("\n")}\n${env.WEB_ORIGIN}/admin/health`;
  const jobs: Promise<unknown>[] = [];

  if (env.ALERT_EMAILS) {
    for (const to of env.ALERT_EMAILS.split(",").map((s) => s.trim()).filter(Boolean)) {
      jobs.push(mailer.send(to, `[TradeChainX] ${a.title}`, text));
    }
  }
  if (env.ALERT_SLACK_WEBHOOK_URL) {
    jobs.push(
      fetch(env.ALERT_SLACK_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(8000),
      }),
    );
  }
  if (env.ALERT_TELEGRAM_BOT_TOKEN && env.ALERT_TELEGRAM_CHAT_ID) {
    jobs.push(
      fetch(`https://api.telegram.org/bot${env.ALERT_TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: env.ALERT_TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }),
        signal: AbortSignal.timeout(8000),
      }),
    );
  }
  const results = await Promise.allSettled(jobs);
  const failed = results.filter((r) => r.status === "rejected");
  if (failed.length) console.error(`[alerts] ${failed.length} alert channel(s) failed`, failed.map((f) => (f as PromiseRejectedResult).reason?.message));
}
