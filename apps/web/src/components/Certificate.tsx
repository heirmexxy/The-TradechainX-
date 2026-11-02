import Link from "next/link";
import type { ReactNode } from "react";
import { ASSET_STATUS_LABEL, ASSET_TYPE_LABEL, fromBytes32Code, humanizeCode, type AssetStatus } from "@tradechainx/shared";
import type { AssetView } from "@/lib/types";
import { date, num, usdc } from "@/lib/format";
import { Pill, type Tone } from "./ui";

const STATUS_TONE: Record<AssetStatus, Tone> = {
  active: "good",
  listed: "warn",
  pledged: "neutral",
  pending_change: "warn",
  expired: "bad",
  suspended: "bad",
  redeemed: "neutral",
  settled: "neutral",
  voided: "bad",
  cancelled: "bad",
};

export function StatusPill({ status }: { status: AssetStatus }) {
  return <Pill tone={STATUS_TONE[status]}>{ASSET_STATUS_LABEL[status]}</Pill>;
}

/** The key facts for each asset type, in the order a buyer or lender would read them. */
export function assetFacts(a: AssetView): [string, string][] {
  const t = a.terms;
  const d = a.details;
  switch (a.assetType) {
    case "warehouse-receipt":
      return [
        ["Commodity", `${humanizeCode(fromBytes32Code(t.commodity ?? ""))}, ${humanizeCode(fromBytes32Code(t.grade ?? ""))}`],
        ["Quantity", `${num(t.quantity)} ${d.unit ?? "kg"}`],
        ["Deposited", date(Number(t.depositDate))],
        ["Storage ends", date(Number(t.expiryDate))],
      ];
    case "lpo":
      return [
        ["Buyer", String(d.buyerName ?? "Verified buyer")],
        ["Face value", usdc(t.faceValue)],
        ["Issued", date(Number(t.issueDate))],
        ["Payment due", date(Number(t.dueDate))],
      ];
    case "carbon":
      return [
        ["Registry", humanizeCode(fromBytes32Code(t.registry ?? ""))],
        ["Vintage", String(t.vintage)],
        ["Methodology", fromBytes32Code(t.methodology ?? "")],
        ["Retired so far", `${num(a.retired)} of ${num(t.quantity)} t`],
      ];
  }
}

/**
 * An asset rendered as the document it represents: a stamped certificate whose perforated foot
 * carries the hash of its supporting documents.
 */
export function Certificate({ asset, footer, compact }: { asset: AssetView; footer?: ReactNode; compact?: boolean }) {
  const docHash = asset.terms.documentHash ?? "";
  return (
    <article className="certificate flex flex-col">
      <div className="flex items-start justify-between gap-3 px-5 pt-5">
        <div>
          <p className="text-xs font-medium text-ink-500">
            {ASSET_TYPE_LABEL[asset.assetType]} <span className="text-slate-300">/</span> No. {asset.tokenId}
          </p>
          <h3 className="mt-1 text-h3">
            <Link href={`/assets/${asset.assetType}/${asset.tokenId}`} className="hover:underline">
              {asset.title}
            </Link>
          </h3>
        </div>
        <StatusPill status={asset.status} />
      </div>
      {!compact && (
        <div className="px-5 py-4">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
            {assetFacts(asset).map(([k, v]) => (
              <div key={k}>
                <dt className="text-xs text-slate-500">{k}</dt>
                <dd className="font-medium text-ink-900">{v}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
      {footer && <div className="px-5 pb-4">{footer}</div>}
      <div className="perforation mt-auto h-3" aria-hidden />
      <p className="truncate border-t border-dashed border-ink-100 px-5 py-2 text-[11px] text-slate-500" title={docHash}>
        Documents fingerprint {docHash.slice(0, 18)}…{docHash.slice(-6)}
      </p>
    </article>
  );
}
