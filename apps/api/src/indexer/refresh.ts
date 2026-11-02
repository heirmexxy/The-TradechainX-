// Reads current on-chain state for one record and returns the DB write that mirrors it.
// Reads happen before the batch transaction opens; writes run inside it.
import { and, desc, eq, sql } from "drizzle-orm";
import type { Address } from "viem";
import { schema, type Db } from "../db/client.ts";
import { publicClient, contracts, vaultAbi, assetTypeForAddress } from "../chain.ts";
import { receiptKey, lpoKey, batchKey } from "../lib/hash.ts";
import { jsonSafe } from "../lib/util.ts";
import type { RefreshKey } from "./effects.ts";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type Write = (tx: Tx) => Promise<void>;

type BurnReasons = Map<string, "redeemed" | "settled" | "voided" | "cancelled">;

const lc = (s: string) => s.toLowerCase();

async function tryRead<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch {
    return undefined;
  }
}

export async function refresh(k: RefreshKey, blockNumber: bigint, burns: BurnReasons): Promise<Write> {
  switch (k.kind) {
    // ------------------------------------------------------------------ identity
    case "identity": {
      const id = await publicClient.readContract({
        ...contracts.identityRegistry,
        functionName: "identityOf",
        args: [k.address as Address],
        blockNumber,
      });
      const row = {
        address: k.address,
        tier: Number(id.tier),
        validUntil: Number(id.validUntil),
        frozen: id.frozen,
        recordRef: id.recordRef,
        updatedBlock: Number(blockNumber),
      };
      return async (tx) => {
        await tx.insert(schema.identities).values(row).onConflictDoUpdate({ target: schema.identities.address, set: row });
      };
    }

    // ------------------------------------------------------------------ warehouse
    case "warehouse": {
      const w = await publicClient.readContract({
        ...contracts.warehouseRegistry,
        functionName: "getWarehouse",
        args: [k.id],
        blockNumber,
      });
      const row = {
        id: k.id.toString(),
        operator: lc(w.operator),
        licenceRef: w.licenceRef,
        active: w.active,
        metadataUri: w.metadataURI,
        updatedBlock: Number(blockNumber),
      };
      return async (tx) => {
        await tx.insert(schema.warehouses).values(row).onConflictDoUpdate({ target: schema.warehouses.id, set: row });
        await linkDraft(tx, "warehouse", w.licenceRef, k.id);
      };
    }

    // ------------------------------------------------------------------ submissions
    case "submission": {
      let row: typeof schema.submissions.$inferInsert;
      if (k.assetType === "warehouse-receipt") {
        const s = await publicClient.readContract({ ...contracts.warehouseReceipt, functionName: "getSubmission", args: [k.id], blockNumber });
        row = {
          assetType: k.assetType,
          submissionId: k.id.toString(),
          submitter: lc(s.submitter),
          holder: lc(s.holder),
          status: Number(s.status),
          keyHash: receiptKey(s.terms.warehouseId, s.terms.receiptNumberHash),
          tokenId: s.tokenId === 0n ? null : s.tokenId.toString(),
          terms: jsonSafe(s.terms) as Record<string, unknown>,
          updatedBlock: Number(blockNumber),
        };
      } else if (k.assetType === "lpo") {
        const s = await publicClient.readContract({ ...contracts.lpoToken, functionName: "getSubmission", args: [k.id], blockNumber });
        row = {
          assetType: k.assetType,
          submissionId: k.id.toString(),
          submitter: lc(s.submitter),
          holder: null,
          status: Number(s.status),
          keyHash: lpoKey(s.terms.buyerRefHash, s.terms.lpoNumberHash),
          tokenId: s.tokenId === 0n ? null : s.tokenId.toString(),
          terms: jsonSafe(s.terms) as Record<string, unknown>,
          updatedBlock: Number(blockNumber),
        };
      } else {
        const s = await publicClient.readContract({ ...contracts.carbonCredits, functionName: "getSubmission", args: [k.id], blockNumber });
        row = {
          assetType: k.assetType,
          submissionId: k.id.toString(),
          submitter: lc(s.submitter),
          holder: null,
          status: Number(s.status),
          keyHash: batchKey(s.terms.registry, s.terms.registryBatchIdHash),
          tokenId: s.batchId === 0n ? null : s.batchId.toString(),
          terms: jsonSafe(s.terms) as Record<string, unknown>,
          updatedBlock: Number(blockNumber),
        };
      }
      return async (tx) => {
        const draftId = await linkDraft(tx, k.assetType, row.keyHash, k.id);
        const full = { ...row, draftId };
        await tx
          .insert(schema.submissions)
          .values(full)
          .onConflictDoUpdate({ target: [schema.submissions.assetType, schema.submissions.submissionId], set: full });
      };
    }

    // ------------------------------------------------------------------ assets
    case "asset": {
      const base = { assetType: k.assetType, tokenId: k.id.toString(), updatedBlock: Number(blockNumber) };

      if (k.assetType === "carbon") {
        const c = contracts.carbonCredits;
        const [batch, originator, supply, retired, suspended] = await Promise.all([
          publicClient.readContract({ ...c, functionName: "getBatch", args: [k.id], blockNumber }),
          publicClient.readContract({ ...c, functionName: "originatorOf", args: [k.id], blockNumber }),
          publicClient.readContract({ ...c, functionName: "totalSupply", args: [k.id], blockNumber }),
          publicClient.readContract({ ...c, functionName: "retiredOf", args: [k.id], blockNumber }),
          publicClient.readContract({ ...c, functionName: "suspended", args: [k.id], blockNumber }),
        ]);
        const row = {
          ...base,
          owner: null,
          originator: lc(originator),
          terms: jsonSafe(batch) as Record<string, unknown>,
          expiresAt: null,
          suspended,
          totalSupply: supply.toString(),
          retired: retired.toString(),
          lien: null,
          pendingRequest: null,
        };
        return async (tx) => {
          const draftId = await draftForSubmission(tx, "carbon", k.id, "tokenId");
          await upsertAsset(tx, { ...row, draftId, issuedBlock: Number(blockNumber) });
        };
      }

      const c = k.assetType === "warehouse-receipt" ? contracts.warehouseReceipt : contracts.lpoToken;
      const owner = await tryRead(() => publicClient.readContract({ ...c, functionName: "ownerOf", args: [k.id], blockNumber }));
      const submissionId = await publicClient.readContract({ ...c, functionName: "submissionOfToken", args: [k.id], blockNumber });

      if (!owner) {
        // Burned. Terms can no longer be read from the token, so take them from the original submission.
        const burnedAs = burns.get(`${k.assetType}:${k.id}`);
        const sub =
          k.assetType === "warehouse-receipt"
            ? await publicClient.readContract({ ...contracts.warehouseReceipt, functionName: "getSubmission", args: [submissionId], blockNumber })
            : await publicClient.readContract({ ...contracts.lpoToken, functionName: "getSubmission", args: [submissionId], blockNumber });
        const expiresAt = "expiryDate" in sub.terms ? Number(sub.terms.expiryDate) : Number((sub.terms as { dueDate: bigint }).dueDate);
        return async (tx) => {
          const [existing] = await tx
            .select()
            .from(schema.assets)
            .where(and(eq(schema.assets.assetType, k.assetType), eq(schema.assets.tokenId, base.tokenId)))
            .limit(1);
          const draftId = existing?.draftId ?? (await draftForSubmission(tx, k.assetType, submissionId, "submissionId"));
          await upsertAsset(tx, {
            ...base,
            owner: null,
            originator: existing?.originator ?? lc(sub.submitter),
            terms: existing?.terms ?? (jsonSafe(sub.terms) as Record<string, unknown>),
            expiresAt: existing?.expiresAt ?? expiresAt,
            burnedAs: burnedAs ?? existing?.burnedAs ?? null,
            lien: null,
            pendingRequest: null,
            submissionId: submissionId.toString(),
            draftId,
            issuedBlock: existing?.issuedBlock ?? Number(blockNumber),
          });
        };
      }

      const [lien, request] = await Promise.all([
        publicClient.readContract({ ...c, functionName: "getLien", args: [k.id], blockNumber }),
        publicClient.readContract({ ...c, functionName: "getStatusRequest", args: [k.id], blockNumber }),
      ]);
      let terms: Record<string, unknown>;
      let expiresAt: number;
      let originator: string;
      if (k.assetType === "warehouse-receipt") {
        const r = await publicClient.readContract({ ...contracts.warehouseReceipt, functionName: "getReceipt", args: [k.id], blockNumber });
        terms = jsonSafe(r) as Record<string, unknown>;
        expiresAt = Number(r.expiryDate);
        const s = await publicClient.readContract({ ...contracts.warehouseReceipt, functionName: "getSubmission", args: [submissionId], blockNumber });
        originator = lc(s.submitter);
      } else {
        const l = await publicClient.readContract({ ...contracts.lpoToken, functionName: "getLPO", args: [k.id], blockNumber });
        terms = jsonSafe(l) as Record<string, unknown>;
        expiresAt = Number(l.dueDate);
        originator = lc(await publicClient.readContract({ ...contracts.lpoToken, functionName: "originatorOf", args: [k.id], blockNumber }));
      }
      const hasLien = lc(lien.lienholder) !== "0x0000000000000000000000000000000000000000";
      const row = {
        ...base,
        owner: lc(owner),
        originator,
        terms,
        expiresAt,
        burnedAs: null,
        lien: hasLien ? { lienholder: lc(lien.lienholder), maturity: Number(lien.maturity), agreementRef: lien.agreementRef } : null,
        pendingRequest: Number(request.kind) === 0 ? null : (jsonSafe({ ...request, kind: Number(request.kind) }) as { kind: number; requester: string }),
        submissionId: submissionId.toString(),
      };
      return async (tx) => {
        const draftId = await draftForSubmission(tx, k.assetType, submissionId, "submissionId");
        await upsertAsset(tx, { ...row, draftId, issuedBlock: Number(blockNumber) });
      };
    }

    // ------------------------------------------------------------------ carbon balances
    case "carbonBalance": {
      const amount = await publicClient.readContract({
        ...contracts.carbonCredits,
        functionName: "balanceOf",
        args: [k.holder as Address, k.batchId],
        blockNumber,
      });
      return async (tx) => {
        if (amount === 0n) {
          await tx
            .delete(schema.carbonBalances)
            .where(and(eq(schema.carbonBalances.batchId, k.batchId.toString()), eq(schema.carbonBalances.holder, k.holder)));
          return;
        }
        const row = { batchId: k.batchId.toString(), holder: k.holder, amount: amount.toString() };
        await tx
          .insert(schema.carbonBalances)
          .values(row)
          .onConflictDoUpdate({ target: [schema.carbonBalances.batchId, schema.carbonBalances.holder], set: row });
      };
    }

    // ------------------------------------------------------------------ listings
    case "listing": {
      const l = await publicClient.readContract({ ...contracts.marketplace, functionName: "getListing", args: [k.id], blockNumber });
      const assetType = assetTypeForAddress(l.asset) ?? "unknown";
      const row = {
        listingId: k.id.toString(),
        seller: lc(l.seller),
        assetType,
        assetAddress: lc(l.asset),
        tokenId: l.tokenId.toString(),
        remaining: l.remaining.toString(),
        pricePerUnit: l.pricePerUnit.toString(),
        feeBps: Number(l.feeBps),
        active: l.active,
        updatedBlock: Number(blockNumber),
      };
      return async (tx) => {
        await tx
          .insert(schema.listings)
          .values({ ...row, createdBlock: Number(blockNumber) })
          .onConflictDoUpdate({ target: schema.listings.listingId, set: row });
      };
    }

    // ------------------------------------------------------------------ XOwn
    case "offering": {
      const p = await publicClient.readContract({ ...contracts.xownFactory, functionName: "getProposal", args: [k.proposalId], blockNumber });
      const vault = lc(p.vault) === "0x0000000000000000000000000000000000000000" ? null : lc(p.vault);
      const row = {
        proposalId: k.proposalId.toString(),
        vault,
        proposer: lc(p.proposer),
        operator: lc(p.terms.operator),
        name: p.terms.name,
        symbol: p.terms.symbol,
        maxShares: p.terms.maxShares.toString(),
        pricePerShare: p.terms.pricePerShare.toString(),
        deadline: Number(p.terms.subscriptionDeadline),
        proposalStatus: Number(p.status),
        equipment: jsonSafe(p.terms.equipment) as Record<string, unknown>,
        updatedBlock: Number(blockNumber),
      };
      return async (tx) => {
        const draftId = await linkDraft(tx, "xown", p.terms.equipment.serialHash, k.proposalId);
        await tx
          .insert(schema.xownOfferings)
          .values({ ...row, draftId })
          .onConflictDoUpdate({ target: schema.xownOfferings.proposalId, set: { ...row, draftId } });
      };
    }

    case "vault": {
      const v = { address: k.vault as Address, abi: vaultAbi };
      const [state, supply, yieldTotal, proceeds, equipmentId] = await Promise.all([
        publicClient.readContract({ ...v, functionName: "state", blockNumber }),
        publicClient.readContract({ ...v, functionName: "totalSupply", blockNumber }),
        publicClient.readContract({ ...v, functionName: "totalYieldDeposited", blockNumber }),
        publicClient.readContract({ ...v, functionName: "dissolutionProceeds", blockNumber }),
        publicClient.readContract({ ...v, functionName: "equipmentId", blockNumber }),
      ]);
      return async (tx) => {
        // Shares sold only grows during fundraising; after dissolution supply shrinks as holders redeem.
        await tx
          .update(schema.xownOfferings)
          .set({
            vaultState: Number(state),
            sharesSold: sql`GREATEST(${schema.xownOfferings.sharesSold}, ${supply.toString()}::numeric)`,
            totalYield: yieldTotal.toString(),
            proceeds: proceeds.toString(),
            equipmentId: equipmentId.toString(),
            updatedBlock: Number(blockNumber),
          })
          .where(eq(schema.xownOfferings.vault, k.vault));
      };
    }

    case "holding": {
      const shares = await publicClient.readContract({
        address: k.vault as Address,
        abi: vaultAbi,
        functionName: "balanceOf",
        args: [k.holder as Address],
        blockNumber,
      });
      return async (tx) => {
        if (shares === 0n) {
          await tx.delete(schema.xownHoldings).where(and(eq(schema.xownHoldings.vault, k.vault), eq(schema.xownHoldings.holder, k.holder)));
          return;
        }
        const row = { vault: k.vault, holder: k.holder, shares: shares.toString() };
        await tx
          .insert(schema.xownHoldings)
          .values(row)
          .onConflictDoUpdate({ target: [schema.xownHoldings.vault, schema.xownHoldings.holder], set: row });
      };
    }
  }
}

// ---------------------------------------------------------------- helpers

async function upsertAsset(tx: Tx, row: typeof schema.assets.$inferInsert) {
  const { issuedBlock: _keepOriginal, ...update } = row;
  await tx
    .insert(schema.assets)
    .values(row)
    .onConflictDoUpdate({ target: [schema.assets.assetType, schema.assets.tokenId], set: update });
}

/** Links the newest draft with this key to the on-chain record. Returns the draft id, if any. */
async function linkDraft(tx: Tx, assetType: string, keyHash: string, onchainId: bigint): Promise<string | null> {
  const [draft] = await tx
    .select({ id: schema.drafts.id, submissionId: schema.drafts.submissionId })
    .from(schema.drafts)
    .where(and(eq(schema.drafts.assetType, assetType as never), eq(schema.drafts.keyHash, keyHash)))
    .orderBy(desc(schema.drafts.createdAt))
    .limit(1);
  if (!draft) return null;
  if (draft.submissionId !== onchainId.toString()) {
    await tx.update(schema.drafts).set({ submissionId: onchainId.toString(), updatedAt: new Date() }).where(eq(schema.drafts.id, draft.id));
  }
  return draft.id;
}

async function draftForSubmission(tx: Tx, assetType: string, id: bigint, by: "submissionId" | "tokenId"): Promise<string | null> {
  const col = by === "submissionId" ? schema.submissions.submissionId : schema.submissions.tokenId;
  const [s] = await tx
    .select({ draftId: schema.submissions.draftId })
    .from(schema.submissions)
    .where(and(eq(schema.submissions.assetType, assetType), eq(col, id.toString())))
    .limit(1);
  return s?.draftId ?? null;
}
