"use client";

import { useState } from "react";
import { uploadDocument, type UploadedDocument } from "@/lib/api";
import { Button, Select } from "./ui";

/**
 * Upload supporting documents. Each file's SHA-256 is computed by the API and becomes part of the
 * fingerprint anchored on-chain, so the exact files can be proven later.
 */
export function DocumentUpload({
  kinds,
  value,
  onChange,
}: {
  kinds: { key: string; label: string }[];
  value: UploadedDocument[];
  onChange: (docs: UploadedDocument[]) => void;
}) {
  const [kind, setKind] = useState(kinds[0]?.key ?? "other");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onFile(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const doc = await uploadDocument(file, kind);
      onChange([...value, doc]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed.");
    } finally {
      setBusy(false);
    }
  }

  const missing = kinds.filter((k) => !value.some((d) => d.kind === k.key));
  return (
    <div className="rounded border border-line bg-white p-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="min-w-48 flex-1">
          <span className="field-label">Document</span>
          <Select value={kind} onChange={(e) => setKind(e.target.value)}>
            {kinds.map((k) => (
              <option key={k.key} value={k.key}>
                {k.label}
              </option>
            ))}
          </Select>
        </label>
        <label className={`inline-flex cursor-pointer ${busy ? "pointer-events-none opacity-60" : ""}`}>
          <input type="file" accept="application/pdf,image/jpeg,image/png" className="sr-only" onChange={(e) => onFile(e.target.files?.[0])} disabled={busy} />
          <span className="inline-flex items-center rounded border border-ink-100 bg-white px-4 py-2.5 text-sm font-semibold text-ink-900 hover:border-ink-500">
            {busy ? "Uploading…" : "Choose file"}
          </span>
        </label>
      </div>
      <p className="mt-2 text-xs text-slate-500">PDF, JPG or PNG, up to 15 MB.</p>
      {error && <p className="mt-2 text-sm text-danger">{error}</p>}

      {value.length > 0 && (
        <ul className="mt-4 divide-y divide-line border-t border-line text-sm">
          {value.map((d) => (
            <li key={d.id} className="flex items-center justify-between gap-3 py-2">
              <span>
                <span className="font-medium text-ink-900">{kinds.find((k) => k.key === d.kind)?.label ?? d.kind}</span>
                <span className="ml-2 text-slate-500">{d.filename}</span>
              </span>
              <Button type="button" variant="quiet" onClick={() => onChange(value.filter((x) => x.id !== d.id))}>
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
      {missing.length > 0 && kinds.length > 1 && (
        <p className="mt-3 text-sm text-slate-500">Still needed: {missing.map((m) => m.label).join(", ")}.</p>
      )}
    </div>
  );
}
