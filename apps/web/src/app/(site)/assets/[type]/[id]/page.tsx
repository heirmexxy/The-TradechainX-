"use client";

import Link from "next/link";
import { use } from "react";
import { useQuery } from "@tanstack/react-query";
import { ASSET_TYPE_LABEL } from "@tradechainx/shared";
import { api } from "@/lib/api";
import type { AssetView, HistoryItem, ListingView } from "@/lib/types";
import { addr, date, num, usdc } from "@/lib/format";
import { Certificate } from "@/components/Certificate";
import { AssetActions } from "@/components/AssetActions";
import { Facts, Notice, Panel, Spinner } from "@/components/ui";

type Detail = {
  asset: AssetView;
  documentHash: string;
  warehouse: { id: string; active: boolean; operator?: string; name?: string; state?: string } | null;
  listings: ListingView[];
  retirements: { retirementId: string; holder: string; amount: string; blockTime: string }[];
  history: HistoryItem[];
};

// Plain-language names for the audit trail.
const EVENT_LABEL: Record<string, string> = {
  ReceiptIssued: "Issued",
  LPOIssued: "Issued",
  BatchIssued: "Issued",
  Transfer: "Changed hands",
  TransferSingle: "Credits moved",
  LienGranted: "Pledged",
  LienReleased: "Pledge released",
  LienEnforced: "Taken by lender",
  StatusChangeRequested: "Change requested",
  WarehouseReleaseConfirmed: "Warehouse confirmed release",
  StatusChangeCancelled: "Request cancelled",
  StatusChangeRejected: "Request declined",
  ReceiptRedeemed: "Goods collected — closed",
  ReceiptPartiallyRedeemed: "Part of the goods collected",
  ReceiptVoided: "Voided",
  ReceiptExpiryExtended: "Storage term extended",
  LPOSettled: "Paid — closed",
  LPOSettledOffChain: "Paid outside the platform — closed",
  LPOCancelled: "Order cancelled",
  LPODueDateExtended: "Due date extended",
  CreditsRetired: "Credits retired",
  BatchSuspended: "Suspension changed",
  Approval: "Permission given to marketplace",
  ApprovalForAll: "Permission given to marketplace",
};

export default function AssetPage({ params }: { params: Promise<{ type: string; id: string }> }) {
  const { type, id } = use(params);
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["asset", type, id],
    queryFn: () => api<Detail>(`/assets/${type}/${id}`),
  });

  if (isLoading) return <div className="mx-auto max-w-5xl px-4 py-12"><Spinner /></div>;
  if (error || !data) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-12">
        <Notice tone="bad" title="We couldn't find that asset">
          <Link href="/marketplace" className="underline">Browse the marketplace</Link>
        </Notice>
      </div>
    );
  }
  const a = data.asset;
  const history = data.history.filter((h) => !["Approval", "ApprovalForAll"].includes(h.event));

  return (
    <div className="mx-auto grid max-w-5xl gap-8 px-4 py-12 sm:px-6 md:grid-cols-[1fr_1fr]">
      <div className="space-y-6">
        <p className="text-sm text-slate-500">{ASSET_TYPE_LABEL[a.assetType]}</p>
        <Certificate asset={a} />

        {data.listings.length > 0 && (
          <Notice tone="warn" title="For sale">
            {data.listings.map((l) => (
              <Link key={l.listingId} href={`/marketplace/${l.listingId}`} className="block underline">
                {usdc(l.pricePerUnit)}
                {a.assetType === "carbon" ? ` per tonne, ${num(l.remaining)} t available` : ""}
              </Link>
            ))}
          </Notice>
        )}

        <Panel title="Who's involved">
          <Facts
            items={[
              ...(data.warehouse ? ([["Warehouse", `${data.warehouse.name ?? `No. ${data.warehouse.id}`}${data.warehouse.state ? `, ${data.warehouse.state}` : ""}${data.warehouse.active ? "" : " (suspended)"}`]] as [string, string][]) : []),
              [a.assetType === "carbon" ? "Originator" : "Issued by", addr(a.originator)],
              ...(a.owner ? ([["Current holder", addr(a.owner)]] as [string, string][]) : []),
              ...(a.lien ? ([["Pledged to", `${addr(a.lien.lienholder)} until ${date(a.lien.maturity)}`]] as [string, string][]) : []),
            ]}
          />
        </Panel>

        <Panel title="Documents">
          <p className="text-sm text-slate">
            The supporting documents were reviewed by our compliance team and are stored privately. Their fingerprint is recorded with this asset — anyone given the files can check they're exactly the ones reviewed.
          </p>
          <p className="mt-3 break-all rounded bg-ink-50 px-3 py-2 text-xs text-ink-700">{data.documentHash}</p>
        </Panel>
      </div>

      <div className="space-y-6">
        <AssetActions asset={a} warehouse={data.warehouse} onChanged={() => setTimeout(() => void refetch(), 2500)} />

        {data.retirements.length > 0 && (
          <Panel title="Retirements">
            <ul className="divide-y divide-line text-sm">
              {data.retirements.map((r) => (
                <li key={r.retirementId} className="flex justify-between py-2">
                  <span>{addr(r.holder)}</span>
                  <span className="font-medium text-ink-900">{num(r.amount)} t · {date(r.blockTime)}</span>
                </li>
              ))}
            </ul>
          </Panel>
        )}

        <Panel title="History">
          {history.length === 0 ? (
            <p className="text-sm text-slate-500">No activity yet.</p>
          ) : (
            <ol className="relative space-y-4 border-l border-line pl-5">
              {history.map((h, i) => (
                <li key={`${h.txHash}-${i}`}>
                  <span className="absolute -left-[5px] mt-1.5 h-2.5 w-2.5 rounded-full bg-ink" aria-hidden />
                  <p className="text-sm font-medium text-ink-900">{EVENT_LABEL[h.event] ?? h.event}</p>
                  <p className="text-xs text-slate-500">
                    {date(h.blockTime)}
                    {h.explorerUrl && (
                      <>
                        {" · "}
                        <a href={h.explorerUrl} target="_blank" rel="noreferrer" className="underline">
                          public record
                        </a>
                      </>
                    )}
                  </p>
                </li>
              ))}
            </ol>
          )}
        </Panel>
      </div>
    </div>
  );
}
