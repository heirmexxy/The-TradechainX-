"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { can, SUBMISSION_STATUS_LABEL, SubmissionStatus, ASSET_TYPE_LABEL, type AssetType } from "@tradechainx/shared";
import { api } from "@/lib/api";
import { date } from "@/lib/format";
import { useSession } from "@/lib/session";
import { Empty, Notice, PageHeader, Panel, Pill, Spinner } from "@/components/ui";
import { IssueForm, type IssueType } from "@/components/IssueForm";

type Draft = {
  id: string;
  assetType: AssetType;
  fields: Record<string, string>;
  createdAt: string;
  submission: { status: number; tokenId: string | null; submissionId: string } | null;
  txHash: string | null;
  reviewerNote: string | null;
};

export default function IssuePage() {
  const { data: user } = useSession();
  const { data: drafts, refetch } = useQuery({ queryKey: ["drafts"], queryFn: () => api<{ drafts: Draft[] }>("/drafts/mine") });
  if (!user?.userType) return <Spinner />;

  const types: IssueType[] = [];
  if (can(user.userType, "issue_receipts")) types.push("warehouse-receipt");
  if (can(user.userType, "issue_lpos")) types.push("lpo");
  if (can(user.userType, "issue_carbon")) types.push("carbon");

  if (!user.identity?.active) {
    return (
      <>
        <PageHeader title="Issue an asset" />
        <Notice tone="warn" title="Verification comes first">
          <Link href="/app/onboarding" className="underline">Finish verifying your business</Link> to issue assets.
        </Notice>
      </>
    );
  }
  if (types.length === 0) return <Empty title="Your account type doesn't issue assets" />;

  return (
    <>
      <PageHeader
        title="Issue an asset"
        intro="Submit the details and supporting documents. Our review team checks them, and the digital asset is created only once they approve."
      />
      <div className="space-y-10">
        {types.map((t) => (
          <IssueForm key={t} type={t} onSubmitted={() => void refetch()} />
        ))}
        <Panel title="Your submissions">
          {!drafts?.drafts.length ? (
            <p className="text-sm text-slate-500">Nothing submitted yet.</p>
          ) : (
            <ul className="divide-y divide-line">
              {drafts.drafts.filter((d) => d.assetType !== "warehouse" as never).map((d) => (
                <li key={d.id} className="py-3 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                  <span>
                    <span className="font-medium text-ink-900">{ASSET_TYPE_LABEL[d.assetType]}</span>
                    <span className="ml-2 text-slate">{d.fields.receiptNumber ?? d.fields.lpoNumber ?? d.fields.registryBatchId}</span>
                    <span className="ml-2 text-slate-500">{date(d.createdAt)}</span>
                  </span>
                  <span className="flex items-center gap-3">
                    <DraftStatus d={d} />
                    {d.submission?.status === SubmissionStatus.NeedsInfo && (
                      <Link className="underline" href={`/app/issue/${d.id}`}>Update</Link>
                    )}
                    {d.submission?.tokenId && (
                      <Link className="underline" href={`/assets/${d.assetType}/${d.submission.tokenId}`}>View asset</Link>
                    )}
                  </span>
                  </div>
                  {d.reviewerNote && d.submission && [SubmissionStatus.NeedsInfo, SubmissionStatus.Rejected].includes(d.submission.status as 2 | 4) && (
                    <p className="mt-2 rounded bg-maize-100 px-3 py-2 text-ink-900">Reviewer: {d.reviewerNote}</p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </>
  );
}

function DraftStatus({ d }: { d: Draft }) {
  if (!d.submission) return <Pill tone="neutral">{d.txHash ? "Confirming…" : "Not sent"}</Pill>;
  const s = d.submission.status;
  const tone = s === SubmissionStatus.Approved ? "good" : s === SubmissionStatus.NeedsInfo ? "warn" : s === SubmissionStatus.Rejected ? "bad" : "neutral";
  return <Pill tone={tone}>{SUBMISSION_STATUS_LABEL[s]}</Pill>;
}

