"use client";

import Link from "next/link";
import { use, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { discountBps, parseUsdc } from "@tradechainx/shared";
import { api } from "@/lib/api";
import { ADDRESSES } from "@/lib/chain";
import { calls } from "@/lib/calls";
import type { ListingView } from "@/lib/types";
import { addr, date, usdc, num } from "@/lib/format";
import { useSession } from "@/lib/session";
import { reportReferral } from "@/lib/referral";
import { Certificate } from "@/components/Certificate";
import { TxButton } from "@/components/TxButton";
import { Facts, Field, Input, LinkButton, Notice, Panel, Spinner } from "@/components/ui";

export default function ListingPage({ params }: { params: Promise<{ listingId: string }> }) {
  const { listingId } = use(params);
  const { data: user } = useSession();
  const { data, isLoading, refetch } = useQuery({
    queryKey: ["listing", listingId],
    queryFn: () => api<{ listing: ListingView; trades: { buyer: string; amount: string; total: string; blockTime: string }[] }>(`/marketplace/listings/${listingId}`),
  });
  const [qty, setQty] = useState("1");
  const [newPrice, setNewPrice] = useState("");

  if (isLoading || !data) return <div className="mx-auto max-w-5xl px-4 py-12"><Spinner /></div>;
  const l = data.listing;
  const a = l.asset!;
  const isCarbon = l.assetType === "carbon";
  const amount = isCarbon ? BigInt(Math.max(0, Math.min(Number(qty || 0), Number(l.remaining)))) : 1n;
  const total = BigInt(l.pricePerUnit) * amount;
  const mine = user?.walletAddress?.toLowerCase() === l.seller;
  const verified = user?.identity?.active;

  return (
    <div className="mx-auto grid max-w-5xl gap-8 px-4 py-12 sm:px-6 md:grid-cols-[1.1fr_0.9fr]">
      <div>
        <Link href="/marketplace" className="text-sm text-ink-700 underline">
          Back to marketplace
        </Link>
        <div className="mt-4">
          <Certificate asset={a} />
        </div>
        <p className="mt-4 text-sm">
          <Link href={`/assets/${a.assetType}/${a.tokenId}`} className="text-ink-700 underline">
            See documents fingerprint and full history
          </Link>
        </p>
      </div>

      <div className="space-y-6">
        <Panel title={l.active ? "Buy" : "This listing has closed"}>
          <Facts
            items={[
              [isCarbon ? "Price per tonne" : "Price", usdc(l.pricePerUnit)],
              ["Seller", addr(l.seller)],
              ...(isCarbon ? ([["Available", `${num(l.remaining)} t`]] as [string, string][]) : []),
              ...(l.assetType === "lpo"
                ? ([
                    ["You'll receive", `${usdc(a.terms.faceValue)} on ${date(Number(a.terms.dueDate))}`],
                    ["Discount to face value", `${(discountBps(BigInt(a.terms.faceValue ?? "0"), BigInt(l.pricePerUnit)) / 100).toFixed(2)}%`],
                  ] as [string, string][])
                : []),
            ]}
          />

          {l.active && !mine && (
            <div className="mt-6 space-y-4 border-t border-line pt-5">
              {isCarbon && (
                <Field label="Tonnes to buy">
                  <Input type="number" min={1} max={Number(l.remaining)} value={qty} onChange={(e) => setQty(e.target.value)} />
                </Field>
              )}
              <p className="flex justify-between text-sm">
                <span>You pay</span>
                <span className="font-semibold text-ink-900">{usdc(total)}</span>
              </p>
              {!user && <LinkButton href={`/login?next=/marketplace/${listingId}`}>Sign in to buy</LinkButton>}
              {user && !verified && (
                <Notice tone="warn" title="Verify your account to buy">
                  <Link className="underline" href="/app/onboarding">
                    Finish verification
                  </Link>{" "}
                  — it takes a few minutes.
                </Notice>
              )}
              {user && verified && (
                <TxButton
                  title="Complete your purchase"
                  label={`Buy for ${usdc(total)}`}
                  doneText="Purchased. It's now in your portfolio."
                  disabled={amount === 0n}
                  calls={[calls.approveUsdc(ADDRESSES.marketplace, total), calls.buy(BigInt(l.listingId), amount, total)]}
                  onDone={(hashes) => {
                    void reportReferral("listing", String(l.listingId), hashes[hashes.length - 1]);
                    void refetch();
                  }}
                  className="w-full"
                />
              )}
              <p className="text-xs text-slate-500">
                Payment and the asset change hands in a single step — you're never left having paid without receiving it.
              </p>
            </div>
          )}

          {l.active && mine && (
            <div className="mt-6 space-y-4 border-t border-line pt-5">
              <p className="text-sm text-slate">This is your listing.</p>
              <Field label="New price (USDC)">
                <Input inputMode="decimal" value={newPrice} onChange={(e) => setNewPrice(e.target.value)} placeholder="e.g. 17,500" />
              </Field>
              <div className="flex flex-wrap gap-2">
                <TxButton
                  variant="secondary"
                  title="Change price"
                  label="Update price"
                  doneText="Price updated."
                  disabled={!newPrice}
                  calls={() => [calls.updatePrice(BigInt(l.listingId), parseUsdc(newPrice))]}
                  onDone={() => void refetch()}
                />
                <TxButton
                  variant="danger"
                  title="Take off the market"
                  label="Cancel listing"
                  doneText="Cancelled. The asset is back in your portfolio."
                  calls={[calls.cancelListing(BigInt(l.listingId))]}
                  onDone={() => void refetch()}
                />
              </div>
            </div>
          )}
        </Panel>

        {data.trades.length > 0 && (
          <Panel title="Sales from this listing">
            <ul className="divide-y divide-line text-sm">
              {data.trades.map((t, i) => (
                <li key={i} className="flex justify-between py-2">
                  <span>
                    {isCarbon ? `${num(t.amount)} t` : "Sold"} to {addr(t.buyer)}
                  </span>
                  <span className="font-medium text-ink-900">{usdc(t.total)}</span>
                </li>
              ))}
            </ul>
          </Panel>
        )}
      </div>
    </div>
  );
}
