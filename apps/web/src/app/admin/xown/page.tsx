"use client";

import { useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, ApiError, type UploadedDocument } from "@/lib/api";
import { fromApi } from "@/lib/calls";
import { withReason } from "@/lib/admin";
import type { OfferingView, PreparedCallJson } from "@/lib/types";
import { addr, date, num, usdc } from "@/lib/format";
import { hasRole, useSession } from "@/lib/session";
import { DocumentUpload } from "@/components/DocumentUpload";
import { TxButton } from "@/components/TxButton";
import { Button, Empty, Field, Input, Notice, PageHeader, Panel, Textarea } from "@/components/ui";

type Proposal = { offering: OfferingView; fields: Record<string, string> | null; calls: { approve: PreparedCallJson; reject: PreparedCallJson } };

export default function XOwnAdmin() {
  const { data: user } = useSession();
  const { data, refetch } = useQuery({ queryKey: ["xownProposals"], queryFn: () => api<{ proposals: Proposal[] }>("/admin/xown/proposals") });
  const refresh = () => setTimeout(() => void refetch(), 3000);
  return (
    <>
      <PageHeader title="XOwn offerings" intro="An asset manager proposes a machine; a different reviewer approves it. Approval creates the offering and opens it to investors." />
      {hasRole(user, "asset_manager") && <ProposeOffering onDone={refresh} />}
      <div className="mt-8">
        <Panel title="Waiting for approval">
          {!data?.proposals.length ? (
            <Empty title="No proposals waiting" />
          ) : (
            <ul className="space-y-4">
              {data.proposals.map((p) => <ProposalRow key={p.offering.proposalId} p={p} canReview={hasRole(user, "listing_reviewer")} onDone={refresh} />)}
            </ul>
          )}
        </Panel>
      </div>
    </>
  );
}

function ProposalRow({ p, canReview, onDone }: { p: Proposal; canReview: boolean; onDone: () => void }) {
  const [note, setNote] = useState("");
  const o = p.offering;
  return (
    <li className="rounded border border-line p-4">
      <p className="font-semibold text-ink-900">{o.name}</p>
      <p className="text-sm text-slate">
        {num(o.maxShares)} shares at {usdc(o.pricePerShare)} · closes {date(o.deadline)} · operator {addr(o.operator)}
      </p>
      {p.fields?.serialNumber && <p className="text-sm text-slate">Serial {p.fields.serialNumber} · {p.fields.location}</p>}
      {canReview && (
        <div className="mt-4 flex flex-wrap items-end gap-2">
          <TxButton title="Approve offering" label="Approve and open" doneText="Approved. The offering is live." calls={[fromApi(p.calls.approve)]} onDone={onDone} />
          <Input placeholder="Reason for rejecting" value={note} onChange={(e) => setNote(e.target.value)} className="max-w-xs" />
          <TxButton
            variant="danger"
            title="Reject proposal"
            label="Reject"
            doneText="Rejected."
            disabled={!note}
            calls={() => [withReason(p.calls.reject, note)]}
            onDone={async () => {
              await api("/admin/review-notes", { body: { entityType: "xown-proposal", entityId: o.proposalId, note } });
              onDone();
            }}
          />
        </div>
      )}
    </li>
  );
}

function ProposeOffering({ onDone }: { onDone: () => void }) {
  const [f, setF] = useState<Record<string, string>>({});
  const [docs, setDocs] = useState<UploadedDocument[]>([]);
  const [prepared, setPrepared] = useState<PreparedCallJson | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: string) => setF((x) => ({ ...x, [k]: v }));

  async function prepare(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const fields = Object.fromEntries(Object.entries(f).filter(([, v]) => v !== ""));
      const res = await api<{ call: PreparedCallJson }>("/drafts/xown", { body: { fields, documentIds: docs.map((d) => d.id) } });
      setPrepared(res.call);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't prepare the proposal.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title="Propose a machine">
      {prepared ? (
        <div className="flex gap-2">
          <TxButton title="Propose offering" label="Send for approval" doneText="Proposed. A reviewer will look at it." calls={[fromApi(prepared)]} onDone={() => { setPrepared(null); setF({}); setDocs([]); onDone(); }} />
          <Button variant="quiet" onClick={() => setPrepared(null)}>Edit</Button>
        </div>
      ) : (
        <form onSubmit={prepare} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Offering name"><Input value={f.name ?? ""} onChange={(e) => set("name", e.target.value)} required placeholder="Tractor 01, Iseyin" /></Field>
            <Field label="Short code" hint="2–12 capitals, e.g. XO-ISY01"><Input value={f.symbol ?? ""} onChange={(e) => set("symbol", e.target.value.toUpperCase())} required /></Field>
            <Field label="Operator's email" hint="Verified business that runs the machine."><Input type="email" value={f.operatorEmail ?? ""} onChange={(e) => set("operatorEmail", e.target.value)} required /></Field>
            <Field label="Machine type" hint="e.g. TRACTOR, DRYER, THRESHER"><Input value={f.equipmentType ?? ""} onChange={(e) => set("equipmentType", e.target.value.toUpperCase())} required /></Field>
            <Field label="Serial / chassis number"><Input value={f.serialNumber ?? ""} onChange={(e) => set("serialNumber", e.target.value)} required /></Field>
            <Field label="Location"><Input value={f.location ?? ""} onChange={(e) => set("location", e.target.value)} required /></Field>
            <Field label="Number of shares"><Input type="number" value={f.maxShares ?? ""} onChange={(e) => set("maxShares", e.target.value)} required /></Field>
            <Field label="Price per share (USDC)"><Input inputMode="decimal" value={f.pricePerShare ?? ""} onChange={(e) => set("pricePerShare", e.target.value)} required /></Field>
            <Field label="Open until"><Input type="date" value={f.subscriptionDeadline ?? ""} onChange={(e) => set("subscriptionDeadline", e.target.value)} required /></Field>
            <Field label="Operator's earnings estimate (% a year)" hint="Shown as an estimate, never a promise."><Input type="number" value={f.expectedAnnualYieldPct ?? ""} onChange={(e) => set("expectedAnnualYieldPct", e.target.value)} /></Field>
          </div>
          <Field label="Description"><Textarea value={f.description ?? ""} onChange={(e) => set("description", e.target.value)} required /></Field>
          <DocumentUpload kinds={[{ key: "invoice", label: "Purchase invoice / quote" }, { key: "insurance", label: "Insurance" }, { key: "spv_agreement", label: "Operator agreement" }]} value={docs} onChange={setDocs} />
          {error && <Notice tone="bad">{error}</Notice>}
          <Button type="submit" disabled={busy || docs.length === 0}>{busy ? "Checking…" : "Continue"}</Button>
        </form>
      )}
    </Panel>
  );
}
