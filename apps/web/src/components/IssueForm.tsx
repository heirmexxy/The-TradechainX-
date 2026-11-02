"use client";

import { useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { ASSET_TYPE_LABEL } from "@tradechainx/shared";
import { api, ApiError, type UploadedDocument } from "@/lib/api";
import { fromApi } from "@/lib/calls";
import type { PreparedCallJson } from "@/lib/types";
import { useSession } from "@/lib/session";
import { DocumentUpload } from "./DocumentUpload";
import { TxButton } from "./TxButton";
import { Button, Field, Input, Notice, Panel, Select, Textarea } from "./ui";

export type IssueType = "warehouse-receipt" | "lpo" | "carbon";

const DOC_KINDS: Record<IssueType, { key: string; label: string }[]> = {
  "warehouse-receipt": [
    { key: "receipt_scan", label: "Signed receipt (scan)" },
    { key: "inspection_report", label: "Quality inspection report" },
    { key: "other", label: "Other" },
  ],
  lpo: [
    { key: "lpo", label: "Purchase order" },
    { key: "buyer_confirmation", label: "Buyer's confirmation letter" },
    { key: "other", label: "Other" },
  ],
  carbon: [
    { key: "registry_statement", label: "Registry issuance statement" },
    { key: "verification_report", label: "Verification report" },
    { key: "other", label: "Other" },
  ],
};

/**
 * Collects an asset's details and documents, asks the API to prepare the exact contract call, then
 * sends it. With `correction`, edits an existing draft the reviewer sent back and resubmits it.
 */
export function IssueForm({
  type,
  onSubmitted,
  correction,
}: {
  type: IssueType;
  onSubmitted: () => void;
  correction?: { draftId: string; fields: Record<string, string>; documents: UploadedDocument[] };
}) {
  const [fields, setFields] = useState<Record<string, string>>(correction?.fields ?? {});
  const [docs, setDocs] = useState<UploadedDocument[]>(correction?.documents ?? []);
  const [prepared, setPrepared] = useState<{ draftId: string; call: PreparedCallJson } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { data: warehouses } = useQuery({
    queryKey: ["warehouses"],
    enabled: type === "warehouse-receipt",
    queryFn: () => api<{ warehouses: { id: string; name?: string; active: boolean; operator: string }[] }>("/warehouses"),
  });
  const { data: user } = useSession();
  const set = (k: string, v: string) => setFields((f) => ({ ...f, [k]: v }));

  async function prepare(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = { fields, documentIds: docs.map((d) => d.id) };
      const res = correction
        ? await api<{ draft: { id: string }; call: PreparedCallJson }>(`/drafts/${correction.draftId}`, { method: "PATCH", body })
        : await api<{ draft: { id: string }; call: PreparedCallJson }>(`/drafts/${type}`, { body });
      setPrepared({ draftId: res.draft.id, call: res.call });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't prepare the submission.");
    } finally {
      setBusy(false);
    }
  }

  const mine = warehouses?.warehouses.filter((w) => w.operator === user?.walletAddress && w.active) ?? [];
  const F = FORM_FIELDS[type];

  return (
    <Panel title={ASSET_TYPE_LABEL[type]}>
      {type === "warehouse-receipt" && warehouses && mine.length === 0 && (
        <Notice tone="warn" title="No registered warehouse">Your warehouse needs to be registered by our team before you can issue receipts. Contact us to arrange the licence check.</Notice>
      )}
      {prepared ? (
        <div className="space-y-4">
          <Notice title="Ready to submit">Check the details above one last time. Once submitted, the reference number can't be reused.</Notice>
          <div className="flex gap-2">
            <TxButton
              title="Submit for review"
              label="Submit for review"
              doneText="Submitted. We'll let you know when it's reviewed."
              calls={[fromApi(prepared.call)]}
              onDone={async (hashes) => {
                await api(`/drafts/${prepared.draftId}/tx`, { body: { txHash: hashes[hashes.length - 1] } });
                setPrepared(null);
                setFields({});
                setDocs([]);
                onSubmitted();
              }}
            />
            <Button variant="quiet" onClick={() => setPrepared(null)}>Edit</Button>
          </div>
        </div>
      ) : (
        <form onSubmit={prepare} className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2">
            {type === "warehouse-receipt" && (
              <Field label="Warehouse">
                <Select value={fields.warehouseId ?? ""} onChange={(e) => set("warehouseId", e.target.value)} required>
                  <option value="">Choose…</option>
                  {mine.map((w) => (
                    <option key={w.id} value={w.id}>{w.name ?? `Warehouse ${w.id}`}</option>
                  ))}
                </Select>
              </Field>
            )}
            {F.map((f) => (
              <Field key={f.key} label={f.label} hint={f.hint}>
                {f.options ? (
                  <Select value={fields[f.key] ?? ""} onChange={(e) => set(f.key, e.target.value)} required={!f.optional}>
                    <option value="">Choose…</option>
                    {f.options.map(([v, l]) => (
                      <option key={v} value={v}>{l}</option>
                    ))}
                  </Select>
                ) : f.long ? (
                  <Textarea value={fields[f.key] ?? ""} onChange={(e) => set(f.key, e.target.value)} required={!f.optional} />
                ) : (
                  <Input
                    type={f.type ?? "text"}
                    inputMode={f.decimal ? "decimal" : undefined}
                    value={fields[f.key] ?? ""}
                    onChange={(e) => set(f.key, e.target.value)}
                    required={!f.optional}
                    readOnly={!!correction && f.fixedOnCorrection}
                  />
                )}
              </Field>
            ))}
          </div>
          <DocumentUpload kinds={DOC_KINDS[type]} value={docs} onChange={setDocs} />
          {error && <Notice tone="bad">{error}</Notice>}
          <Button type="submit" disabled={busy || docs.length === 0}>{busy ? "Checking…" : "Continue"}</Button>
        </form>
      )}
    </Panel>
  );
}

type FF = { key: string; label: string; hint?: string; type?: string; optional?: boolean; long?: boolean; decimal?: boolean; fixedOnCorrection?: boolean; options?: [string, string][] };

const FORM_FIELDS: Record<IssueType, FF[]> = {
  "warehouse-receipt": [
    { key: "receiptNumber", label: "Receipt number", hint: "Exactly as printed. It can only be used once.", fixedOnCorrection: true },
    { key: "holderEmail", label: "Depositor's email", hint: "They must have a verified TradeChainX account." },
    { key: "commodity", label: "Commodity", options: [["MAIZE", "Maize"], ["SOYBEAN", "Soybean"], ["SORGHUM", "Sorghum"], ["RICE_PADDY", "Paddy rice"], ["COCOA", "Cocoa"], ["CASHEW", "Cashew"], ["SESAME", "Sesame"], ["GROUNDNUT", "Groundnut"]] },
    { key: "grade", label: "Grade", options: [["GRADE_1", "Grade 1"], ["GRADE_2", "Grade 2"], ["GRADE_3", "Grade 3"]] },
    { key: "quantity", label: "Quantity", type: "number" },
    { key: "unit", label: "Unit", options: [["kg", "Kilograms"], ["tonne", "Tonnes"], ["bag", "Bags"]] },
    { key: "depositDate", label: "Deposit date", type: "date" },
    { key: "expiryDate", label: "Storage ends", type: "date" },
    { key: "notes", label: "Notes for the reviewer", optional: true, long: true },
  ],
  lpo: [
    { key: "lpoNumber", label: "LPO number", fixedOnCorrection: true },
    { key: "buyerName", label: "Buyer", hint: "Shown to investors." },
    { key: "buyerRegistrationNumber", label: "Buyer's CAC number", hint: "Kept private. Used to prevent duplicates.", fixedOnCorrection: true },
    { key: "description", label: "What's being supplied", hint: "Short code, e.g. MAIZE_50T" },
    { key: "faceValue", label: "Amount the buyer will pay (USDC)", decimal: true },
    { key: "issueDate", label: "Order date", type: "date" },
    { key: "dueDate", label: "Payment due", type: "date" },
    { key: "notes", label: "Notes for the reviewer", optional: true, long: true },
  ],
  carbon: [
    { key: "registry", label: "Registry", options: [["VERRA", "Verra"], ["GOLD_STANDARD", "Gold Standard"], ["PURO_EARTH", "Puro.earth"], ["ISOMETRIC", "Isometric"], ["OTHER", "Other"]] },
    { key: "registryBatchId", label: "Registry batch / serial range", fixedOnCorrection: true },
    { key: "projectId", label: "Registry project ID" },
    { key: "projectName", label: "Project name" },
    { key: "methodology", label: "Methodology", hint: "e.g. VM0042" },
    { key: "vintage", label: "Vintage year", type: "number" },
    { key: "quantity", label: "Tonnes CO₂e", type: "number" },
    { key: "country", label: "Country", optional: true },
    { key: "notes", label: "Notes for the reviewer", optional: true, long: true },
  ],
};
