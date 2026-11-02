"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, ApiError } from "@/lib/api";
import { date, usdc } from "@/lib/format";
import { useSession } from "@/lib/session";
import { Button, Empty, Field, Input, Notice, PageHeader, Panel, Pill, Select, Spinner } from "@/components/ui";

type Config = { enabled: false } | { enabled: true; provider: string; directions: ("deposit" | "withdraw")[]; currencies: string[]; countries: string[] | null };
type Tx = { id: string; direction: "deposit" | "withdraw"; status: string; fiatCurrency: string; fiatAmount: string | null; usdcAmount: string | null; txHash: string | null; createdAt: string };

const STATUS_TONE: Record<string, "good" | "warn" | "bad" | "neutral"> = { completed: "good", pending: "warn", created: "neutral", failed: "bad", cancelled: "neutral" };
const STATUS_WORD: Record<string, string> = { completed: "Completed", pending: "In progress", created: "Started", failed: "Failed", cancelled: "Cancelled" };

export default function FundsPage() {
  const { data: user } = useSession();
  const { data: config, isLoading } = useQuery({ queryKey: ["rampConfig"], queryFn: () => api<Config>("/ramp/config") });
  const { data: txs, refetch } = useQuery({
    queryKey: ["rampTxs"],
    queryFn: () => api<{ transactions: Tx[] }>("/ramp/transactions"),
    enabled: !!user?.walletAddress,
    refetchInterval: 15_000,
  });
  const [direction, setDirection] = useState<"deposit" | "withdraw">("deposit");
  const [currency, setCurrency] = useState("");
  const [amount, setAmount] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [instructions, setInstructions] = useState<Record<string, string> | null>(null);

  useEffect(() => {
    if (config?.enabled && !currency) setCurrency(config.currencies[0] ?? "");
  }, [config, currency]);

  if (isLoading) return <Spinner />;
  if (!config?.enabled) {
    return (
      <>
        <PageHeader title="Add or withdraw money" />
        <Empty title="Not available yet">You can't add money by bank transfer or card here yet. For now, receive USDC from a buyer or ask the TradeChainX team how to fund your account.</Empty>
      </>
    );
  }

  async function start(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setInstructions(null);
    try {
      const r = await api<{ id: string; redirectUrl: string | null; instructions: Record<string, string> | null }>("/ramp/sessions", {
        body: { direction, fiatCurrency: currency, fiatAmount: amount || undefined },
      });
      if (r.redirectUrl) window.location.assign(r.redirectUrl);
      else if (r.instructions) setInstructions(r.instructions);
      await refetch();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't start. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Add or withdraw money"
        intro="Payments are handled by our licensed payment partner. You'll finish on their secure page, then come back here."
      />
      <div className="grid gap-6 lg:grid-cols-[1fr_1.2fr]">
        <Panel title="New transfer">
          <form onSubmit={start} className="space-y-4">
            <Field label="What would you like to do?">
              <Select value={direction} onChange={(e) => setDirection(e.target.value as "deposit" | "withdraw")}>
                {config.directions.includes("deposit") && <option value="deposit">Add money to my account</option>}
                {config.directions.includes("withdraw") && <option value="withdraw">Withdraw to my bank</option>}
              </Select>
            </Field>
            <Field label="Currency">
              <Select value={currency} onChange={(e) => setCurrency(e.target.value)}>
                {config.currencies.map((c) => <option key={c} value={c}>{c}</option>)}
              </Select>
            </Field>
            <Field label="Amount (optional)" hint="You can also choose the amount on the partner's page.">
              <Input inputMode="decimal" pattern="\d+(\.\d{1,2})?" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="e.g. 50000" />
            </Field>
            {config.countries && <p className="text-xs text-slate-500">Available in: {config.countries.join(", ")}.</p>}
            {error && <Notice tone="bad">{error}</Notice>}
            <Button type="submit" disabled={busy || !currency}>{busy ? "Starting…" : "Continue"}</Button>
          </form>
          {instructions && (
            <div className="mt-4">
              <Notice title="Transfer details">
                <ul className="mt-1 space-y-1">{Object.entries(instructions).map(([k, v]) => <li key={k}><span className="text-slate-500">{k}:</span> <strong>{v}</strong></li>)}</ul>
              </Notice>
            </div>
          )}
        </Panel>
        <Panel title="Your transfers">
          {!txs || txs.transactions.length === 0 ? (
            <p className="text-sm text-slate-500">Nothing yet.</p>
          ) : (
            <ul className="divide-y divide-line text-sm">
              {txs.transactions.map((t) => (
                <li key={t.id} className="flex flex-wrap items-center gap-3 py-2">
                  <span className="font-medium">{t.direction === "deposit" ? "Added" : "Withdrew"}</span>
                  <span>{t.fiatAmount ? `${t.fiatAmount} ${t.fiatCurrency}` : t.fiatCurrency}</span>
                  {t.usdcAmount && <span className="text-slate">{usdc(t.usdcAmount)}</span>}
                  <span className="text-slate-500">{date(t.createdAt)}</span>
                  <span className="ml-auto"><Pill tone={STATUS_TONE[t.status] ?? "neutral"}>{STATUS_WORD[t.status] ?? t.status}</Pill></span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </>
  );
}
