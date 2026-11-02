"use client";

import { useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Hex } from "viem";
import type { Call } from "@/lib/calls";
import { explorerTx } from "@/lib/chain";
import { friendlyError } from "@/lib/errors";
import { useWallet, type StepState } from "@/wallet/WalletProvider";
import { Button } from "./ui";

type Props = {
  /** Calls to run, or a function that builds them at click time (e.g. after reading a form). */
  calls: Call[] | (() => Promise<Call[]> | Call[]);
  label: ReactNode;
  /** Shown as the dialog title, e.g. "Buy this receipt". */
  title: string;
  /** What happened, in the past tense: "Purchased". Shown when everything confirms. */
  doneText: string;
  variant?: "primary" | "secondary" | "quiet" | "danger";
  disabled?: boolean;
  onDone?: (hashes: Hex[]) => unknown;
  className?: string;
};

/**
 * Runs one or more contract calls with a progress dialog. Steps are described in plain language
 * ("Allow the payment", "Complete the purchase") — no wallet or gas vocabulary.
 */
export function TxButton({ calls, label, title, doneText, variant = "primary", disabled, onDone, className }: Props) {
  const { run, status } = useWallet();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [steps, setSteps] = useState<StepState[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function start() {
    setOpen(true);
    setError(null);
    setDone(false);
    try {
      const list = typeof calls === "function" ? await calls() : calls;
      setSteps(list.map((c) => ({ summary: c.summary, status: "waiting" })));
      const hashes = await run(list, setSteps);
      setDone(true);
      // Give the indexer a moment, then refresh everything that might show this change.
      setTimeout(() => qc.invalidateQueries(), 2500);
      await onDone?.(hashes);
    } catch (e) {
      setError(friendlyError(e));
    }
  }

  const busy = open && !done && !error;
  return (
    <>
      <Button type="button" variant={variant} disabled={disabled || busy || status !== "ready"} onClick={start} className={className}>
        {label}
      </Button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink-900/40 p-4 sm:items-center" role="dialog" aria-modal="true" aria-labelledby="tx-title">
          <div className="w-full max-w-md rounded bg-white p-6 shadow-xl">
            <h2 id="tx-title" className="text-h3">
              {title}
            </h2>
            <ol className="mt-4 space-y-3">
              {steps.map((s, i) => (
                <li key={i} className="flex items-start gap-3 text-sm">
                  <StepIcon status={s.status} />
                  <span className={s.status === "waiting" ? "text-slate-500" : "text-ink-900"}>
                    {s.summary}
                    {s.hash && explorerTx(s.hash) && (
                      <a className="ml-2 text-ink-500 underline" href={explorerTx(s.hash)!} target="_blank" rel="noreferrer">
                        record
                      </a>
                    )}
                  </span>
                </li>
              ))}
              {steps.length === 0 && !error && <li className="text-sm text-slate-500">Preparing…</li>}
            </ol>
            {error && <p className="mt-4 rounded bg-danger-100 px-3 py-2 text-sm text-danger">{error}</p>}
            {done && <p className="mt-4 rounded bg-leaf-100 px-3 py-2 text-sm font-medium text-leaf">{doneText}</p>}
            <div className="mt-6 flex justify-end">
              <Button variant="secondary" onClick={() => setOpen(false)} disabled={busy}>
                {busy ? "Working…" : "Close"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function StepIcon({ status }: { status: StepState["status"] }) {
  if (status === "done") return <span className="mt-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-leaf text-[10px] text-white" aria-label="done">✓</span>;
  if (status === "failed") return <span className="mt-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-danger text-[10px] text-white" aria-label="failed">!</span>;
  if (status === "running") return <span className="mt-0.5 h-4 w-4 animate-spin rounded-full border-2 border-ink-100 border-t-ink" aria-label="in progress" />;
  return <span className="mt-0.5 h-4 w-4 rounded-full border-2 border-line" aria-label="waiting" />;
}
