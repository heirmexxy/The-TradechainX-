import Link from "next/link";
import { fromBytes32Code, humanizeCode, VAULT_STATE_LABEL } from "@tradechainx/shared";
import type { OfferingView } from "@/lib/types";
import { date, num, usdc } from "@/lib/format";
import { Pill } from "./ui";

export function OfferingCard({ o }: { o: OfferingView }) {
  const sold = Number(o.sharesSold);
  const max = Number(o.maxShares);
  const pct = max ? Math.round((sold / max) * 100) : 0;
  return (
    <Link href={`/xown/${o.vault}`} className="certificate block p-6 hover:border-ink-500">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-medium text-ink-500">{humanizeCode(fromBytes32Code(o.equipment.assetType ?? ""))}</p>
          <h3 className="mt-1 text-h3">{o.name}</h3>
          {o.details.location && <p className="text-sm text-slate-500">{String(o.details.location)}</p>}
        </div>
        <Pill tone={o.vaultState === 1 ? "good" : o.vaultState === 2 ? "bad" : "warn"}>{VAULT_STATE_LABEL[o.vaultState ?? 0]}</Pill>
      </div>
      <div className="mt-5">
        <div className="h-2 overflow-hidden rounded-full bg-ink-50" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Funded">
          <div className="h-full bg-maize" style={{ width: `${pct}%` }} />
        </div>
        <p className="mt-2 text-sm text-slate">
          {num(sold)} of {num(max)} shares sold · {usdc(o.pricePerShare)} each
        </p>
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
        <div>
          <dt className="text-xs text-slate-500">Open until</dt>
          <dd className="font-medium text-ink-900">{date(o.deadline)}</dd>
        </div>
        <div>
          <dt className="text-xs text-slate-500">Earnings paid so far</dt>
          <dd className="font-medium text-ink-900">{usdc(o.totalYield)}</dd>
        </div>
      </dl>
    </Link>
  );
}
