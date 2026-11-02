"use client";

import Link from "next/link";
import { use, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Address } from "viem";
import { fromBytes32Code, humanizeCode, parseUsdc, VaultState, VAULT_STATE_LABEL } from "@tradechainx/shared";
import { api } from "@/lib/api";
import { calls } from "@/lib/calls";
import type { OfferingView } from "@/lib/types";
import { addr, date, num, usdc } from "@/lib/format";
import { useSession, hasRole } from "@/lib/session";
import { reportReferral } from "@/lib/referral";
import { TxButton } from "@/components/TxButton";
import { Facts, Field, Input, LinkButton, Notice, Panel, Pill, Spinner } from "@/components/ui";

type Detail = {
  offering: OfferingView;
  holders: number;
  mine: { shares: string; claimableYield: string } | null;
  history: { event: string; blockTime: string; args: Record<string, string> }[];
};

export default function OfferingPage({ params }: { params: Promise<{ vault: string }> }) {
  const { vault } = use(params);
  const { data: user } = useSession();
  const { data, isLoading, refetch } = useQuery({ queryKey: ["xown", vault], queryFn: () => api<Detail>(`/xown/offerings/${vault}`) });
  const [shares, setShares] = useState("1");
  const [amount, setAmount] = useState("");
  const refresh = () => setTimeout(() => void refetch(), 2500);

  if (isLoading || !data) return <div className="mx-auto max-w-5xl px-4 py-12"><Spinner /></div>;
  const o = data.offering;
  const v = vault as Address;
  const left = Number(o.maxShares) - Number(o.sharesSold);
  const n = BigInt(Math.max(0, Math.min(Number(shares || 0), left)));
  const cost = n * BigInt(o.pricePerShare);
  const state = o.vaultState ?? VaultState.Fundraising;
  const deadlinePassed = o.deadline * 1000 < Date.now();
  const isOperator = user?.walletAddress?.toLowerCase() === o.operator;
  const isReviewer = hasRole(user, "listing_reviewer") && !isOperator;
  const myShares = BigInt(data.mine?.shares ?? "0");
  const claimable = BigInt(data.mine?.claimableYield ?? "0");

  return (
    <div className="mx-auto grid max-w-5xl gap-8 px-4 py-12 sm:px-6 md:grid-cols-[1.1fr_0.9fr]">
      <div className="space-y-6">
        <Link href="/xown" className="text-sm text-ink-700 underline">All offerings</Link>
        <div>
          <p className="text-sm text-ink-500">{humanizeCode(fromBytes32Code(o.equipment.assetType ?? ""))}</p>
          <h1 className="mt-1 text-h1">{o.name}</h1>
          <div className="mt-3"><Pill tone={state === 1 ? "good" : state === 2 ? "bad" : "warn"}>{VAULT_STATE_LABEL[state]}</Pill></div>
        </div>
        {o.details.description && <p className="max-w-prose text-slate">{String(o.details.description)}</p>}
        <Panel title="The offering">
          <Facts
            items={[
              ["Price per share", usdc(o.pricePerShare)],
              ["Shares", `${num(o.sharesSold)} sold of ${num(o.maxShares)}`],
              ["Open until", date(o.deadline)],
              ["Location", String(o.details.location ?? "—")],
              ["Operator", addr(o.operator)],
              ["Shareholders", num(data.holders)],
              ["Earnings paid so far", usdc(o.totalYield)],
              ...(o.details.expectedAnnualYieldPct != null
                ? ([["Operator's earnings estimate", `${o.details.expectedAnnualYieldPct}% a year (an estimate, not a promise)`]] as [string, string][])
                : []),
            ]}
          />
        </Panel>
        <Notice title="How your money is protected">
          The operator only receives the money once every share is sold. If that doesn't happen by {date(o.deadline)}, everyone gets a full refund. Earnings exist only when the operator pays real income in — there are no promised returns.
        </Notice>
      </div>

      <div className="space-y-6">
        {!user && <LinkButton href={`/login?next=/xown/${vault}`}>Sign in to invest</LinkButton>}

        {user && myShares > 0n && (
          <Panel title="Your shares">
            <Facts items={[["You own", `${num(myShares)} shares`], ["Earnings ready to collect", usdc(claimable)]]} />
            <div className="mt-4 flex flex-wrap gap-2">
              {state === VaultState.Active && (
                <TxButton title="Collect earnings" label="Collect earnings" doneText="Collected." disabled={claimable === 0n} calls={[calls.claimYield(v)]} onDone={refresh} />
              )}
              {state === VaultState.Failed && <TxButton title="Get your money back" label="Get refund" doneText="Refunded in full." calls={[calls.refund(v)]} onDone={refresh} />}
              {state === VaultState.Dissolved && <TxButton title="Redeem your shares" label="Redeem shares" doneText="Redeemed." calls={[calls.redeemShares(v)]} onDone={refresh} />}
            </div>
          </Panel>
        )}

        {user && state === VaultState.Fundraising && !deadlinePassed && left > 0 && (
          <Panel title="Buy shares">
            {!user.identity?.active ? (
              <Notice tone="warn" title="Verify your account to invest">
                <Link href="/app/onboarding" className="underline">Finish verification</Link>
              </Notice>
            ) : (
              <>
                <Field label="Shares" hint={`${num(left)} left`}>
                  <Input type="number" min={1} max={left} value={shares} onChange={(e) => setShares(e.target.value)} />
                </Field>
                <p className="my-4 flex justify-between text-sm">
                  <span>You pay</span>
                  <span className="font-semibold text-ink-900">{usdc(cost)}</span>
                </p>
                <TxButton title="Buy shares" label={`Buy ${num(n)} share${n === 1n ? "" : "s"}`} doneText="Done. Your shares are in your portfolio." disabled={n === 0n} calls={calls.subscribe(v, n, cost)} onDone={(hashes) => { void reportReferral("xown", v, hashes[hashes.length - 1]); refresh(); }} className="w-full" />
              </>
            )}
          </Panel>
        )}

        {state === VaultState.Fundraising && deadlinePassed && user && (
          <Panel title="This offering didn't fill">
            <p className="mb-4 text-sm text-slate">Close it to open refunds for everyone.</p>
            <TxButton variant="secondary" title="Close the offering" label="Close and open refunds" doneText="Closed. Refunds are open." calls={[calls.markFailed(v)]} onDone={refresh} />
          </Panel>
        )}

        {isOperator && state === VaultState.Active && (
          <Panel title="Operator">
            <Field label="Amount (USDC)">
              <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </Field>
            <div className="mt-4 flex flex-wrap gap-2">
              <TxButton title="Pay earnings to shareholders" label="Pay earnings" doneText="Paid to shareholders." disabled={!amount} calls={() => calls.depositYield(v, parseUsdc(amount))} onDone={refresh} />
              <TxButton variant="secondary" title="Deposit sale proceeds" label="Deposit sale proceeds" doneText="Deposited. A reviewer will close the offering." disabled={!amount} calls={() => calls.depositProceeds(v, parseUsdc(amount))} onDone={refresh} />
            </div>
            <p className="mt-3 text-xs text-slate-500">Use "sale proceeds" only when the machine has been sold or insured out, ahead of closing the offering.</p>
          </Panel>
        )}

        {isReviewer && state === VaultState.Active && BigInt(o.proceeds) > 0n && (
          <Panel title="Review: close this offering">
            <p className="mb-4 text-sm text-slate">The operator deposited {usdc(o.proceeds)} in sale proceeds. Confirm the machine was sold, then close the offering so shareholders can redeem.</p>
            <TxButton variant="danger" title="Close the offering" label="Close and open redemptions" doneText="Closed." calls={[calls.dissolve(v)]} onDone={refresh} />
          </Panel>
        )}
      </div>
    </div>
  );
}
