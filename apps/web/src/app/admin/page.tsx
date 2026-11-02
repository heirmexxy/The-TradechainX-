"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { usdc } from "@/lib/format";
import { hasRole, useSession } from "@/lib/session";
import { PageHeader, Panel, Spinner } from "@/components/ui";

type Overview = {
  queues: { kycPending: number; kycAwaitingOnchain: number; submissions: Record<string, number>; statusRequests: number; xownProposals: number };
  market: { activeListings: number; trades30d: number; volume30d: string; fees30d: string };
};

export default function AdminHome() {
  const { data: user } = useSession();
  const { data } = useQuery({ queryKey: ["adminOverview"], queryFn: () => api<Overview>("/admin/overview"), refetchInterval: 15_000 });
  if (!data) return <Spinner />;
  const q = data.queues;
  const subs = (q.submissions["warehouse-receipt"] ?? 0) + (q.submissions.lpo ?? 0) + (q.submissions.carbon ?? 0);

  const queues: [string, number, string, boolean][] = [
    ["Verifications waiting", q.kycPending, "/admin/kyc", hasRole(user, "kyc_reviewer")],
    ["Approved, not yet recorded", q.kycAwaitingOnchain, "/admin/kyc?status=approved", hasRole(user, "kyc_reviewer")],
    ["Listings to review", subs, "/admin/reviews", hasRole(user, "listing_reviewer")],
    ["Status changes to review", q.statusRequests, "/admin/requests", hasRole(user, "listing_reviewer")],
    ["XOwn proposals", q.xownProposals, "/admin/xown", hasRole(user, "listing_reviewer", "asset_manager")],
  ];

  return (
    <>
      <PageHeader title="Overview" />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {queues
          .filter(([, , , show]) => show)
          .map(([label, n, href]) => (
            <Link key={label} href={href} className={`rounded border bg-white p-5 hover:border-ink-500 ${n > 0 ? "border-maize" : "border-line"}`}>
              <p className="text-sm text-slate">{label}</p>
              <p className="mt-1 text-3xl font-semibold text-ink-900">{n}</p>
            </Link>
          ))}
      </div>
      <div className="mt-8">
        <Panel title="Marketplace, last 30 days">
          <dl className="grid gap-4 sm:grid-cols-4">
            {[
              ["Active listings", String(data.market.activeListings)],
              ["Trades", String(data.market.trades30d)],
              ["Volume", usdc(data.market.volume30d)],
              ["Fees earned", usdc(data.market.fees30d)],
            ].map(([k, v]) => (
              <div key={k}>
                <dt className="text-xs text-slate-500">{k}</dt>
                <dd className="mt-1 text-lg font-semibold text-ink-900">{v}</dd>
              </div>
            ))}
          </dl>
        </Panel>
      </div>
    </>
  );
}
