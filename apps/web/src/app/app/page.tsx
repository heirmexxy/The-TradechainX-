"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { can, KYC_STATUS_LABEL, USER_TYPE_LABEL } from "@tradechainx/shared";
import { api } from "@/lib/api";
import { usdc } from "@/lib/format";
import { useSession } from "@/lib/session";
import { useWallet } from "@/wallet/WalletProvider";
import { Button, LinkButton, Notice, PageHeader, Panel, Spinner } from "@/components/ui";
import { useState } from "react";

const DEV_TOOLS = process.env.NEXT_PUBLIC_WALLET_PROVIDER !== "sequence";

export default function AccountHome() {
  const { data: user } = useSession();
  const { status } = useWallet();
  const verified = !!user?.identity?.active;
  const { data: portfolio } = useQuery({
    queryKey: ["portfolio"],
    enabled: !!user?.walletAddress,
    queryFn: () => api<{ usdcBalance: string; assets: unknown[]; carbon: unknown[]; xown: unknown[]; listings: unknown[] }>("/portfolio"),
  });
  if (!user) return <Spinner />;

  const steps: [string, boolean, string, string][] = [
    ["Choose your account type", !!user.userType, "/app/onboarding", "Choose"],
    ["Verify your identity", verified, "/app/onboarding", user.kyc.status === "not_started" ? "Start" : "View"],
  ];

  return (
    <>
      <PageHeader title={`Welcome${user.displayName ? `, ${user.displayName.split(" ")[0]}` : ""}`} intro={user.userType ? USER_TYPE_LABEL[user.userType] : "Let's get your account ready."} />

      {status === "connecting" && <Notice>Setting up your secure account…</Notice>}

      {!verified && !user.adminRoles.length && (
        <Panel title="Get started">
          <ol className="divide-y divide-line">
            {steps.map(([label, done, href, cta], i) => (
              <li key={label} className="flex items-center justify-between gap-4 py-3">
                <span className="flex items-center gap-3">
                  <span className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold ${done ? "bg-leaf text-white" : "bg-ink-50 text-ink-700"}`}>{done ? "✓" : i + 1}</span>
                  <span className={done ? "text-slate-500 line-through" : "font-medium text-ink-900"}>{label}</span>
                </span>
                {!done && <LinkButton href={href} variant="secondary">{cta}</LinkButton>}
              </li>
            ))}
          </ol>
          {user.kyc.status === "pending" && <p className="mt-3 text-sm text-slate">Verification: {KYC_STATUS_LABEL.pending}. We'll email you when it's done — usually within one working day.</p>}
          {user.kyc.status === "needs_info" && (
            <div className="mt-3">
              <Notice tone="warn" title="We need a bit more from you">
                {user.kyc.message} <Link href="/app/onboarding" className="underline">Update your details</Link>
              </Notice>
            </div>
          )}
        </Panel>
      )}

      {verified && (
        <div className="grid gap-6 md:grid-cols-3">
          <Panel title="Balance">
            <p className="text-2xl font-semibold text-ink-900">{portfolio ? usdc(portfolio.usdcBalance) : "…"}</p>
            <p className="mt-1 text-sm text-slate-500">Available to buy assets or shares.</p>
          </Panel>
          <Panel title="Holdings">
            <p className="text-2xl font-semibold text-ink-900">
              {portfolio ? portfolio.assets.length + portfolio.carbon.length + portfolio.xown.length : "…"}
            </p>
            <Link href="/app/portfolio" className="mt-1 block text-sm text-ink-700 underline">
              View portfolio
            </Link>
          </Panel>
          <Panel title="For sale">
            <p className="text-2xl font-semibold text-ink-900">{portfolio ? portfolio.listings.length : "…"}</p>
            <Link href="/marketplace" className="mt-1 block text-sm text-ink-700 underline">
              Browse the marketplace
            </Link>
          </Panel>
        </div>
      )}

      {verified && user.userType && (
        <div className="mt-8 flex flex-wrap gap-3">
          {(can(user.userType, "issue_receipts") || can(user.userType, "issue_lpos") || can(user.userType, "issue_carbon")) && <LinkButton href="/app/issue">Issue an asset</LinkButton>}
          {user.userType === "warehouse" && <LinkButton href="/app/warehouse" variant="secondary">Warehouse queue</LinkButton>}
          {user.userType === "lender" && <LinkButton href="/app/financing" variant="secondary">Your pledges</LinkButton>}
          <LinkButton href="/xown" variant="secondary">XOwn offerings</LinkButton>
        </div>
      )}

      {DEV_TOOLS && user.walletAddress && <DevFaucet />}
    </>
  );
}

function DevFaucet() {
  const [state, setState] = useState<"idle" | "busy" | "done" | "error">("idle");
  return (
    <div className="mt-12">
      <Notice tone="warn" title="Development tools">
        <p>Top up this test account with 100,000 test USDC.</p>
        <Button
          variant="secondary"
          className="mt-3"
          disabled={state === "busy"}
          onClick={async () => {
            setState("busy");
            try {
              await api("/dev/faucet", { method: "POST", body: {} });
              setState("done");
            } catch {
              setState("error");
            }
          }}
        >
          {state === "busy" ? "Adding…" : state === "done" ? "Added" : state === "error" ? "Failed — try again" : "Add test USDC"}
        </Button>
      </Notice>
    </div>
  );
}
