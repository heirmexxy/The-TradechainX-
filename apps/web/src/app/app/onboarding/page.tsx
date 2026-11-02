"use client";

import { useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { KYC_REQUIREMENTS, KYC_STATUS_LABEL, USER_TYPES, USER_TYPE_LABEL, kycTrackFor, type UserType } from "@tradechainx/shared";
import { api, ApiError, type UploadedDocument } from "@/lib/api";
import { useSession } from "@/lib/session";
import { DocumentUpload } from "@/components/DocumentUpload";
import { Button, Field, Input, Notice, PageHeader, Panel, Select, Spinner } from "@/components/ui";

const TYPE_HELP: Record<UserType, string> = {
  trader: "You hold warehouse receipts and want to sell or borrow against them.",
  investor: "You want to buy assets or XOwn shares.",
  warehouse: "You operate a licensed warehouse and issue receipts.",
  sme: "You have purchase orders from buyers and want to be paid sooner.",
  originator: "You develop projects that produce registry-verified carbon credits.",
  lender: "You're a bank, microfinance bank or fund lending against pledged assets.",
};

export default function Onboarding() {
  const { data: user } = useSession();
  if (!user) return <Spinner />;
  return (
    <>
      <PageHeader title="Set up your account" intro="Two short steps. You only do this once." />
      <div className="space-y-6">
        <AccountType />
        {user.userType && <Verification />}
      </div>
    </>
  );
}

function AccountType() {
  const { data: user } = useSession();
  const qc = useQueryClient();
  const [type, setType] = useState<UserType | "">(user?.userType ?? "");
  const [name, setName] = useState(user?.displayName ?? "");
  const [org, setOrg] = useState(user?.orgName ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const locked = !!user?.userType && user.kyc.status !== "not_started";

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ user: unknown }>("/me", { method: "PATCH", body: { userType: type || undefined, displayName: name || undefined, orgName: org || undefined } });
      qc.setQueryData(["me"], res.user);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't save.");
    } finally {
      setBusy(false);
    }
  }

  const business = type && kycTrackFor(type) === "business";
  return (
    <Panel title="1. What will you use TradeChainX for?">
      <form onSubmit={save} className="space-y-5">
        <fieldset disabled={locked} className="grid gap-3 sm:grid-cols-2">
          <legend className="sr-only">Account type</legend>
          {USER_TYPES.map((t) => (
            <label key={t} className={`cursor-pointer rounded border p-4 ${type === t ? "border-ink bg-ink-50" : "border-line bg-white hover:border-ink-500"}`}>
              <input type="radio" name="type" value={t} checked={type === t} onChange={() => setType(t)} className="sr-only" />
              <span className="block font-semibold text-ink-900">{USER_TYPE_LABEL[t]}</span>
              <span className="mt-1 block text-sm text-slate">{TYPE_HELP[t]}</span>
            </label>
          ))}
        </fieldset>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Your name">
            <Input value={name} onChange={(e) => setName(e.target.value)} required />
          </Field>
          {business && (
            <Field label="Business name">
              <Input value={org} onChange={(e) => setOrg(e.target.value)} required />
            </Field>
          )}
        </div>
        {error && <Notice tone="bad">{error}</Notice>}
        <Button type="submit" disabled={busy || !type || !name}>
          {busy ? "Saving…" : user?.userType ? "Save changes" : "Continue"}
        </Button>
      </form>
    </Panel>
  );
}

type KycMe = { track: "individual" | "business" | null; requiredDocuments: string[]; case: { status: string; message: string | null } | null };

function Verification() {
  const { data: user } = useSession();
  const qc = useQueryClient();
  const { data: kyc } = useQuery({ queryKey: ["kyc"], queryFn: () => api<KycMe>("/kyc/me") });
  const [details, setDetails] = useState<Record<string, string>>({});
  const [docs, setDocs] = useState<UploadedDocument[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!user || !kyc || !kyc.track) return null;
  const status = user.kyc.status;
  if (status === "verified") {
    return (
      <Panel title="2. Verification">
        <Notice tone="good" title="Verified">You're all set.</Notice>
      </Panel>
    );
  }
  if (status === "pending") {
    return (
      <Panel title="2. Verification">
        <Notice title={KYC_STATUS_LABEL.pending}>We're checking your documents. This usually takes less than one working day.</Notice>
      </Panel>
    );
  }

  const fields = kyc.track === "individual" ? INDIVIDUAL_FIELDS : BUSINESS_FIELDS;
  const set = (k: string, v: string) => setDetails((d) => ({ ...d, [k]: v }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/kyc", { body: { details, documentIds: docs.map((d) => d.id) } });
      await qc.invalidateQueries({ queryKey: ["me"] });
      await qc.invalidateQueries({ queryKey: ["kyc"] });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't submit.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title="2. Verify your identity">
      {status === "needs_info" && (
        <div className="mb-5">
          <Notice tone="warn" title="We need a bit more from you">{user.kyc.message}</Notice>
        </div>
      )}
      {status === "rejected" && (
        <div className="mb-5">
          <Notice tone="bad" title="We couldn't verify you last time">You can try again with updated documents, or contact support.</Notice>
        </div>
      )}
      {!user.walletAddress && <Notice>Setting up your secure account first…</Notice>}
      <form onSubmit={submit} className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-2">
          {fields.map((f) => (
            <Field key={f.key} label={f.label} hint={f.hint}>
              {f.options ? (
                <Select value={details[f.key] ?? ""} onChange={(e) => set(f.key, e.target.value)} required>
                  <option value="">Choose…</option>
                  {f.options.map(([v, l]) => (
                    <option key={v} value={v}>{l}</option>
                  ))}
                </Select>
              ) : (
                <Input type={f.type ?? "text"} value={details[f.key] ?? ""} onChange={(e) => set(f.key, e.target.value)} required={!f.optional} maxLength={f.max} />
              )}
            </Field>
          ))}
        </div>
        <DocumentUpload kinds={KYC_REQUIREMENTS[kyc.track]} value={docs} onChange={setDocs} />
        {error && <Notice tone="bad">{error}</Notice>}
        <Button type="submit" disabled={busy || !user.walletAddress || KYC_REQUIREMENTS[kyc.track].some((r) => !docs.some((d) => d.kind === r.key))}>
          {busy ? "Submitting…" : "Submit for verification"}
        </Button>
        <p className="text-xs text-slate-500">Your documents are stored privately and seen only by our compliance team.</p>
      </form>
    </Panel>
  );
}

type F = { key: string; label: string; hint?: string; type?: string; optional?: boolean; max?: number; options?: [string, string][] };

const INDIVIDUAL_FIELDS: F[] = [
  { key: "fullName", label: "Full name (as on your ID)" },
  { key: "dateOfBirth", label: "Date of birth", type: "date" },
  { key: "nationality", label: "Nationality" },
  { key: "phone", label: "Phone number", type: "tel" },
  { key: "idType", label: "ID type", options: [["nin", "NIN slip"], ["passport", "International passport"], ["drivers_licence", "Driver's licence"], ["voters_card", "Voter's card"], ["other", "Other"]] },
  { key: "idLast4", label: "Last 4 characters of your ID number", max: 4, hint: "We don't store the full number." },
  { key: "address", label: "Home address" },
];

const BUSINESS_FIELDS: F[] = [
  { key: "companyName", label: "Registered business name" },
  { key: "registrationNumber", label: "CAC registration number" },
  { key: "country", label: "Country" },
  { key: "phone", label: "Business phone", type: "tel" },
  { key: "registeredAddress", label: "Registered address" },
  { key: "facilityAddress", label: "Facility address", optional: true, hint: "Warehouses: where the goods are stored." },
  { key: "signatoryName", label: "Authorised signatory" },
  { key: "signatoryRole", label: "Signatory's role" },
];
