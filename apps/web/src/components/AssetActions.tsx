"use client";

import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { keccak256, toBytes, type Address } from "viem";
import { parseUsdc, ReceiptRequestKind, LpoRequestKind, RECEIPT_REQUEST_LABEL, LPO_REQUEST_LABEL, carbonCreditsAbi } from "@tradechainx/shared";
import { api, ApiError } from "@/lib/api";
import { ADDRESSES, publicClient } from "@/lib/chain";
import { calls, type Call } from "@/lib/calls";
import type { AssetView } from "@/lib/types";
import { date, num, relative, toUnix, usdc } from "@/lib/format";
import { useSession } from "@/lib/session";
import { TxButton } from "./TxButton";
import { Field, Input, Notice, Panel, Select } from "./ui";

const ref = (text: string) => keccak256(toBytes(text.trim() || "none"));

type Warehouse = { operator?: string } | null;

/** What the signed-in person can do with this asset, based on how they relate to it. */
export function AssetActions({ asset, warehouse, onChanged }: { asset: AssetView; warehouse: Warehouse; onChanged: () => void }) {
  const { data: user } = useSession();
  const me = user?.walletAddress?.toLowerCase();
  const { data: carbonBalance } = useQuery({
    queryKey: ["carbonBalance", asset.tokenId, me],
    enabled: asset.assetType === "carbon" && !!me,
    queryFn: () =>
      publicClient.readContract({ address: ADDRESSES.carbonCredits, abi: carbonCreditsAbi, functionName: "balanceOf", args: [me as Address, BigInt(asset.tokenId)] }),
  });

  if (!user || !me) return null;
  const id = BigInt(asset.tokenId);
  const isOwner = asset.owner === me;
  const isLienholder = asset.lien?.lienholder === me;
  const isOperator = asset.assetType === "warehouse-receipt" && warehouse?.operator === me;
  const isOriginator = asset.originator === me;
  const free = asset.status === "active";
  const req = asset.pendingRequest;

  const panels: ReactNode[] = [];

  // ---------------------------------------------------------------- holder of a receipt or LPO
  if (isOwner && free && asset.assetType !== "carbon") {
    panels.push(<SellPanel key="sell" asset={asset} amountMax={1n} onDone={onChanged} />);
    panels.push(<PledgePanel key="pledge" asset={asset} onDone={onChanged} />);
    if (asset.assetType === "warehouse-receipt") panels.push(<RedeemPanel key="redeem" asset={asset} onDone={onChanged} />);
    if (asset.assetType === "lpo") {
      panels.push(
        <SimpleRequest
          key="paid"
          title="The buyer paid you directly"
          intro="If the buyer paid outside TradeChainX, report it. Our team confirms and closes the LPO."
          placeholder="e.g. Bank transfer ref 12345 on 3 March"
          build={(note) => [calls.requestOffChainSettlement(id, ref(note))]}
          label="Report payment"
          doneText="Sent for review."
          onDone={onChanged}
        />,
      );
    }
  }

  if (req && req.requester === me) {
    panels.push(
      <Panel key="cancel" title="Your request is in review">
        <p className="mb-4 text-sm text-slate">
          {asset.assetType === "warehouse-receipt" ? RECEIPT_REQUEST_LABEL[req.kind] : LPO_REQUEST_LABEL[req.kind]}
          {asset.assetType === "warehouse-receipt" && [1, 2].includes(req.kind) && !req.warehouseConfirmed && " — waiting for the warehouse to confirm release."}
        </p>
        <TxButton variant="secondary" title="Cancel request" label="Cancel request" doneText="Request cancelled." calls={[calls.cancelRequest(asset.assetType as "warehouse-receipt" | "lpo", id)]} onDone={onChanged} />
      </Panel>,
    );
  }

  // ---------------------------------------------------------------- anyone can pay an LPO (usually the buyer or supplier)
  if (asset.assetType === "lpo" && free && user.identity?.active) {
    panels.push(
      <Panel key="settle" title="Pay this purchase order">
        <p className="mb-4 text-sm text-slate">
          Paying {usdc(asset.terms.faceValue)} sends it straight to the current holder and closes the LPO. Usually done by the buyer or supplier.
        </p>
        <TxButton title="Pay the purchase order" label={`Pay ${usdc(asset.terms.faceValue)}`} doneText="Paid and closed." calls={calls.settleLpo(id, BigInt(asset.terms.faceValue!))} onDone={onChanged} />
      </Panel>,
    );
  }

  // ---------------------------------------------------------------- lender
  if (isLienholder && asset.lien) {
    const matured = asset.lien.maturity * 1000 <= Date.now();
    panels.push(
      <Panel key="lien" title="You hold a pledge on this asset">
        <p className="mb-4 text-sm text-slate">Matures {date(asset.lien.maturity)} ({relative(asset.lien.maturity)}). Release it once the loan is repaid.</p>
        <div className="flex flex-wrap gap-2">
          <TxButton title="Release the pledge" label="Release pledge" doneText="Released." calls={[calls.releaseLien(asset.assetType as "warehouse-receipt" | "lpo", id)]} onDone={onChanged} />
          <TxButton
            variant="danger"
            title="Take ownership under the pledge"
            label="Take ownership"
            doneText="The asset is now yours."
            disabled={!matured}
            calls={[calls.enforceLien(asset.assetType as "warehouse-receipt" | "lpo", id)]}
            onDone={onChanged}
          />
        </div>
        {!matured && <p className="mt-2 text-xs text-slate-500">You can take ownership only after maturity if it hasn't been released.</p>}
      </Panel>,
    );
  }

  // ---------------------------------------------------------------- warehouse operator
  if (isOperator) {
    if (req && [ReceiptRequestKind.Redeem, ReceiptRequestKind.PartialRedeem].includes(req.kind as 1 | 2) && !req.warehouseConfirmed) {
      panels.push(
        <Panel key="confirm" title="The holder wants to collect goods">
          <p className="mb-4 text-sm text-slate">
            {req.kind === ReceiptRequestKind.Redeem ? "All goods" : `Leave ${num(req.newQuantity)} on the receipt`}. Confirm once the goods have left the warehouse.
          </p>
          <TxButton title="Confirm release" label="Confirm goods released" doneText="Confirmed. Our team will close it out." calls={[calls.confirmRelease(id)]} onDone={onChanged} />
        </Panel>,
      );
    }
    if (!req && asset.status !== "voided" && asset.status !== "redeemed") {
      panels.push(<WarehouseChangePanel key="whchange" asset={asset} onDone={onChanged} />);
    }
  }

  // ---------------------------------------------------------------- LPO supplier
  if (asset.assetType === "lpo" && isOriginator && !req && !asset.status.match(/settled|cancelled/)) {
    panels.push(<LpoChangePanel key="lpochange" asset={asset} onDone={onChanged} />);
  }

  // ---------------------------------------------------------------- carbon holder
  if (asset.assetType === "carbon" && carbonBalance && carbonBalance > 0n && !asset.suspended) {
    panels.push(<SellPanel key="sellc" asset={asset} amountMax={carbonBalance} onDone={onChanged} />);
    panels.push(<RetirePanel key="retire" asset={asset} max={carbonBalance} onDone={onChanged} />);
  }

  if (panels.length === 0) return null;
  return (
    <div className="space-y-6">
      {asset.assetType === "carbon" && carbonBalance ? <Notice>You hold {num(carbonBalance)} t from this batch.</Notice> : null}
      {panels}
    </div>
  );
}

// ---------------------------------------------------------------- panels

function SellPanel({ asset, amountMax, onDone }: { asset: AssetView; amountMax: bigint; onDone: () => void }) {
  const [price, setPrice] = useState("");
  const [amount, setAmount] = useState("");
  const carbon = asset.assetType === "carbon";
  return (
    <Panel title="Sell">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={carbon ? "Price per tonne (USDC)" : "Asking price (USDC)"}>
          <Input inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} placeholder={asset.assetType === "lpo" ? `Face value is ${usdc(asset.terms.faceValue)}` : ""} />
        </Field>
        {carbon && (
          <Field label="Tonnes to sell" hint={`Up to ${num(amountMax)}`}>
            <Input type="number" min={1} max={Number(amountMax)} value={amount} onChange={(e) => setAmount(e.target.value)} />
          </Field>
        )}
      </div>
      <p className="my-4 text-sm text-slate">
        While it's listed, the asset is held by the marketplace so it can't be sold twice. Cancel any time to get it back.
      </p>
      <TxButton
        title="Put it up for sale"
        label="List for sale"
        doneText="Listed. It's now on the marketplace."
        disabled={!price || (carbon && !amount)}
        calls={() => calls.list(asset.assetType, BigInt(asset.tokenId), carbon ? BigInt(amount) : 1n, parseUsdc(price))}
        onDone={onDone}
      />
    </Panel>
  );
}

function PledgePanel({ asset, onDone }: { asset: AssetView; onDone: () => void }) {
  const [email, setEmail] = useState("");
  const [maturity, setMaturity] = useState("");
  const [agreement, setAgreement] = useState("");
  const [lender, setLender] = useState<{ address: string; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function findLender() {
    setError(null);
    setLender(null);
    try {
      setLender(await api<{ address: string; name: string }>(`/directory/entity?email=${encodeURIComponent(email)}`));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't find that lender.");
    }
  }

  return (
    <Panel title="Pledge for a loan">
      <p className="mb-4 text-sm text-slate">
        Pledge this asset to a verified lender. It stays yours, but it can't be sold or moved until they release it. If the loan isn't repaid by the maturity date, the lender can take it.
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Lender's email" error={error ?? undefined} hint={lender ? `Found: ${lender.name}` : undefined}>
          <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} onBlur={() => email && findLender()} />
        </Field>
        <Field label="Loan matures on" hint={asset.expiresAt ? `Must be before ${date(asset.expiresAt)}` : undefined}>
          <Input type="date" value={maturity} onChange={(e) => setMaturity(e.target.value)} />
        </Field>
      </div>
      <div className="mt-4">
        <Field label="Loan agreement reference" hint="Only a fingerprint of this goes on record.">
          <Input value={agreement} onChange={(e) => setAgreement(e.target.value)} placeholder="e.g. MFB/LN/2026/0193" />
        </Field>
      </div>
      <div className="mt-4">
        <TxButton
          title="Pledge to lender"
          label="Pledge"
          doneText="Pledged."
          disabled={!lender || !maturity || !agreement}
          calls={() => [calls.grantLien(asset.assetType as "warehouse-receipt" | "lpo", BigInt(asset.tokenId), lender!.address as Address, toUnix(maturity), ref(agreement))]}
          onDone={onDone}
        />
      </div>
    </Panel>
  );
}

function RedeemPanel({ asset, onDone }: { asset: AssetView; onDone: () => void }) {
  const [mode, setMode] = useState<"all" | "part">("all");
  const [take, setTake] = useState("");
  const [note, setNote] = useState("");
  const total = Number(asset.terms.quantity);
  const remaining = mode === "all" ? 0 : total - Number(take || 0);
  return (
    <Panel title="Collect the goods">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="How much">
          <Select value={mode} onChange={(e) => setMode(e.target.value as "all" | "part")}>
            <option value="all">Everything ({num(total)})</option>
            <option value="part">Part of it</option>
          </Select>
        </Field>
        {mode === "part" && (
          <Field label="Quantity to collect">
            <Input type="number" min={1} max={total - 1} value={take} onChange={(e) => setTake(e.target.value)} />
          </Field>
        )}
      </div>
      <div className="mt-4">
        <Field label="Collection details" hint="Who's collecting and when. The warehouse confirms release, then our team approves.">
          <Input value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </div>
      <div className="mt-4">
        <TxButton
          title="Ask to collect"
          label="Request collection"
          doneText="Sent. The warehouse will confirm when the goods are released."
          disabled={mode === "part" && (!take || remaining <= 0 || remaining >= total)}
          calls={() => [calls.requestRedemption(BigInt(asset.tokenId), BigInt(remaining), ref(note))]}
          onDone={onDone}
        />
      </div>
    </Panel>
  );
}

function WarehouseChangePanel({ asset, onDone }: { asset: AssetView; onDone: () => void }) {
  const [kind, setKind] = useState<number>(ReceiptRequestKind.ExtendExpiry);
  const [newDate, setNewDate] = useState("");
  const [reason, setReason] = useState("");
  return (
    <Panel title="Warehouse changes">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Change">
          <Select value={kind} onChange={(e) => setKind(Number(e.target.value))}>
            <option value={ReceiptRequestKind.ExtendExpiry}>{RECEIPT_REQUEST_LABEL[ReceiptRequestKind.ExtendExpiry]}</option>
            <option value={ReceiptRequestKind.Void}>{RECEIPT_REQUEST_LABEL[ReceiptRequestKind.Void]} (goods lost or damaged)</option>
          </Select>
        </Field>
        {kind === ReceiptRequestKind.ExtendExpiry && (
          <Field label="New storage end date">
            <Input type="date" value={newDate} onChange={(e) => setNewDate(e.target.value)} />
          </Field>
        )}
      </div>
      <div className="mt-4">
        <Field label="Reason">
          <Input value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      </div>
      <div className="mt-4">
        <TxButton
          variant={kind === ReceiptRequestKind.Void ? "danger" : "primary"}
          title="Send change for review"
          label="Send for review"
          doneText="Sent for review."
          disabled={!reason || (kind === ReceiptRequestKind.ExtendExpiry && !newDate)}
          calls={() => [calls.requestWarehouseChange(BigInt(asset.tokenId), kind, kind === ReceiptRequestKind.ExtendExpiry ? toUnix(newDate) : 0n, ref(reason))]}
          onDone={onDone}
        />
      </div>
    </Panel>
  );
}

function LpoChangePanel({ asset, onDone }: { asset: AssetView; onDone: () => void }) {
  const [kind, setKind] = useState<number>(LpoRequestKind.ExtendDueDate);
  const [newDate, setNewDate] = useState("");
  const [reason, setReason] = useState("");
  return (
    <Panel title="Changes from the buyer">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="What happened">
          <Select value={kind} onChange={(e) => setKind(Number(e.target.value))}>
            <option value={LpoRequestKind.ExtendDueDate}>The buyer agreed a new due date</option>
            <option value={LpoRequestKind.Cancel}>The buyer cancelled the order</option>
          </Select>
        </Field>
        {kind === LpoRequestKind.ExtendDueDate && (
          <Field label="New due date">
            <Input type="date" value={newDate} onChange={(e) => setNewDate(e.target.value)} />
          </Field>
        )}
      </div>
      <div className="mt-4">
        <Field label="Details" hint="Attach the buyer's letter to your records; a fingerprint of this note goes on file.">
          <Input value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      </div>
      <div className="mt-4">
        <TxButton
          variant={kind === LpoRequestKind.Cancel ? "danger" : "primary"}
          title="Send change for review"
          label="Send for review"
          doneText="Sent for review."
          disabled={!reason || (kind === LpoRequestKind.ExtendDueDate && !newDate)}
          calls={() => [calls.requestLpoChange(BigInt(asset.tokenId), kind, kind === LpoRequestKind.ExtendDueDate ? toUnix(newDate) : 0n, ref(reason))]}
          onDone={onDone}
        />
      </div>
    </Panel>
  );
}

function RetirePanel({ asset, max, onDone }: { asset: AssetView; max: bigint; onDone: () => void }) {
  const [amount, setAmount] = useState("");
  const [beneficiary, setBeneficiary] = useState("");
  const [reason, setReason] = useState("");
  return (
    <Panel title="Retire credits">
      <p className="mb-4 text-sm text-slate">Retiring removes the credits from circulation permanently and records the offset. This can't be undone.</p>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Tonnes" hint={`Up to ${num(max)}`}>
          <Input type="number" min={1} max={Number(max)} value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <Field label="On behalf of" hint="The organisation claiming the offset.">
          <Input value={beneficiary} onChange={(e) => setBeneficiary(e.target.value)} />
        </Field>
      </div>
      <div className="mt-4">
        <Field label="Purpose">
          <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. 2026 company travel" />
        </Field>
      </div>
      <div className="mt-4">
        <TxButton
          title="Retire credits"
          label="Retire"
          doneText="Retired. The record is permanent."
          disabled={!amount || !beneficiary || BigInt(amount || "0") > max}
          calls={() => [calls.retire(BigInt(asset.tokenId), BigInt(amount), ref(beneficiary), ref(reason))]}
          onDone={onDone}
        />
      </div>
    </Panel>
  );
}

function SimpleRequest(p: { title: string; intro: string; placeholder: string; label: string; doneText: string; build: (note: string) => Call[]; onDone: () => void }) {
  const [note, setNote] = useState("");
  return (
    <Panel title={p.title}>
      <p className="mb-4 text-sm text-slate">{p.intro}</p>
      <Field label="Details">
        <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder={p.placeholder} />
      </Field>
      <div className="mt-4">
        <TxButton title={p.title} label={p.label} doneText={p.doneText} disabled={!note} calls={() => p.build(note)} onDone={p.onDone} />
      </div>
    </Panel>
  );
}
