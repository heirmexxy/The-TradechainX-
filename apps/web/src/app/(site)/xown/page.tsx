"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { OfferingView } from "@/lib/types";
import { Empty, PageHeader, Spinner } from "@/components/ui";
import { OfferingCard } from "@/components/OfferingCard";

export default function XOwnPage() {
  const { data, isLoading } = useQuery({ queryKey: ["xown"], queryFn: () => api<{ offerings: OfferingView[] }>("/xown/offerings") });
  return (
    <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
      <PageHeader
        title="XOwn"
        intro="Own shares in working farm machinery — tractors, dryers, threshers — run by verified operators. Earnings are paid out as the machine earns. If an offering doesn't fill by its deadline, everyone is refunded in full."
      />
      {isLoading && <Spinner />}
      {data && data.offerings.length === 0 && <Empty title="No offerings open right now">New machines are listed as soon as they pass review.</Empty>}
      <div className="grid gap-6 md:grid-cols-2">
        {data?.offerings.map((o) => <OfferingCard key={o.proposalId} o={o} />)}
      </div>
    </div>
  );
}
