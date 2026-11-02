// Maps each decoded event to (a) what it's about, for the audit trail, (b) which records to refresh
// from chain state, and (c) the few facts only the event carries (burn reasons, trades, retirements).
import type { DecodedEvent } from "./decode.ts";

export type RefreshKey =
  | { kind: "identity"; address: string }
  | { kind: "warehouse"; id: bigint }
  | { kind: "submission"; assetType: "warehouse-receipt" | "lpo" | "carbon"; id: bigint }
  | { kind: "asset"; assetType: "warehouse-receipt" | "lpo" | "carbon"; id: bigint }
  | { kind: "carbonBalance"; batchId: bigint; holder: string }
  | { kind: "listing"; id: bigint }
  | { kind: "offering"; proposalId: bigint }
  | { kind: "vault"; vault: string }
  | { kind: "holding"; vault: string; holder: string };

export type Derived =
  | { kind: "burned"; assetType: "warehouse-receipt" | "lpo"; tokenId: bigint; as: "redeemed" | "settled" | "voided" | "cancelled" }
  | { kind: "trade"; listingId: bigint; buyer: string; seller: string; amount: bigint; total: bigint; fee: bigint }
  | { kind: "retirement"; retirementId: bigint; batchId: bigint; holder: string; amount: bigint; beneficiaryRef: string; reasonRef: string }
  | { kind: "kycVerified"; recordRef: string }
  | { kind: "newVault"; vault: string };

export type Effect = { entityType?: string; entityId?: string; refresh: RefreshKey[]; derived: Derived[] };

const ZERO = "0x0000000000000000000000000000000000000000";
const b = (v: unknown) => v as bigint;
const a = (v: unknown) => String(v).toLowerCase();

export function effectOf(e: DecodedEvent): Effect {
  const x = e.args;
  const none: Effect = { refresh: [], derived: [] };

  switch (e.contractName) {
    case "IdentityRegistry": {
      if (!("account" in x)) return none;
      const address = a(x.account);
      const derived: Derived[] = e.event === "IdentitySet" ? [{ kind: "kycVerified", recordRef: String(x.recordRef) }] : [];
      return { entityType: "identity", entityId: address, refresh: [{ kind: "identity", address }], derived };
    }

    case "WarehouseRegistry": {
      if (!("warehouseId" in x)) return none;
      const id = b(x.warehouseId);
      return { entityType: "warehouse", entityId: id.toString(), refresh: [{ kind: "warehouse", id }], derived: [] };
    }

    case "WarehouseReceipt":
    case "LPOToken": {
      const assetType = e.contractName === "WarehouseReceipt" ? "warehouse-receipt" : "lpo";
      if ("submissionId" in x && !("tokenId" in x)) {
        const id = b(x.submissionId);
        return { entityType: `${assetType}-submission`, entityId: id.toString(), refresh: [{ kind: "submission", assetType, id }], derived: [] };
      }
      if (!("tokenId" in x)) return none;
      const tokenId = b(x.tokenId);
      const refresh: RefreshKey[] = [{ kind: "asset", assetType, id: tokenId }];
      if ("submissionId" in x) refresh.push({ kind: "submission", assetType, id: b(x.submissionId) });
      const burnAs: Record<string, "redeemed" | "settled" | "voided" | "cancelled"> = {
        ReceiptRedeemed: "redeemed",
        ReceiptVoided: "voided",
        LPOSettled: "settled",
        LPOSettledOffChain: "settled",
        LPOCancelled: "cancelled",
      };
      const derived: Derived[] = burnAs[e.event] ? [{ kind: "burned", assetType, tokenId, as: burnAs[e.event]! }] : [];
      return { entityType: assetType, entityId: tokenId.toString(), refresh, derived };
    }

    case "CarbonCredits": {
      if (e.event === "TransferSingle" || e.event === "TransferBatch") {
        const ids = (e.event === "TransferSingle" ? [x.id] : (x.ids as unknown[])).map(b);
        const refresh: RefreshKey[] = [];
        for (const id of ids) {
          refresh.push({ kind: "asset", assetType: "carbon", id });
          for (const h of [a(x.from), a(x.to)]) if (h !== ZERO) refresh.push({ kind: "carbonBalance", batchId: id, holder: h });
        }
        return { entityType: "carbon", entityId: ids.length === 1 ? ids[0]!.toString() : undefined, refresh, derived: [] };
      }
      if ("submissionId" in x && !("batchId" in x)) {
        const id = b(x.submissionId);
        return { entityType: "carbon-submission", entityId: id.toString(), refresh: [{ kind: "submission", assetType: "carbon", id }], derived: [] };
      }
      if (!("batchId" in x)) return none;
      const batchId = b(x.batchId);
      const refresh: RefreshKey[] = [{ kind: "asset", assetType: "carbon", id: batchId }];
      if ("submissionId" in x) refresh.push({ kind: "submission", assetType: "carbon", id: b(x.submissionId) });
      const derived: Derived[] =
        e.event === "CreditsRetired"
          ? [
              {
                kind: "retirement",
                retirementId: b(x.retirementId),
                batchId,
                holder: a(x.holder),
                amount: b(x.amount),
                beneficiaryRef: String(x.beneficiaryRef),
                reasonRef: String(x.reasonRef),
              },
            ]
          : [];
      return { entityType: "carbon", entityId: batchId.toString(), refresh, derived };
    }

    case "Marketplace": {
      if (!("listingId" in x)) return none;
      const id = b(x.listingId);
      const derived: Derived[] =
        e.event === "Sold"
          ? [{ kind: "trade", listingId: id, buyer: a(x.buyer), seller: a(x.seller), amount: b(x.amount), total: b(x.totalPrice), fee: b(x.fee) }]
          : [];
      return { entityType: "listing", entityId: id.toString(), refresh: [{ kind: "listing", id }], derived };
    }

    case "XOwnFactory": {
      if (!("proposalId" in x)) return none;
      const proposalId = b(x.proposalId);
      const derived: Derived[] = e.event === "OfferingCreated" ? [{ kind: "newVault", vault: a(x.vault) }] : [];
      const refresh: RefreshKey[] = [{ kind: "offering", proposalId }];
      if (e.event === "OfferingCreated") refresh.push({ kind: "vault", vault: a(x.vault) });
      return { entityType: "xown-offering", entityId: proposalId.toString(), refresh, derived };
    }

    case "XOwnVault": {
      const vault = e.contract;
      const refresh: RefreshKey[] = [{ kind: "vault", vault }];
      if (e.event === "Transfer") {
        for (const h of [a(x.from), a(x.to)]) if (h !== ZERO) refresh.push({ kind: "holding", vault, holder: h });
      }
      return { entityType: "xown-vault", entityId: vault, refresh, derived: [] };
    }
  }
  return none;
}

export function refreshId(k: RefreshKey): string {
  switch (k.kind) {
    case "identity":
      return `identity:${k.address}`;
    case "warehouse":
      return `warehouse:${k.id}`;
    case "submission":
      return `submission:${k.assetType}:${k.id}`;
    case "asset":
      return `asset:${k.assetType}:${k.id}`;
    case "carbonBalance":
      return `carbonBalance:${k.batchId}:${k.holder}`;
    case "listing":
      return `listing:${k.id}`;
    case "offering":
      return `offering:${k.proposalId}`;
    case "vault":
      return `vault:${k.vault}`;
    case "holding":
      return `holding:${k.vault}:${k.holder}`;
  }
}
