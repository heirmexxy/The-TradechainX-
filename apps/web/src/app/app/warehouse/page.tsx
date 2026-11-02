"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { calls } from "@/lib/calls";
import type { AssetView } from "@/lib/types";
import { num } from "@/lib/format";
import { TxButton } from "@/components/TxButton";
import { StatusPill } from "@/components/Certificate";
import { Empty, LinkButton, PageHeader, Panel, Spinner } from "@/components/ui";

type Queue = {
  warehouses: { id: string; active: boolean }[];
  releasesToConfirm: AssetView[];
  receipts: AssetView[];
};

export default function WarehousePage() {
  const { data, isLoading, refetch } = useQuery({ queryKey: ["issuerQueue"], queryFn: () => api<Queue>("/issuer/queue") });
  if (isLoading || !data) return <Spinner />;
  const refresh = () => setTimeout(() => void refetch(), 2500);

  if (data.warehouses.length === 0) {
    return (
      <>
        <PageHeader title="My warehouse" />
        <Empty title="Your warehouse isn't registered yet">
          Our team registers each facility after checking its licence. Once that's done you can issue receipts here.
        </Empty>
      </>
    );
  }

  return (
    <>
      <PageHeader title="My warehouse" actions={<LinkButton href="/app/issue">Issue a receipt</LinkButton>} />

      <Panel title="Collections to confirm">
        {data.releasesToConfirm.length === 0 ? (
          <p className="text-sm text-slate-500">No one is waiting to collect goods.</p>
        ) : (
          <ul className="divide-y divide-line">
            {data.releasesToConfirm.map((a) => (
              <li key={a.tokenId} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div>
                  <Link href={`/assets/warehouse-receipt/${a.tokenId}`} className="font-medium text-ink-900 hover:underline">
                    No. {a.tokenId} · {a.title}
                  </Link>
                  <p className="text-sm text-slate">
                    {a.pendingRequest?.kind === 1 ? "Collecting everything" : `Collecting part — ${num(a.pendingRequest?.newQuantity)} stays on the receipt`}
                  </p>
                </div>
                <TxButton title="Confirm release" label="Confirm released" doneText="Confirmed." calls={[calls.confirmRelease(BigInt(a.tokenId))]} onDone={refresh} />
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <div className="mt-8">
        <Panel title="Receipts issued at your warehouse">
          {data.receipts.length === 0 ? (
            <p className="text-sm text-slate-500">None yet.</p>
          ) : (
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-slate-500">
                <tr>
                  <th className="py-2 font-medium">Receipt</th>
                  <th className="py-2 font-medium">Goods</th>
                  <th className="py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {data.receipts.map((a) => (
                  <tr key={a.tokenId}>
                    <td className="py-2">
                      <Link href={`/assets/warehouse-receipt/${a.tokenId}`} className="underline">No. {a.tokenId}</Link>
                    </td>
                    <td className="py-2">{a.title}</td>
                    <td className="py-2"><StatusPill status={a.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      </div>
    </>
  );
}
