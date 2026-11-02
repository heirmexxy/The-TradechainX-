"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import type { Address } from "viem";
import { api } from "@/lib/api";
import { calls } from "@/lib/calls";
import type { AssetView, ListingView, OfferingView } from "@/lib/types";
import { date, num, usdc } from "@/lib/format";
import { Certificate } from "@/components/Certificate";
import { TxButton } from "@/components/TxButton";
import { Empty, LinkButton, PageHeader, Panel, Spinner } from "@/components/ui";

type Portfolio = {
  usdcBalance: string;
  assets: AssetView[];
  listings: (ListingView & { asset: AssetView })[];
  financing: AssetView[];
  carbon: { amount: string; asset: AssetView }[];
  xown: { vault: string; shares: string; claimableYield: string; offering: OfferingView }[];
  retirements: { retirementId: string; batchId: string; amount: string; blockTime: string }[];
};

export default function PortfolioPage() {
  const { data, isLoading, refetch } = useQuery({ queryKey: ["portfolio"], queryFn: () => api<Portfolio>("/portfolio") });
  if (isLoading || !data) return <Spinner />;
  const refresh = () => setTimeout(() => void refetch(), 2500);
  const nothing = !data.assets.length && !data.listings.length && !data.carbon.length && !data.xown.length;

  return (
    <>
      <PageHeader title="Portfolio" intro={`Balance: ${usdc(data.usdcBalance)}`} actions={<LinkButton href="/marketplace" variant="secondary">Browse the marketplace</LinkButton>} />

      {nothing && (
        <Empty title="Nothing here yet" action={<LinkButton href="/marketplace">Browse the marketplace</LinkButton>}>
          Assets you buy, receive from a warehouse, or issue will appear here.
        </Empty>
      )}

      {data.assets.length > 0 && (
        <section className="mb-10">
          <h2 className="mb-4 text-h2">Receipts and purchase orders</h2>
          <div className="grid gap-6 sm:grid-cols-2">
            {data.assets.map((a) => (
              <Certificate
                key={`${a.assetType}-${a.tokenId}`}
                asset={a}
                footer={<LinkButton href={`/assets/${a.assetType}/${a.tokenId}`} variant="secondary">Sell, pledge or manage</LinkButton>}
              />
            ))}
          </div>
        </section>
      )}

      {data.listings.length > 0 && (
        <section className="mb-10">
          <h2 className="mb-4 text-h2">For sale</h2>
          <div className="space-y-3">
            {data.listings.map((l) => (
              <div key={l.listingId} className="flex flex-wrap items-center justify-between gap-4 rounded border border-line bg-white p-4">
                <div>
                  <Link href={`/marketplace/${l.listingId}`} className="font-semibold text-ink-900 hover:underline">{l.asset.title}</Link>
                  <p className="text-sm text-slate">
                    {usdc(l.pricePerUnit)}{l.assetType === "carbon" ? ` per tonne · ${num(l.remaining)} t left` : ""}
                  </p>
                </div>
                <TxButton variant="secondary" title="Take off the market" label="Cancel listing" doneText="Cancelled." calls={[calls.cancelListing(BigInt(l.listingId))]} onDone={refresh} />
              </div>
            ))}
          </div>
        </section>
      )}

      {data.carbon.length > 0 && (
        <section className="mb-10">
          <h2 className="mb-4 text-h2">Carbon credits</h2>
          <div className="grid gap-6 sm:grid-cols-2">
            {data.carbon.map((c) => (
              <Certificate
                key={c.asset.tokenId}
                asset={c.asset}
                footer={
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-ink-900">You hold {num(c.amount)} t</span>
                    <LinkButton href={`/assets/carbon/${c.asset.tokenId}`} variant="secondary">Sell or retire</LinkButton>
                  </div>
                }
              />
            ))}
          </div>
        </section>
      )}

      {data.xown.length > 0 && (
        <section className="mb-10">
          <h2 className="mb-4 text-h2">XOwn shares</h2>
          <div className="space-y-3">
            {data.xown.map((x) => (
              <div key={x.vault} className="flex flex-wrap items-center justify-between gap-4 rounded border border-line bg-white p-4">
                <div>
                  <Link href={`/xown/${x.vault}`} className="font-semibold text-ink-900 hover:underline">{x.offering.name}</Link>
                  <p className="text-sm text-slate">{num(x.shares)} shares · {usdc(x.claimableYield)} ready to collect</p>
                </div>
                <TxButton
                  title="Collect earnings"
                  label="Collect"
                  doneText="Collected."
                  disabled={BigInt(x.claimableYield) === 0n || x.offering.vaultState !== 1}
                  calls={[calls.claimYield(x.vault as Address)]}
                  onDone={refresh}
                />
              </div>
            ))}
          </div>
        </section>
      )}

      {data.retirements.length > 0 && (
        <Panel title="Your retirements">
          <ul className="divide-y divide-line text-sm">
            {data.retirements.map((r) => (
              <li key={r.retirementId} className="flex justify-between py-2">
                <Link href={`/assets/carbon/${r.batchId}`} className="underline">Batch {r.batchId}</Link>
                <span>{num(r.amount)} t · {date(r.blockTime)}</span>
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </>
  );
}
