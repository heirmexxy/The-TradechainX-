"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { usdcPlain } from "@/lib/format";

/**
 * PRD §6.2: never show "0 listings / 0 trades" before launch. This strip only appears once there's
 * real activity on the platform.
 */
export function LiveStats() {
  const { data } = useQuery({
    queryKey: ["stats"],
    queryFn: () => api<{ volume30d: string; trades30d: number; assetsIssued: number; activeListings: number }>("/marketplace/stats"),
  });
  if (!data || data.assetsIssued < 10) return null;
  return (
    <section className="border-b border-line bg-white">
      <dl className="mx-auto grid max-w-6xl grid-cols-2 gap-6 px-4 py-8 sm:px-6 md:grid-cols-4">
        {[
          ["Assets issued", data.assetsIssued.toLocaleString("en-US")],
          ["For sale now", data.activeListings.toLocaleString("en-US")],
          ["Trades, last 30 days", data.trades30d.toLocaleString("en-US")],
          ["Traded, last 30 days", `${usdcPlain(data.volume30d)} USDC`],
        ].map(([k, v]) => (
          <div key={k}>
            <dt className="text-sm text-slate-500">{k}</dt>
            <dd className="mt-1 text-2xl font-semibold text-ink-900">{v}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
