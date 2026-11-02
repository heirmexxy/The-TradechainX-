"use client";

import Link from "next/link";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { ListingView } from "@/lib/types";
import { usdc, num } from "@/lib/format";
import { Certificate } from "@/components/Certificate";
import { Empty, PageHeader, Spinner } from "@/components/ui";

const FILTERS = [
  { key: "", label: "Everything" },
  { key: "warehouse-receipt", label: "Warehouse receipts" },
  { key: "lpo", label: "Purchase orders" },
  { key: "carbon", label: "Carbon credits" },
] as const;

export default function MarketplacePage() {
  const [type, setType] = useState<string>("");
  const { data, isLoading } = useQuery({
    queryKey: ["listings", type],
    queryFn: () => api<{ listings: ListingView[] }>(`/marketplace/listings${type ? `?type=${type}` : ""}`),
  });

  return (
    <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
      <PageHeader
        title="Marketplace"
        intro="Every asset here was issued by a verified business and approved by our review team. Open any listing to see its documents fingerprint and full history."
      />
      <div className="mb-8 flex flex-wrap gap-2" role="tablist" aria-label="Asset type">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            role="tab"
            aria-selected={type === f.key}
            onClick={() => setType(f.key)}
            className={`rounded-full border px-4 py-1.5 text-sm ${type === f.key ? "border-ink bg-ink text-white" : "border-line bg-white text-slate hover:border-ink-500"}`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {isLoading && <Spinner />}
      {data && data.listings.length === 0 && (
        <Empty title="Nothing for sale yet">
          New listings appear here as soon as they're approved. Check back soon, or create an account to be first in line.
        </Empty>
      )}
      <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {data?.listings.map((l) =>
          l.asset ? (
            <Certificate
              key={l.listingId}
              asset={l.asset}
              footer={
                <div className="flex items-end justify-between gap-3 border-t border-line pt-4">
                  <div>
                    <p className="text-xs text-slate-500">{l.assetType === "carbon" ? "Price per tonne" : "Price"}</p>
                    <p className="text-lg font-semibold text-ink-900">{usdc(l.pricePerUnit)}</p>
                    {l.assetType === "carbon" && <p className="text-xs text-slate-500">{num(l.remaining)} t available</p>}
                  </div>
                  <Link href={`/marketplace/${l.listingId}`} className="rounded bg-ink px-4 py-2 text-sm font-semibold text-white hover:bg-ink-700">
                    View
                  </Link>
                </div>
              }
            />
          ) : null,
        )}
      </div>
    </div>
  );
}
