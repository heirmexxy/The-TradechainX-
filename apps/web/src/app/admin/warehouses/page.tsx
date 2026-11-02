"use client";

import { useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { keccak256, toBytes } from "viem";
import { api, ApiError } from "@/lib/api";
import { calls, fromApi } from "@/lib/calls";
import type { PreparedCallJson } from "@/lib/types";
import { addr, num } from "@/lib/format";
import { TxButton } from "@/components/TxButton";
import { Button, Field, Input, Notice, PageHeader, Panel, Pill, Spinner } from "@/components/ui";

type Warehouse = { id: string; active: boolean; operator: string; name?: string; state?: string; capacityTonnes?: number; commodities?: string[] };

export default function WarehousesAdmin() {
  const { data, isLoading, refetch } = useQuery({ queryKey: ["warehouses"], queryFn: () => api<{ warehouses: Warehouse[] }>("/warehouses") });
  const refresh = () => setTimeout(() => void refetch(), 3000);
  return (
    <>
      <PageHeader title="Warehouses" intro="Only facilities registered here can issue receipts. Suspending a warehouse stops new receipts; existing ones stay valid." />
      <RegisterWarehouse onDone={refresh} />
      <div className="mt-8">
        <Panel title="Registered">
          {isLoading && <Spinner />}
          <ul className="divide-y divide-line">
            {data?.warehouses.map((w) => <WarehouseRow key={w.id} w={w} onDone={refresh} />)}
          </ul>
        </Panel>
      </div>
    </>
  );
}

function WarehouseRow({ w, onDone }: { w: Warehouse; onDone: () => void }) {
  const [reason, setReason] = useState("");
  return (
    <li className="flex flex-wrap items-center justify-between gap-4 py-4">
      <div>
        <p className="font-semibold text-ink-900">{w.name ?? `Warehouse ${w.id}`} {!w.active && <Pill tone="bad">Suspended</Pill>}</p>
        <p className="text-sm text-slate">
          {w.state ?? ""} · operator {addr(w.operator)}
          {w.capacityTonnes ? ` · ${num(w.capacityTonnes)} t` : ""}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Input placeholder="Reason" value={reason} onChange={(e) => setReason(e.target.value)} className="w-48" />
        <TxButton
          variant={w.active ? "danger" : "secondary"}
          title={w.active ? "Suspend warehouse" : "Reinstate warehouse"}
          label={w.active ? "Suspend" : "Reinstate"}
          doneText={w.active ? "Suspended." : "Reinstated."}
          disabled={!reason}
          calls={() => [calls.setWarehouseActive(BigInt(w.id), !w.active, keccak256(toBytes(reason)))]}
          onDone={onDone}
        />
      </div>
    </li>
  );
}

function RegisterWarehouse({ onDone }: { onDone: () => void }) {
  const [f, setF] = useState<Record<string, string>>({});
  const [prepared, setPrepared] = useState<PreparedCallJson | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: string) => setF((x) => ({ ...x, [k]: v }));

  async function prepare(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const fields = { ...f, capacityTonnes: Number(f.capacityTonnes), commodities: (f.commodities ?? "").split(",").map((s) => s.trim()).filter(Boolean) };
      const res = await api<{ call: PreparedCallJson }>("/drafts/warehouse", { body: { fields, documentIds: [] } });
      setPrepared(res.call);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't prepare the registration.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title="Register a warehouse">
      <p className="mb-4 text-sm text-slate">Register only after you've inspected the facility and checked its licence. The operator must already have a verified business account.</p>
      {prepared ? (
        <div className="flex gap-2">
          <TxButton title="Register warehouse" label="Register" doneText="Registered." calls={[fromApi(prepared)]} onDone={() => { setPrepared(null); setF({}); onDone(); }} />
          <Button variant="quiet" onClick={() => setPrepared(null)}>Edit</Button>
        </div>
      ) : (
        <form onSubmit={prepare} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Warehouse name"><Input value={f.name ?? ""} onChange={(e) => set("name", e.target.value)} required /></Field>
            <Field label="Operator's email"><Input type="email" value={f.operatorEmail ?? ""} onChange={(e) => set("operatorEmail", e.target.value)} required /></Field>
            <Field label="Licence number" hint="Each licence can back one warehouse."><Input value={f.licenceNumber ?? ""} onChange={(e) => set("licenceNumber", e.target.value)} required /></Field>
            <Field label="State"><Input value={f.state ?? ""} onChange={(e) => set("state", e.target.value)} required /></Field>
            <Field label="Address"><Input value={f.address ?? ""} onChange={(e) => set("address", e.target.value)} required /></Field>
            <Field label="Capacity (tonnes)"><Input type="number" value={f.capacityTonnes ?? ""} onChange={(e) => set("capacityTonnes", e.target.value)} required /></Field>
            <Field label="Commodities" hint="Comma-separated, e.g. MAIZE, SOYBEAN"><Input value={f.commodities ?? ""} onChange={(e) => set("commodities", e.target.value)} required /></Field>
          </div>
          {error && <Notice tone="bad">{error}</Notice>}
          <Button type="submit" disabled={busy}>{busy ? "Checking…" : "Continue"}</Button>
        </form>
      )}
    </Panel>
  );
}
