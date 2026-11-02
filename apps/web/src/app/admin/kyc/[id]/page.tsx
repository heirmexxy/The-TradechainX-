"use client";

import Link from "next/link";
import { use, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Tier, USER_TYPE_LABEL, type UserType } from "@tradechainx/shared";
import { api, ApiError, documentUrl, type UploadedDocument } from "@/lib/api";
import { fromApi } from "@/lib/calls";
import type { PreparedCallJson } from "@/lib/types";
import { addr, date } from "@/lib/format";
import { TxButton } from "@/components/TxButton";
import { Button, Facts, Field, Notice, PageHeader, Panel, Select, Spinner, Textarea } from "@/components/ui";

type Detail = {
  case: { id: string; status: string; track: string; details: Record<string, string>; submittedAt: string; reviewerNote: string | null };
  applicant: { id: string; email: string; userType: UserType | null; walletAddress: string | null; orgName: string | null };
  suggestedTier: number | null;
  documents: UploadedDocument[];
  history: { id: string; status: string; submittedAt: string; note: string | null }[];
  onchainCall: PreparedCallJson | null;
};

const FIELD_LABEL: Record<string, string> = {
  fullName: "Full name",
  dateOfBirth: "Date of birth",
  nationality: "Nationality",
  idType: "ID type",
  idLast4: "ID ends in",
  phone: "Phone",
  address: "Address",
  companyName: "Business name",
  registrationNumber: "CAC number",
  country: "Country",
  registeredAddress: "Registered address",
  facilityAddress: "Facility address",
  signatoryName: "Signatory",
  signatoryRole: "Signatory's role",
};

export default function KycCase({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const qc = useQueryClient();
  const { data, refetch } = useQuery({ queryKey: ["adminKycCase", id], queryFn: () => api<Detail>(`/admin/kyc/${id}`) });
  const [decision, setDecision] = useState<"approve" | "needs_info" | "reject">("approve");
  const [note, setNote] = useState("");
  const [tier, setTier] = useState<number | "">("");
  const [validForDays, setValidForDays] = useState(365);
  const [pending, setPending] = useState<PreparedCallJson | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!data) return <Spinner />;
  const c = data.case;
  const call = pending ?? data.onchainCall;

  async function decide() {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ status: string; onchainCall: PreparedCallJson | null }>(`/admin/kyc/${id}/decision`, {
        body: { decision, note: note || undefined, tier: tier === "" ? undefined : tier, validForDays },
      });
      setPending(res.onchainCall);
      await refetch();
      void qc.invalidateQueries({ queryKey: ["adminKyc"] });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't save the decision.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Link href="/admin/kyc" className="text-sm text-ink-700 underline">Back to verification</Link>
      <PageHeader title={c.details.fullName ?? c.details.companyName ?? data.applicant.email} intro={`${data.applicant.userType ? USER_TYPE_LABEL[data.applicant.userType] : ""} · ${c.track} check · submitted ${date(c.submittedAt)}`} />

      <div className="grid gap-6 md:grid-cols-2">
        <div className="space-y-6">
          <Panel title="Details">
            <Facts items={[["Email", data.applicant.email], ["Account", addr(data.applicant.walletAddress)], ...Object.entries(c.details).map(([k, v]) => [FIELD_LABEL[k] ?? k, String(v)] as [string, string])]} />
          </Panel>
          <Panel title="Documents">
            <ul className="space-y-2 text-sm">
              {data.documents.map((d) => (
                <li key={d.id} className="flex justify-between gap-3">
                  <a className="underline" href={documentUrl(d.id)} target="_blank" rel="noreferrer">{d.kind.replace(/_/g, " ")}</a>
                  <span className="text-slate-500">{d.filename}</span>
                </li>
              ))}
            </ul>
          </Panel>
          {data.history.length > 1 && (
            <Panel title="Previous attempts">
              <ul className="space-y-2 text-sm">
                {data.history.filter((h) => h.id !== c.id).map((h) => (
                  <li key={h.id}>{date(h.submittedAt)}: {h.status}{h.note ? ` — ${h.note}` : ""}</li>
                ))}
              </ul>
            </Panel>
          )}
        </div>

        <div className="space-y-6">
          {c.status === "pending" && !call && (
            <Panel title="Decision">
              <div className="space-y-4">
                <Field label="Outcome">
                  <Select value={decision} onChange={(e) => setDecision(e.target.value as typeof decision)}>
                    <option value="approve">Approve</option>
                    <option value="needs_info">Ask for more information</option>
                    <option value="reject">Decline</option>
                  </Select>
                </Field>
                {decision === "approve" && (
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="Verification level" hint={data.suggestedTier ? `Suggested for this account type: ${Object.keys(Tier).find((k) => Tier[k as keyof typeof Tier] === data.suggestedTier)}` : undefined}>
                      <Select value={tier} onChange={(e) => setTier(e.target.value === "" ? "" : Number(e.target.value))}>
                        <option value="">Suggested</option>
                        <option value={Tier.Individual}>Individual</option>
                        <option value={Tier.Business}>Business</option>
                        <option value={Tier.Institutional}>Institutional</option>
                      </Select>
                    </Field>
                    <Field label="Valid for (days)">
                      <Select value={validForDays} onChange={(e) => setValidForDays(Number(e.target.value))}>
                        <option value={180}>180</option>
                        <option value={365}>365</option>
                        <option value={730}>730</option>
                      </Select>
                    </Field>
                  </div>
                )}
                <Field label={decision === "approve" ? "Note (optional, internal)" : "What the applicant needs to know"} hint={decision === "needs_info" ? "They'll see this message." : undefined}>
                  <Textarea value={note} onChange={(e) => setNote(e.target.value)} />
                </Field>
                {error && <Notice tone="bad">{error}</Notice>}
                <Button onClick={decide} disabled={busy || (decision !== "approve" && !note)} variant={decision === "reject" ? "danger" : "primary"}>
                  {busy ? "Saving…" : decision === "approve" ? "Approve" : decision === "needs_info" ? "Send request" : "Decline"}
                </Button>
              </div>
            </Panel>
          )}

          {call && (
            <Panel title="Record the verification">
              <p className="mb-4 text-sm text-slate">{call.summary}. The applicant becomes verified once this is recorded.</p>
              <TxButton title="Record verification" label="Record on-chain" doneText="Recorded. The applicant is verified." calls={[fromApi(call)]} onDone={() => { setPending(null); setTimeout(() => void refetch(), 3000); }} />
            </Panel>
          )}

          {c.status === "verified" && <Notice tone="good" title="Verified" />}
          {c.status === "needs_info" && <Notice tone="warn" title="Waiting for the applicant">{c.reviewerNote}</Notice>}
          {c.status === "rejected" && <Notice tone="bad" title="Declined">{c.reviewerNote}</Notice>}
        </div>
      </div>
    </>
  );
}
