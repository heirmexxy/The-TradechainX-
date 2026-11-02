"use client";

import { useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, ApiError, API_URL } from "@/lib/api";
import { addr, date, num } from "@/lib/format";
import { Button, Empty, Facts, Field, Input, Notice, PageHeader, Panel, Pill, Spinner } from "@/components/ui";

type Partner = {
  id: string;
  name: string;
  accountEmail: string;
  accountWallet: string | null;
  contactEmail: string;
  website: string | null;
  referralCode: string;
  status: "active" | "suspended";
  activeKeys: number;
  activeWebhooks: number;
  requests7d: number;
  drafts: number;
  createdAt: string;
};
type ListResponse = { enabled: boolean; partners: Partner[]; scopes: string[]; events: { type: string; description: string }[] };

type ApiKey = { id: string; name: string; prefix: string; scopes: string[]; rateLimitPerMinute: number; dailyQuota: number; lastUsedAt: string | null; revokedAt: string | null; createdAt: string };
type Webhook = { id: string; url: string; events: string[]; active: boolean; secretVersion: number };
type Delivery = { id: string; eventType: string; status: string; attempts: number; lastStatusCode: number | null; lastError: string | null; createdAt: string; webhookId: string };
type Detail = {
  partner: Partner;
  account: { email: string; walletAddress: string | null; orgName: string | null } | null;
  keys: ApiKey[];
  webhooks: Webhook[];
  usage: { day: string; requests: number }[];
  deliveries: Delivery[];
  drafts: { id: string; assetType: string; createdAt: string; submissionId: string | null }[];
};

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : "Something went wrong.");

export default function PartnersPage() {
  const { data, isLoading, refetch } = useQuery({ queryKey: ["adminPartners"], queryFn: () => api<ListResponse>("/admin/partners") });
  const [openId, setOpenId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  return (
    <>
      <PageHeader
        title="Partners"
        intro="Verified businesses that build on TradeChainX through the Partner API and widgets. Everything they submit goes through the same review queue as everyone else."
        actions={<Button onClick={() => setAdding(!adding)}>{adding ? "Close" : "Add partner"}</Button>}
      />
      {data && !data.enabled && (
        <div className="mb-6">
          <Notice tone="warn" title="Partner API is switched off">
            You can set partners up here, but their API calls and webhooks only work once the API runs with PARTNER_API_ENABLED=true and WEBHOOK_SECRET_PEPPER set.
          </Notice>
        </div>
      )}
      {adding && <AddPartner onDone={() => { setAdding(false); void refetch(); }} />}
      {isLoading && <Spinner />}
      {data && data.partners.length === 0 && !adding && (
        <Empty title="No partners yet">A partner must first sign up to TradeChainX and pass business verification. Then add them here.</Empty>
      )}
      <div className="space-y-3">
        {data?.partners.map((p) => (
          <Panel key={p.id}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="font-semibold text-ink-900">
                  {p.name} {p.status === "suspended" && <Pill tone="bad">Suspended</Pill>}
                </p>
                <p className="text-sm text-slate">
                  {p.accountEmail} · {addr(p.accountWallet)} · ref <code>{p.referralCode}</code>
                </p>
                <p className="text-xs text-slate-500">
                  {p.activeKeys} active key{p.activeKeys === 1 ? "" : "s"} · {p.activeWebhooks} webhook{p.activeWebhooks === 1 ? "" : "s"} · {num(p.requests7d)} requests in 7 days · {p.drafts} submissions
                </p>
              </div>
              <Button variant="quiet" onClick={() => setOpenId(openId === p.id ? null : p.id)}>{openId === p.id ? "Close" : "Manage"}</Button>
            </div>
            {openId === p.id && data && <PartnerDetail id={p.id} scopes={data.scopes} events={data.events} onChanged={() => void refetch()} />}
          </Panel>
        ))}
      </div>
    </>
  );
}

function AddPartner({ onDone }: { onDone: () => void }) {
  const [f, setF] = useState({ name: "", accountEmail: "", contactEmail: "", website: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/admin/partners", { body: f });
      onDone();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="mb-6">
      <Panel title="Add a partner">
        <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
          <Field label="Partner name"><Input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="Their TradeChainX account email" hint="Must be a verified business account."><Input required type="email" value={f.accountEmail} onChange={(e) => setF({ ...f, accountEmail: e.target.value })} /></Field>
          <Field label="Technical contact email"><Input required type="email" value={f.contactEmail} onChange={(e) => setF({ ...f, contactEmail: e.target.value })} /></Field>
          <Field label="Website (optional)"><Input type="url" value={f.website} onChange={(e) => setF({ ...f, website: e.target.value })} /></Field>
          {error && <div className="sm:col-span-2"><Notice tone="bad">{error}</Notice></div>}
          <div className="sm:col-span-2"><Button type="submit" disabled={busy}>{busy ? "Adding…" : "Add partner"}</Button></div>
        </form>
      </Panel>
    </div>
  );
}

function ShowOnce({ label, value, onClose }: { label: string; value: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="my-3 rounded border border-maize/50 bg-maize-100 p-4">
      <p className="font-semibold text-ink-900">{label}</p>
      <p className="mt-1 text-sm text-slate">Copy it now and send it to the partner through a secure channel (e.g. a password manager share). It won't be shown again.</p>
      <code className="mt-3 block break-all rounded bg-white p-2 text-sm">{value}</code>
      <div className="mt-3 flex gap-2">
        <Button variant="secondary" onClick={() => { void navigator.clipboard.writeText(value); setCopied(true); }}>{copied ? "Copied" : "Copy"}</Button>
        <Button variant="quiet" onClick={onClose}>I've saved it</Button>
      </div>
    </div>
  );
}

function PartnerDetail({ id, scopes, events, onChanged }: { id: string; scopes: string[]; events: { type: string; description: string }[]; onChanged: () => void }) {
  const { data, refetch } = useQuery({ queryKey: ["adminPartner", id], queryFn: () => api<Detail>(`/admin/partners/${id}`) });
  const [secret, setSecret] = useState<{ label: string; value: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [keyForm, setKeyForm] = useState({ name: "", scopes: ["read"] as string[], rateLimitPerMinute: 60, dailyQuota: 10000 });
  const [hookForm, setHookForm] = useState({ url: "", events: [] as string[] });

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await refetch();
      onChanged();
    } catch (e) {
      setError(errMsg(e));
    }
  };

  if (!data) return <div className="mt-4"><Spinner /></div>;
  const p = data.partner;
  const embedSnippet = `<script src="${typeof window !== "undefined" ? window.location.origin : ""}/embed.js" data-api="${API_URL}" defer></script>\n<div data-tradechainx="offering" data-vault="0x…" data-ref="${p.referralCode}"></div>`;

  return (
    <div className="mt-4 space-y-6 border-t border-line pt-4">
      {error && <Notice tone="bad">{error}</Notice>}
      {secret && <ShowOnce label={secret.label} value={secret.value} onClose={() => setSecret(null)} />}

      <Facts
        cols={3}
        items={[
          ["Account", data.account?.orgName ?? data.account?.email ?? "—"],
          ["Signing wallet", addr(data.account?.walletAddress)],
          ["Contact", p.contactEmail],
          ["Referral code", <code key="r">{p.referralCode}</code>],
          ["Added", date(p.createdAt)],
          ["Requests (14 days)", num(data.usage.reduce((s, u) => s + u.requests, 0))],
        ]}
      />
      <div className="flex gap-2">
        {p.status === "active" ? (
          <Button variant="danger" onClick={() => act(() => api(`/admin/partners/${id}`, { method: "PATCH", body: { status: "suspended" } }))}>Suspend partner</Button>
        ) : (
          <Button variant="secondary" onClick={() => act(() => api(`/admin/partners/${id}`, { method: "PATCH", body: { status: "active" } }))}>Reactivate</Button>
        )}
      </div>

      <section>
        <h3 className="text-h3">API keys</h3>
        <ul className="mt-2 divide-y divide-line text-sm">
          {data.keys.map((k) => (
            <li key={k.id} className="flex flex-wrap items-center gap-3 py-2">
              <code>tcx_…_{k.prefix}_…</code>
              <span className="font-medium">{k.name}</span>
              <span className="text-slate">{k.scopes.join(", ")}</span>
              <span className="text-slate-500">{k.rateLimitPerMinute}/min · {num(k.dailyQuota)}/day · last used {k.lastUsedAt ? date(k.lastUsedAt) : "never"}</span>
              {k.revokedAt ? <Pill tone="bad">Revoked</Pill> : <Button variant="quiet" className="ml-auto" onClick={() => act(() => api(`/admin/partners/${id}/keys/${k.id}/revoke`, { body: {} }))}>Revoke</Button>}
            </li>
          ))}
        </ul>
        <form
          className="mt-3 grid gap-3 rounded border border-line p-3 sm:grid-cols-4"
          onSubmit={(e) => {
            e.preventDefault();
            void act(async () => {
              const r = await api<{ key: string }>(`/admin/partners/${id}/keys`, { body: keyForm });
              setSecret({ label: `New API key "${keyForm.name}"`, value: r.key });
              setKeyForm({ ...keyForm, name: "" });
            });
          }}
        >
          <Field label="Key name"><Input required placeholder="e.g. Production server" value={keyForm.name} onChange={(e) => setKeyForm({ ...keyForm, name: e.target.value })} /></Field>
          <Field label="Requests / minute"><Input type="number" min={1} value={keyForm.rateLimitPerMinute} onChange={(e) => setKeyForm({ ...keyForm, rateLimitPerMinute: Number(e.target.value) })} /></Field>
          <Field label="Requests / day"><Input type="number" min={1} value={keyForm.dailyQuota} onChange={(e) => setKeyForm({ ...keyForm, dailyQuota: Number(e.target.value) })} /></Field>
          <fieldset>
            <legend className="field-label">Scopes</legend>
            {scopes.map((s) => (
              <label key={s} className="mr-3 inline-flex items-center gap-1 text-sm">
                <input type="checkbox" checked={keyForm.scopes.includes(s)} onChange={(e) => setKeyForm({ ...keyForm, scopes: e.target.checked ? [...keyForm.scopes, s] : keyForm.scopes.filter((x) => x !== s) })} />
                {s}
              </label>
            ))}
          </fieldset>
          <p className="text-xs text-slate-500 sm:col-span-3">read = offerings, assets, listings. issue = upload documents and submit drafts for review. trade = prepared buy/list/subscribe/settle calls for the partner's own wallet.</p>
          <Button type="submit" disabled={!keyForm.name || keyForm.scopes.length === 0}>Create key</Button>
        </form>
      </section>

      <section>
        <h3 className="text-h3">Webhooks</h3>
        <ul className="mt-2 divide-y divide-line text-sm">
          {data.webhooks.map((h) => (
            <li key={h.id} className="flex flex-wrap items-center gap-3 py-2">
              <span className="break-all font-medium">{h.url}</span>
              <span className="text-slate">{h.events.join(", ")}</span>
              {!h.active && <Pill tone="warn">Paused</Pill>}
              <span className="ml-auto flex gap-1">
                <Button variant="quiet" onClick={() => act(() => api(`/admin/webhooks/${h.id}/test`, { body: {} }))}>Send test</Button>
                <Button variant="quiet" onClick={() => act(async () => { const r = await api<{ secret: string }>(`/admin/webhooks/${h.id}/rotate`, { body: {} }); setSecret({ label: "New webhook signing secret", value: r.secret }); })}>Rotate secret</Button>
                <Button variant="quiet" onClick={() => act(() => api(`/admin/webhooks/${h.id}`, { method: "PATCH", body: { active: !h.active } }))}>{h.active ? "Pause" : "Resume"}</Button>
              </span>
            </li>
          ))}
        </ul>
        <form
          className="mt-3 space-y-3 rounded border border-line p-3"
          onSubmit={(e) => {
            e.preventDefault();
            void act(async () => {
              const r = await api<{ secret: string }>(`/admin/partners/${id}/webhooks`, { body: hookForm });
              setSecret({ label: "Webhook signing secret", value: r.secret });
              setHookForm({ url: "", events: [] });
            });
          }}
        >
          <Field label="Endpoint URL" hint="HTTPS, publicly reachable."><Input required type="url" placeholder="https://partner.example/webhooks/tradechainx" value={hookForm.url} onChange={(e) => setHookForm({ ...hookForm, url: e.target.value })} /></Field>
          <fieldset className="grid gap-1 sm:grid-cols-2">
            <legend className="field-label">Events</legend>
            {events.map((ev) => (
              <label key={ev.type} className="flex items-start gap-2 text-sm" title={ev.description}>
                <input type="checkbox" className="mt-1" checked={hookForm.events.includes(ev.type)} onChange={(e) => setHookForm({ ...hookForm, events: e.target.checked ? [...hookForm.events, ev.type] : hookForm.events.filter((x) => x !== ev.type) })} />
                <span><code>{ev.type}</code> <span className="text-slate-500">— {ev.description}</span></span>
              </label>
            ))}
          </fieldset>
          <Button type="submit" disabled={!hookForm.url || hookForm.events.length === 0}>Add webhook</Button>
        </form>
      </section>

      {data.deliveries.length > 0 && (
        <section>
          <h3 className="text-h3">Recent deliveries</h3>
          <ul className="mt-2 divide-y divide-line text-sm">
            {data.deliveries.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center gap-3 py-2">
                <code>{d.eventType}</code>
                <Pill tone={d.status === "delivered" ? "good" : d.status === "failed" ? "bad" : "warn"}>{d.status}</Pill>
                <span className="text-slate-500">{d.attempts} attempt{d.attempts === 1 ? "" : "s"}{d.lastError ? ` · ${d.lastError}` : ""}</span>
                <span className="text-slate-500">{date(d.createdAt)}</span>
                {d.status === "failed" && <Button variant="quiet" className="ml-auto" onClick={() => act(() => api(`/admin/webhook-deliveries/${d.id}/retry`, { body: {} }))}>Retry</Button>}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h3 className="text-h3">Widget snippet</h3>
        <p className="mt-1 text-sm text-slate">Give this to the partner. Sales through it carry their referral code.</p>
        <pre className="mt-2 overflow-x-auto rounded bg-ink-50 p-3 text-xs">{embedSnippet}</pre>
      </section>
    </div>
  );
}
