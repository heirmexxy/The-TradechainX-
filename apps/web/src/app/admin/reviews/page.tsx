"use client";

import Link from "next/link";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ASSET_TYPE_LABEL, type AssetType } from "@tradechainx/shared";
import { api } from "@/lib/api";
import { addr } from "@/lib/format";
import { Empty, PageHeader, Spinner } from "@/components/ui";

type Row = {
  assetType: AssetType;
  submissionId: string;
  submitter: string;
  fields: Record<string, string> | null;
  submittedBy: { email: string; orgName: string | null } | null;
};

const TYPES = [
  ["", "All"],
  ["warehouse-receipt", "Warehouse receipts"],
  ["lpo", "LPOs"],
  ["carbon", "Carbon"],
] as const;

export default function ReviewsPage() {
  const [type, setType] = useState("");
  const { data, isLoading } = useQuery({
    queryKey: ["adminSubmissions", type],
    queryFn: () => api<{ submissions: Row[] }>(`/admin/submissions${type ? `?type=${type}` : ""}`),
    refetchInterval: 15_000,
  });
  return (
    <>
      <PageHeader title="Listing reviews" intro="Nothing is issued until you approve it. You can't review anything you submitted, hold or operate — the contracts refuse it." />
      <div className="mb-6 flex flex-wrap gap-2">
        {TYPES.map(([k, l]) => (
          <button key={k} onClick={() => setType(k)} className={`rounded-full border px-4 py-1.5 text-sm ${type === k ? "border-ink bg-ink text-white" : "border-line bg-white"}`}>
            {l}
          </button>
        ))}
      </div>
      {isLoading && <Spinner />}
      {data?.submissions.length === 0 && <Empty title="Nothing waiting for review" />}
      <ul className="space-y-3">
        {data?.submissions.map((s) => (
          <li key={`${s.assetType}-${s.submissionId}`}>
            <Link href={`/admin/reviews/${s.assetType}/${s.submissionId}`} className="block rounded border border-line bg-white p-4 hover:border-ink-500">
              <p className="text-xs text-ink-500">{ASSET_TYPE_LABEL[s.assetType]} · submission {s.submissionId}</p>
              <p className="mt-1 font-semibold text-ink-900">
                {s.fields?.receiptNumber ?? s.fields?.lpoNumber ?? s.fields?.projectName ?? "Details not found"}
              </p>
              <p className="text-sm text-slate">From {s.submittedBy?.orgName ?? s.submittedBy?.email ?? addr(s.submitter)}</p>
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}
