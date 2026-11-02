"use client";

import Link from "next/link";
import { use } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { SubmissionStatus } from "@tradechainx/shared";
import { api, type UploadedDocument } from "@/lib/api";
import { IssueForm, type IssueType } from "@/components/IssueForm";
import { Notice, PageHeader, Spinner } from "@/components/ui";

type DraftDetail = {
  draft: { id: string; assetType: IssueType; fields: Record<string, unknown> };
  submission: { status: number } | null;
  documents: UploadedDocument[];
};

/** Correct a submission the reviewer sent back with "Needs info". */
export default function CorrectDraft({ params }: { params: Promise<{ draftId: string }> }) {
  const { draftId } = use(params);
  const router = useRouter();
  const { data, isLoading } = useQuery({ queryKey: ["draft", draftId], queryFn: () => api<DraftDetail>(`/drafts/${draftId}`) });
  if (isLoading || !data) return <Spinner />;

  if (data.submission?.status !== SubmissionStatus.NeedsInfo) {
    return (
      <>
        <PageHeader title="Update submission" />
        <Notice title="This submission can't be changed right now">
          Only submissions our reviewers sent back can be updated. <Link href="/app/issue" className="underline">Back to your submissions</Link>
        </Notice>
      </>
    );
  }

  const fields = Object.fromEntries(Object.entries(data.draft.fields).map(([k, v]) => [k, v == null ? "" : String(v)]));
  return (
    <>
      <PageHeader title="Update submission" intro="Our reviewer asked for more information. Correct the details or add documents, then send it back. The reference number stays the same." />
      <IssueForm type={data.draft.assetType} correction={{ draftId, fields, documents: data.documents }} onSubmitted={() => router.push("/app/issue")} />
    </>
  );
}
