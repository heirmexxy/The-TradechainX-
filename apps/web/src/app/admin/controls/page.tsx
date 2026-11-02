"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Address } from "viem";
import { marketplaceAbi } from "@tradechainx/shared";
import { ADDRESSES, ABIS, publicClient, type ContractKey } from "@/lib/chain";
import { calls } from "@/lib/calls";
import { hasRole, useSession } from "@/lib/session";
import { TxButton } from "@/components/TxButton";
import { downloadSafeBatch } from "@/lib/safe";
import { Button, Field, Input, Notice, PageHeader, Panel, Pill, Spinner } from "@/components/ui";

const PAUSABLE: [ContractKey, string][] = [
  ["marketplace", "Marketplace (buying and listing)"],
  ["warehouseReceipt", "Warehouse receipts"],
  ["lpoToken", "Purchase orders"],
  ["carbonCredits", "Carbon credits"],
  ["xownFactory", "XOwn (all offerings)"],
];

export default function ControlsPage() {
  const { data: user } = useSession();
  const { data, refetch } = useQuery({
    queryKey: ["pauseState"],
    queryFn: async () => {
      const entries = await Promise.all(
        PAUSABLE.map(async ([k]) => [k, await publicClient.readContract({ address: ADDRESSES[k as keyof typeof ADDRESSES] as Address, abi: ABIS[k], functionName: "paused" })] as const),
      );
      const [feeBps, feeCollector] = await Promise.all([
        publicClient.readContract({ address: ADDRESSES.marketplace, abi: marketplaceAbi, functionName: "feeBps" }),
        publicClient.readContract({ address: ADDRESSES.marketplace, abi: marketplaceAbi, functionName: "feeCollector" }),
      ]);
      return { paused: Object.fromEntries(entries) as Record<string, boolean>, feeBps: Number(feeBps), feeCollector: feeCollector as string };
    },
  });
  const [bps, setBps] = useState("");
  const [collector, setCollector] = useState("");
  if (!data) return <Spinner />;
  const refresh = () => setTimeout(() => void refetch(), 2000);
  const superAdmin = hasRole(user, "super_admin") && user?.adminRoles.includes("super_admin");

  return (
    <>
      <PageHeader title="Controls" intro="Pause stops activity on a contract while something is investigated. Anyone with the pauser role can pause; only the Super Admin account can resume." />
      <Panel title="Emergency pause">
        <ul className="divide-y divide-line">
          {PAUSABLE.map(([k, label]) => {
            const paused = data.paused[k];
            const address = ADDRESSES[k as keyof typeof ADDRESSES] as Address;
            return (
              <li key={k} className="flex items-center justify-between gap-4 py-3">
                <span className="flex items-center gap-3">
                  {label} {paused ? <Pill tone="bad">Paused</Pill> : <Pill tone="good">Running</Pill>}
                </span>
                {paused ? (
                  <>
                    <TxButton variant="secondary" title={`Resume ${label}`} label="Resume" doneText="Resumed." disabled={!superAdmin} calls={[calls.unpause(k, address)]} onDone={refresh} />
                    <Button variant="quiet" onClick={() => downloadSafeBatch([calls.unpause(k, address)], `Resume ${label}`)}>Download for Safe</Button>
                  </>
                ) : (
                  <TxButton variant="danger" title={`Pause ${label}`} label="Pause" doneText="Paused." calls={[calls.pause(k, address)]} onDone={refresh} />
                )}
              </li>
            );
          })}
        </ul>
      </Panel>

      <div className="mt-8">
        <Panel title="Marketplace fee">
          <p className="mb-4 text-sm text-slate">
            Currently {(data.feeBps / 100).toFixed(2)}%, paid by sellers from the sale price, sent to {data.feeCollector}. The contract caps it at 5%. New rates apply to new listings only.
          </p>
          {superAdmin ? (
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Fee (basis points)" hint="100 = 1%">
                <Input type="number" min={0} max={500} value={bps} onChange={(e) => setBps(e.target.value)} placeholder={String(data.feeBps)} />
              </Field>
              <Field label="Fee collector">
                <Input value={collector} onChange={(e) => setCollector(e.target.value)} placeholder={data.feeCollector} />
              </Field>
              <div className="flex items-end">
                <TxButton
                  title="Update fee"
                  label="Update fee"
                  doneText="Fee updated."
                  disabled={!bps && !collector}
                  calls={() => [calls.setFee(bps ? Number(bps) : data.feeBps, (collector || data.feeCollector) as Address)]}
                  onDone={refresh}
                />
                <Button
                  variant="secondary"
                  className="ml-2"
                  disabled={!bps && !collector}
                  onClick={() => downloadSafeBatch([calls.setFee(bps ? Number(bps) : data.feeBps, (collector || data.feeCollector) as Address)], "Update marketplace fee")}
                >
                  Download for Safe
                </Button>
              </div>
            </div>
          ) : (
            <Notice>Only the Super Admin account can change the fee.</Notice>
          )}
        </Panel>
      </div>
    </>
  );
}
