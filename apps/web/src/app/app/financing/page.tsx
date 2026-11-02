"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { calls } from "@/lib/calls";
import type { AssetView } from "@/lib/types";
import { addr, date, relative } from "@/lib/format";
import { TxButton } from "@/components/TxButton";
import { Empty, PageHeader, Spinner } from "@/components/ui";

export default function FinancingPage() {
  const { data, isLoading, refetch } = useQuery({ queryKey: ["portfolio"], queryFn: () => api<{ financing: AssetView[] }>("/portfolio") });
  if (isLoading || !data) return <Spinner />;
  const refresh = () => setTimeout(() => void refetch(), 2500);

  return (
    <>
      <PageHeader
        title="Financing"
        intro="Assets pledged to you. A pledged asset can't be sold or moved until you release it. If a loan isn't repaid by maturity, you can take ownership."
      />
      {data.financing.length === 0 ? (
        <Empty title="No pledges yet">When a borrower pledges a receipt or LPO to you, it appears here.</Empty>
      ) : (
        <div className="overflow-x-auto rounded border border-line bg-white">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-line text-xs text-slate-500">
              <tr>
                <th className="px-4 py-3 font-medium">Asset</th>
                <th className="px-4 py-3 font-medium">Borrower</th>
                <th className="px-4 py-3 font-medium">Matures</th>
                <th className="px-4 py-3 font-medium" />
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {data.financing.map((a) => {
                const matured = (a.lien?.maturity ?? 0) * 1000 <= Date.now();
                const type = a.assetType as "warehouse-receipt" | "lpo";
                return (
                  <tr key={`${a.assetType}-${a.tokenId}`}>
                    <td className="px-4 py-3">
                      <Link href={`/assets/${a.assetType}/${a.tokenId}`} className="font-medium text-ink-900 hover:underline">{a.title}</Link>
                    </td>
                    <td className="px-4 py-3">{addr(a.owner)}</td>
                    <td className="px-4 py-3">
                      {date(a.lien?.maturity)} <span className="text-slate-500">({relative(a.lien?.maturity ?? 0)})</span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-2">
                        <TxButton variant="secondary" title="Release the pledge" label="Release" doneText="Released." calls={[calls.releaseLien(type, BigInt(a.tokenId))]} onDone={refresh} />
                        {matured && (
                          <TxButton variant="danger" title="Take ownership under the pledge" label="Take ownership" doneText="The asset is now yours." calls={[calls.enforceLien(type, BigInt(a.tokenId))]} onDone={refresh} />
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
