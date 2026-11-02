"use client";

import Link from "next/link";
import { use, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ASSET_TYPE_LABEL, SUBMISSION_STATUS_LABEL, SubmissionStatus, type AssetType } from "@tradechainx/shared";
import { api, documentUrl, type UploadedDocument } from "@/lib/api";
import { fromApi } from "@/lib/calls";
import { withReason } from "@/lib/admin";
import type { PreparedCallJson } from "@/lib/types";
import { addr } from "@/lib/format";
import { TxButton } from "@/components/TxButton";
import { Facts, Field, Notice, PageHeader, Panel, Pill, Spinner, Textarea } from "@/components/ui";

type Detail = {
  submission: { status: number; submitter: string; holder: string | null; tokenId: string | null };
  draft: { fields: Record<string, unknown> } | null;
  submittedBy: { email: string; orgName: string | null; userType: string | null } | null;
  documents: UploadedDocument[];
  checks: { level: "info" | "warn"; message: string }[];
  calls: { approve: PreparedCallJson; requestInfo: PreparedCallJson; reject: PreparedCallJson };
};

const LABELS: Record<string, string> = {
  warehouseId: "Warehouse",
  receiptNumber: "Receipt number",
  holderEmail: "Depositor",
  commodity: "Commodity",
  grade: "Grade",
  quantity: "Quantity",
  unit: "Unit",
  depositDate: "Deposited",
  expiryDate: "Storage ends",
  lpoNumber: "LPO number",
  buyerName: "Buyer",
  buyerRegistrationNumber: "Buyer CAC number",
  description: "Goods",
  faceValue: "Face value (USDC)",
  issueDate: "Order date",
  dueDate: "Payment due",
  registry: "Registry",
  registryBatchId: "Registry batch",
  projectId: "Project ID",
  projectName: "Project",
  methodology: "Methodology",
  vintage: "Vintage",
  country: "Country",
  notes: "Submitter's notes",
};

export default function ReviewDetail({ params }: { params: Promise<{ type: AssetType; id: string }> }) {
  const { type, id } = use(params);
  const { data, refetch } = useQuery({ queryKey: ["adminSubmission", type, id], queryFn: () => api<Detail>(`/admin/submissions/${type}/${id}`) });
  const [note, setNote] = useState("");
  if (!data) return <Spinner />;
  const s = data.submission;
  const pending = s.status === SubmissionStatus.Pending;
  const refresh = () => setTimeout(() => void refetch(), 3000);
  const saveNote = async () => {
    await api("/admin/review-notes", { body: { entityType: `${type}-submission`, entityId: id, note } });
    setNote("");
    refresh();
  };

  return (
    <>
      <Link href="/admin/reviews" className="text-sm text-ink-700 underline">Back to reviews</Link>
      <PageHeader
        title={`${ASSET_TYPE_LABEL[type]} · submission ${id}`}
        intro={`From ${data.submittedBy?.orgName ?? data.submittedBy?.email ?? addr(s.submitter)}`}
        actions={<Pill tone={pending ? "warn" : "neutral"}>{SUBMISSION_STATUS_LABEL[s.status]}</Pill>}
      />
      <div className="grid gap-6 md:grid-cols-2">
        <div className="space-y-6">
          <Panel title="Submitted details">
            {data.draft ? (
              <Facts items={Object.entries(data.draft.fields).map(([k, v]) => [LABELS[k] ?? k, Array.isArray(v) ? v.join(", ") : String(v)] as [string, string])} />
            ) : (
              <p className="text-sm text-slate">No off-chain details on file.</p>
            )}
            {s.holder && <p className="mt-4 text-sm text-slate">Token will be issued to {addr(s.holder)}.</p>}
          </Panel>
          <Panel title="Documents">
            {data.documents.length === 0 ? (
              <p className="text-sm text-slate">None attached.</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {data.documents.map((d) => (
                  <li key={d.id} className="flex justify-between gap-3">
                    <a className="underline" href={documentUrl(d.id)} target="_blank" rel="noreferrer">{d.kind.replace(/_/g, " ")}</a>
                    <span className="truncate text-slate-500">{d.filename}</span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>

        <div className="space-y-6">
          <Panel title="Automated checks">
            {data.checks.length === 0 ? (
              <Notice tone="good">No issues found.</Notice>
            ) : (
              <div className="space-y-2">
                {data.checks.map((c, i) => (
                  <Notice key={i} tone={c.level === "warn" ? "warn" : "neutral"}>{c.message}</Notice>
                ))}
              </div>
            )}
          </Panel>

          {pending && (
            <Panel title="Decision">
              <p className="mb-4 text-sm text-slate">Approving creates the asset immediately. Check the documents match every detail first.</p>
              <TxButton title="Approve and issue" label="Approve and issue" doneText="Approved. The asset has been issued." calls={[fromApi(data.calls.approve)]} onDone={refresh} />
              <div className="mt-6 space-y-3 border-t border-line pt-5">
                <Field label="Note to the submitter" hint="Kept off-chain; only its fingerprint is recorded.">
                  <Textarea value={note} onChange={(e) => setNote(e.target.value)} />
                </Field>
                <div className="flex flex-wrap gap-2">
                  <TxButton variant="secondary" title="Ask for more information" label="Ask for more" doneText="Sent back to the submitter." disabled={!note} calls={() => [withReason(data.calls.requestInfo, note)]} onDone={saveNote} />
                  <TxButton variant="danger" title="Reject" label="Reject" doneText="Rejected." disabled={!note} calls={() => [withReason(data.calls.reject, note)]} onDone={saveNote} />
                </div>
              </div>
            </Panel>
          )}
          {s.tokenId && (
            <Link href={`/assets/${type}/${s.tokenId}`} className="text-ink-700 underline">View the issued asset</Link>
          )}
        </div>
      </div>
    </>
  );
}
