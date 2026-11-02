// Suppliers' public status pages, shown next to our own checks on the admin System health page.
//
// Three formats are supported:
//   statuspage — Atlassian Statuspage: GET <base>/api/v2/status.json → status.indicator (none|minor|major|critical|maintenance)
//   instatus   — Instatus:             GET <base>/summary.json        → page.status (UP|HASISSUES|UNDERMAINTENANCE)
//   http       — any URL: 2xx/3xx = ok (for suppliers without a status page, e.g. a health endpoint)
//
// Defaults below are chosen from the configuration. Add or override with STATUS_PAGES, e.g.
//   STATUS_PAGES='[{"name":"Dynamic","url":"https://…","kind":"http"},{"name":"Alchemy","url":"https://status.alchemy.com","kind":"statuspage"}]'
// An entry with the same name as a default replaces it; {"name":"X","disabled":true} removes it.
import { z } from "zod";
import { env } from "../env.ts";

export type Supplier = { name: string; url: string; kind: "statuspage" | "instatus" | "http"; page?: string };

const DEFAULTS: (Supplier & { when: () => boolean })[] = [
  { name: "Polygon network", url: "https://status.polygon.technology", kind: "statuspage", when: () => [137, 80002].includes(env.CHAIN_ID) },
  { name: "Alchemy (RPC)", url: "https://status.alchemy.com", kind: "statuspage", when: () => env.RPC_URL.includes("alchemy.com") },
  { name: "SendGrid (email)", url: "https://status.sendgrid.com", kind: "statuspage", when: () => env.EMAIL_PROVIDER === "sendgrid" },
  { name: "Cloudflare (DNS, R2 storage)", url: "https://www.cloudflarestatus.com", kind: "statuspage", when: () => true },
  { name: "Privy (wallets)", url: "https://status.privy.io", kind: "instatus", when: () => env.WALLET_PROVIDER === "privy" },
  { name: "Hostinger (VPS)", url: "https://statuspage.hostinger.com", kind: "statuspage", when: () => env.NODE_ENV === "production" },
  { name: "GitHub (deploys)", url: "https://www.githubstatus.com", kind: "statuspage", when: () => env.NODE_ENV === "production" },
];

const override = z.array(
  z.object({
    name: z.string().min(1),
    url: z.string().url().optional(),
    kind: z.enum(["statuspage", "instatus", "http"]).default("statuspage"),
    disabled: z.boolean().optional(),
  }),
);

export function suppliers(): Supplier[] {
  const list = new Map<string, Supplier>();
  for (const d of DEFAULTS) if (d.when()) list.set(d.name, { name: d.name, url: d.url, kind: d.kind, page: d.url });
  if (env.STATUS_PAGES) {
    try {
      for (const o of override.parse(JSON.parse(env.STATUS_PAGES))) {
        if (o.disabled) list.delete(o.name);
        else if (o.url) list.set(o.name, { name: o.name, url: o.url, kind: o.kind, page: o.url });
      }
    } catch {
      // Bad JSON shows up as a "config" check failure (see checks.ts), not a crash.
    }
  }
  return [...list.values()];
}

export function statusPagesConfigError(): string | null {
  if (!env.STATUS_PAGES) return null;
  try {
    override.parse(JSON.parse(env.STATUS_PAGES));
    return null;
  } catch (e) {
    return `STATUS_PAGES is not valid: ${(e as Error).message.slice(0, 200)}`;
  }
}

export type SupplierResult = { status: "ok" | "degraded" | "down" | "unknown"; detail: string };

export async function checkSupplier(s: Supplier): Promise<SupplierResult> {
  const base = s.url.replace(/\/$/, "");
  try {
    if (s.kind === "http") {
      const res = await fetch(base, { signal: AbortSignal.timeout(8000), redirect: "follow" });
      return res.ok ? { status: "ok", detail: `HTTP ${res.status}` } : { status: "down", detail: `HTTP ${res.status}` };
    }
    if (s.kind === "instatus") {
      const res = await fetch(`${base}/summary.json`, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) return { status: "unknown", detail: `Status page returned ${res.status}` };
      const j = (await res.json()) as { page?: { status?: string } };
      const st = j.page?.status ?? "";
      if (st === "UP") return { status: "ok", detail: "All systems operational" };
      if (st === "UNDERMAINTENANCE") return { status: "degraded", detail: "Under maintenance" };
      return { status: "degraded", detail: "Reporting issues" };
    }
    const res = await fetch(`${base}/api/v2/status.json`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return { status: "unknown", detail: `Status page returned ${res.status}` };
    const j = (await res.json()) as { status?: { indicator?: string; description?: string } };
    const ind = j.status?.indicator ?? "";
    const detail = j.status?.description ?? ind;
    if (ind === "none") return { status: "ok", detail };
    if (ind === "minor" || ind === "maintenance") return { status: "degraded", detail };
    if (ind === "major" || ind === "critical") return { status: "down", detail };
    return { status: "unknown", detail: detail || "Unrecognised response" };
  } catch (e) {
    return { status: "unknown", detail: `Couldn't reach status page: ${(e as Error).message}` };
  }
}
