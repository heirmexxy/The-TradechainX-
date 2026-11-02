"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, ApiError } from "@/lib/api";
import { Button, Notice, PageHeader, Panel, Pill, Spinner, type Tone } from "@/components/ui";

type Status = "ok" | "degraded" | "down" | "unknown" | "disabled";
type Check = {
  name: string;
  label: string;
  category: "platform" | "provider" | "supplier";
  status: Status;
  detail: string;
  latencyMs: number | null;
  data: Record<string, unknown> & { page?: string };
  checkedAt: string;
  changedAt: string;
};
type Health = {
  overall: Status;
  lastRun: string | null;
  intervalSeconds: number;
  alertChannels: string[];
  checks: Check[];
  events: { id: number; name: string; from: string | null; to: Status; detail: string; at: string }[];
};

const TONE: Record<Status, Tone> = { ok: "good", degraded: "warn", down: "bad", unknown: "neutral", disabled: "neutral" };
const WORD: Record<Status, string> = { ok: "Working", degraded: "Degraded", down: "Down", unknown: "Unknown", disabled: "Off" };
const DOT: Record<Status, string> = { ok: "bg-leaf", degraded: "bg-maize", down: "bg-danger", unknown: "bg-slate-300", disabled: "bg-slate-300" };

const ago = (iso: string | null) => {
  if (!iso) return "never";
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
};

export default function HealthPage() {
  const { data, isLoading, refetch, error } = useQuery({
    queryKey: ["adminHealth"],
    queryFn: () => api<Health>("/admin/health"),
    refetchInterval: 30_000,
  });
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);

  async function runNow() {
    setRunning(true);
    setRunError(null);
    try {
      await api("/admin/health/run", { body: {} });
      await refetch();
    } catch (e) {
      setRunError(e instanceof ApiError ? e.message : "Couldn't run the checks.");
    } finally {
      setRunning(false);
    }
  }

  if (isLoading) return <Spinner />;
  if (error || !data) return <Notice tone="bad" title="Couldn't load system health">If the API itself is down, this page can't load — check the server directly.</Notice>;

  const groups: [string, string, Check[]][] = [
    ["Platform", "Our own services: API, database, blockchain connection, indexer and contracts.", data.checks.filter((c) => c.category === "platform")],
    ["Providers", "Services we depend on, checked with our own credentials.", data.checks.filter((c) => c.category === "provider")],
    ["Suppliers' status pages", "What our suppliers report publicly. An outage here usually explains a problem above.", data.checks.filter((c) => c.category === "supplier")],
  ];
  const headline =
    data.overall === "ok" ? "All systems working" : data.overall === "down" ? "Something is down" : data.overall === "degraded" ? "Some systems degraded" : "Waiting for the first check";

  return (
    <>
      <PageHeader
        title="System health"
        intro={`Checked every ${data.intervalSeconds} seconds. Last run ${ago(data.lastRun)}.`}
        actions={<Button variant="secondary" onClick={runNow} disabled={running}>{running ? "Checking…" : "Run checks now"}</Button>}
      />

      <div className={`mb-6 flex items-center gap-3 rounded border px-5 py-4 ${data.overall === "ok" ? "border-leaf/30 bg-leaf-100" : data.overall === "down" ? "border-danger/30 bg-danger-100" : "border-maize/50 bg-maize-100"}`}>
        <span className={`h-3 w-3 rounded-full ${DOT[data.overall]}`} aria-hidden />
        <p className="font-semibold text-ink-900">{headline}</p>
        <p className="ml-auto text-sm text-slate">
          Alerts: {data.alertChannels.length ? data.alertChannels.join(", ") : <span className="text-danger">none configured</span>}
        </p>
      </div>
      {runError && <div className="mb-4"><Notice tone="bad">{runError}</Notice></div>}

      <div className="space-y-6">
        {groups.map(([title, intro, checks]) =>
          checks.length === 0 ? null : (
            <Panel key={title} title={title}>
              <p className="-mt-2 mb-4 text-sm text-slate-500">{intro}</p>
              <ul className="divide-y divide-line">
                {checks.map((c) => (
                  <li key={c.name} className="flex flex-wrap items-start gap-x-4 gap-y-1 py-3">
                    <span className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${DOT[c.status]}`} aria-hidden />
                    <div className="min-w-0 flex-1">
                      <p className="font-medium text-ink-900">
                        {c.data.page ? (
                          <a href={c.data.page} target="_blank" rel="noreferrer" className="underline decoration-line underline-offset-2">
                            {c.label}
                          </a>
                        ) : (
                          c.label
                        )}
                      </p>
                      <p className="text-sm text-slate">{c.detail}</p>
                    </div>
                    <div className="flex items-center gap-3 text-xs text-slate-500">
                      {c.latencyMs != null && c.category !== "supplier" && <span>{c.latencyMs} ms</span>}
                      <span title={`Status since ${new Date(c.changedAt).toLocaleString()}`}>since {ago(c.changedAt)}</span>
                      <Pill tone={TONE[c.status]}>{WORD[c.status]}</Pill>
                    </div>
                  </li>
                ))}
              </ul>
            </Panel>
          ),
        )}

        <Panel title="Recent changes">
          {data.events.length === 0 ? (
            <p className="text-sm text-slate-500">No status changes yet.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {data.events.map((e) => {
                const label = data.checks.find((c) => c.name === e.name)?.label ?? e.name.replace(/^supplier:/, "");
                return (
                  <li key={e.id} className="flex flex-wrap gap-x-3">
                    <span className="w-28 shrink-0 text-slate-500">{ago(e.at)}</span>
                    <span className="font-medium text-ink-900">{label}</span>
                    <span className="text-slate">
                      {e.from ? WORD[e.from as Status] ?? e.from : "new"} → <Pill tone={TONE[e.to]}>{WORD[e.to]}</Pill>
                    </span>
                    <span className="text-slate-500">{e.detail}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>

        <Notice title="Outside monitoring">
          This page runs inside TradeChainX, so it can't warn you if the whole server is offline. Keep an external uptime monitor
          (e.g. UptimeRobot or Better Stack) pointed at <code>/health</code> — see the production runbook.
        </Notice>
      </div>
    </>
  );
}
