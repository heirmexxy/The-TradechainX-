"use client";

import Link from "next/link";
import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { USER_TYPE_LABEL, type UserType } from "@tradechainx/shared";
import { api } from "@/lib/api";
import { date } from "@/lib/format";
import { Empty, PageHeader, Spinner } from "@/components/ui";

const TABS = [
  ["pending", "Waiting"],
  ["needs_info", "Asked for more"],
  ["approved", "Approved, not recorded"],
  ["verified", "Verified"],
  ["rejected", "Declined"],
] as const;

type Row = { id: string; status: string; track: string; submittedAt: string; applicant: { email: string; userType: UserType | null; name?: string } };

export default function KycQueuePage() {
  return (
    <Suspense>
      <KycQueue />
    </Suspense>
  );
}

function KycQueue() {
  const status = useSearchParams()?.get("status") ?? "pending";
  const { data, isLoading } = useQuery({ queryKey: ["adminKyc", status], queryFn: () => api<{ cases: Row[] }>(`/admin/kyc?status=${status}`) });
  return (
    <>
      <PageHeader title="Verification" intro="Check each applicant's details against their documents. Approving records their verification on-chain, which you'll confirm in the next step." />
      <nav className="mb-6 flex flex-wrap gap-2" aria-label="Status">
        {TABS.map(([k, l]) => (
          <Link key={k} href={`/admin/kyc?status=${k}`} className={`rounded-full border px-4 py-1.5 text-sm ${status === k ? "border-ink bg-ink text-white" : "border-line bg-white"}`}>
            {l}
          </Link>
        ))}
      </nav>
      {isLoading && <Spinner />}
      {data?.cases.length === 0 && <Empty title="Nothing here" />}
      {!!data?.cases.length && (
        <div className="overflow-x-auto rounded border border-line bg-white">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-line text-xs text-slate-500">
              <tr>
                <th className="px-4 py-3 font-medium">Applicant</th>
                <th className="px-4 py-3 font-medium">Type</th>
                <th className="px-4 py-3 font-medium">Submitted</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {data.cases.map((c) => (
                <tr key={c.id} className="hover:bg-ink-50">
                  <td className="px-4 py-3">
                    <Link href={`/admin/kyc/${c.id}`} className="font-medium text-ink-900 underline">{c.applicant.name ?? c.applicant.email}</Link>
                    <p className="text-xs text-slate-500">{c.applicant.email}</p>
                  </td>
                  <td className="px-4 py-3">{c.applicant.userType ? USER_TYPE_LABEL[c.applicant.userType] : "—"}</td>
                  <td className="px-4 py-3">{date(c.submittedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
