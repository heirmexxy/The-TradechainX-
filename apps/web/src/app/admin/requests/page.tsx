"use client";

import Link from "next/link";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { LPO_REQUEST_LABEL, RECEIPT_REQUEST_LABEL } from "@tradechainx/shared";
import { api } from "@/lib/api";
import { fromApi } from "@/lib/calls";
import { withReason } from "@/lib/admin";
import type { AssetView, PreparedCallJson } from "@/lib/types";
import { addr, date, num } from "@/lib/format";
import { TxButton } from "@/components/TxButton";
import { Empty, Input, PageHeader, Spinner } from "@/components/ui";

type Req = { asset: AssetView; request: NonNullable<AssetView["pendingRequest"]>; calls: { approve: PreparedCallJson; reject: PreparedCallJson } };

export default function StatusRequestsPage() {
  const { data, isLoading, refetch } = useQuery({ queryKey: ["adminRequests"], queryFn: () => api<{ requests: Req[] }>("/admin/status-requests"), refetchInterval: 15_000 });
  return (
    <>
      <PageHeader title="Status changes" intro="Collections, payments reported outside the platform, voids, cancellations and extensions. Each change needs your approval before it takes effect." />
      {isLoading && <Spinner />}
      {data?.requests.length === 0 && <Empty title="No changes waiting" />}
      <ul className="space-y-4">
        {data?.requests.map((r) => <RequestRow key={`${r.asset.assetType}-${r.asset.tokenId}`} r={r} onDone={() => setTimeout(() => void refetch(), 3000)} />)}
      </ul>
    </>
  );
}

function RequestRow({ r, onDone }: { r: Req; onDone: () => void }) {
  const [note, setNote] = useState("");
  const receipt = r.asset.assetType === "warehouse-receipt";
  const label = receipt ? RECEIPT_REQUEST_LABEL[r.request.kind] : LPO_REQUEST_LABEL[r.request.kind];
  const needsWarehouse = receipt && [1, 2].includes(r.request.kind) && !r.request.warehouseConfirmed;
  const detail =
    r.request.kind === 2 && receipt
      ? `${num(r.request.newQuantity)} stays on the receipt`
      : r.request.newExpiry && r.request.newExpiry !== "0"
        ? `New end: ${date(Number(r.request.newExpiry))}`
        : r.request.newDueDate && r.request.newDueDate !== "0"
          ? `New due date: ${date(Number(r.request.newDueDate))}`
          : null;

  return (
    <li className="rounded border border-line bg-white p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs text-ink-500">{label}</p>
          <Link href={`/assets/${r.asset.assetType}/${r.asset.tokenId}`} className="font-semibold text-ink-900 underline">{r.asset.title}</Link>
          <p className="text-sm text-slate">Requested by {addr(r.request.requester)}{detail ? ` · ${detail}` : ""}</p>
          {needsWarehouse && <p className="mt-1 text-sm text-maize-700">Waiting for the warehouse to confirm release.</p>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <TxButton title="Approve the change" label="Approve" doneText="Approved." disabled={needsWarehouse} calls={[fromApi(r.calls.approve)]} onDone={onDone} />
        </div>
      </div>
      <div className="mt-4 flex flex-wrap items-end gap-2 border-t border-line pt-4">
        <Input placeholder="Reason for declining" value={note} onChange={(e) => setNote(e.target.value)} className="max-w-sm" />
        <TxButton
          variant="danger"
          title="Decline the change"
          label="Decline"
          doneText="Declined."
          disabled={!note}
          calls={() => [withReason(r.calls.reject, note)]}
          onDone={async () => {
            await api("/admin/review-notes", { body: { entityType: r.asset.assetType, entityId: r.asset.tokenId, note } });
            onDone();
          }}
        />
      </div>
    </li>
  );
}
