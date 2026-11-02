"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ADMIN_ROLES, ADMIN_ROLE_LABEL, USER_TYPE_LABEL, type AdminRole, type UserType } from "@tradechainx/shared";
import { api, ApiError } from "@/lib/api";
import { fromApi, type Call } from "@/lib/calls";
import type { PreparedCallJson } from "@/lib/types";
import { addr } from "@/lib/format";
import { TxButton } from "@/components/TxButton";
import { downloadSafeBatch } from "@/lib/safe";
import { Button, Input, Notice, PageHeader, Panel, Spinner } from "@/components/ui";

type Person = { id: string; email: string; userType: UserType | null; orgName: string | null; walletAddress: string | null; adminRoles: AdminRole[] };

export default function PeoplePage() {
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");
  const { data, isLoading, refetch } = useQuery({ queryKey: ["adminUsers", search], queryFn: () => api<{ users: Person[] }>(`/admin/users?q=${encodeURIComponent(search)}`) });
  return (
    <>
      <PageHeader title="People & roles" intro="Admin roles need two steps: save them here, then record them on-chain from the Super Admin account. The contracts only honour roles recorded on-chain." />
      <form className="mb-6 flex gap-2" onSubmit={(e) => { e.preventDefault(); setSearch(q); }}>
        <Input placeholder="Search by email, business or account" value={q} onChange={(e) => setQ(e.target.value)} className="max-w-md" />
        <Button type="submit" variant="secondary">Search</Button>
      </form>
      {isLoading && <Spinner />}
      <div className="space-y-3">
        {data?.users.map((u) => <PersonRow key={u.id} u={u} onDone={() => void refetch()} />)}
      </div>
    </>
  );
}

function PersonRow({ u, onDone }: { u: Person; onDone: () => void }) {
  const [roles, setRoles] = useState<AdminRole[]>(u.adminRoles);
  const [calls, setCalls] = useState<Call[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const changed = roles.slice().sort().join() !== u.adminRoles.slice().sort().join();

  async function save() {
    setError(null);
    try {
      const res = await api<{ onchainCalls: PreparedCallJson[] }>(`/admin/users/${u.id}/roles`, { method: "PUT", body: { roles } });
      setCalls(res.onchainCalls.map(fromApi));
      onDone();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't save.");
    }
  }

  return (
    <Panel>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="font-semibold text-ink-900">{u.orgName ?? u.email}</p>
          <p className="text-sm text-slate">
            {u.email} · {u.userType ? USER_TYPE_LABEL[u.userType] : "team"} · {addr(u.walletAddress)}
          </p>
        </div>
        <Button variant="quiet" onClick={() => setOpen(!open)}>{open ? "Close" : `Roles (${u.adminRoles.length})`}</Button>
      </div>
      {open && (
        <div className="mt-4 border-t border-line pt-4">
          <div className="grid gap-2 sm:grid-cols-2">
            {ADMIN_ROLES.map((r) => (
              <label key={r} className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={roles.includes(r)} onChange={(e) => setRoles(e.target.checked ? [...roles, r] : roles.filter((x) => x !== r))} />
                {ADMIN_ROLE_LABEL[r]}
              </label>
            ))}
          </div>
          <p className="mt-3 text-xs text-slate-500">
            Keep duties separate: the person who proposes or submits something shouldn't also be the one who approves it. Super admin moves only through the multi-person admin account.
          </p>
          {error && <div className="mt-3"><Notice tone="bad">{error}</Notice></div>}
          <div className="mt-4 flex flex-wrap gap-2">
            <Button onClick={save} disabled={!changed}>Save roles</Button>
            {calls && calls.length > 0 && (
              <>
                <TxButton title="Record roles on-chain" label={`Record on-chain (${calls.length})`} doneText="Roles recorded." calls={calls} onDone={() => setCalls(null)} />
                <Button variant="secondary" onClick={() => downloadSafeBatch(calls, `Roles for ${u.email}`)}>Download for Safe</Button>
              </>
            )}
          </div>
        </div>
      )}
    </Panel>
  );
}
