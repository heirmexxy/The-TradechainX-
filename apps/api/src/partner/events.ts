// Partner webhook events, derived from the on-chain events the indexer processes.
//
// Audience:
//   public — market-level facts anyone can see on the TradeChainX site (listings, offerings, issuance).
//   own    — facts about the partner's own account wallet (its submissions, its settlements, its buys).
// Deliveries are enqueued inside the indexer's transaction, so each event is queued exactly once
// even if the indexer restarts; the dispatcher then delivers with retries.
import { and, eq } from "drizzle-orm";
import { env } from "../env.ts";
import { db, schema } from "../db/client.ts";
import type { DecodedEvent } from "../indexer/decode.ts";
import { jsonSafe } from "../lib/util.ts";

export const EVENT_TYPES = {
  "submission.received": "Your submission reached the review queue (own)",
  "submission.needs_info": "A reviewer asked for more information on your submission (own)",
  "submission.rejected": "Your submission was rejected (own)",
  "asset.issued": "A new asset was approved and issued (public; also covers your own approvals)",
  "listing.created": "An asset was listed for sale (public)",
  "listing.sold": "A listing sold, fully or partly (public)",
  "listing.cancelled": "A listing was withdrawn (public)",
  "lpo.settled": "A purchase order was paid — on-chain in USDC or confirmed off-chain (own: holder or payer)",
  "xown.offering_created": "A new XOwn offering opened for subscriptions (public)",
  "xown.subscribed": "Your account bought XOwn shares (own)",
  "xown.offering_funded": "An XOwn offering was fully subscribed (public)",
  "xown.offering_failed": "An XOwn offering closed without filling; investors can claim refunds (public)",
  "xown.yield_deposited": "Earnings were paid into an XOwn offering (public)",
  "carbon.retired": "Your account retired carbon credits (own)",
} as const;
export type EventType = keyof typeof EVENT_TYPES;

export type PartnerEvent = {
  id: string;
  type: EventType;
  /** "public", or the lowercase addresses the event is about. */
  audience: "public" | string[];
  created: string;
  data: Record<string, unknown>;
};

const ASSET_TYPE: Record<string, string> = { WarehouseReceipt: "warehouse-receipt", LPOToken: "lpo", CarbonCredits: "carbon" };
const lc = (v: unknown) => String(v).toLowerCase();

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Map one decoded chain event to a partner event (or null if partners don't get it). */
async function toPartnerEvent(tx: Tx, e: DecodedEvent, time: Date): Promise<PartnerEvent | null> {
  const a = e.args;
  const base = { id: `evt_${env.CHAIN_ID}_${e.txHash}_${e.logIndex}`, created: time.toISOString() };
  const chain = { chainId: env.CHAIN_ID, txHash: e.txHash, blockNumber: e.blockNumber.toString(), contract: e.contract };
  const assetType = ASSET_TYPE[e.contractName];

  const submitterOf = async (submissionId: unknown): Promise<string[]> => {
    if (!assetType) return [];
    const [s] = await tx
      .select({ submitter: schema.submissions.submitter })
      .from(schema.submissions)
      .where(and(eq(schema.submissions.assetType, assetType), eq(schema.submissions.submissionId, String(submissionId))))
      .limit(1);
    return s ? [s.submitter] : [];
  };

  switch (e.event) {
    case "ReceiptSubmitted":
    case "LPOSubmitted":
    case "BatchSubmitted":
      return { ...base, type: "submission.received", audience: [lc(a.submitter)], data: { assetType, submissionId: String(a.submissionId), ...chain } };
    case "SubmissionInfoRequested":
      return { ...base, type: "submission.needs_info", audience: await submitterOf(a.submissionId), data: { assetType, submissionId: String(a.submissionId), reasonRef: a.reasonRef, ...chain } };
    case "SubmissionRejected":
      return { ...base, type: "submission.rejected", audience: await submitterOf(a.submissionId), data: { assetType, submissionId: String(a.submissionId), reasonRef: a.reasonRef, ...chain } };
    case "ReceiptIssued":
    case "LPOIssued":
      return { ...base, type: "asset.issued", audience: "public", data: { assetType, tokenId: String(a.tokenId), submissionId: String(a.submissionId), holder: lc(a.holder), ...chain } };
    case "BatchIssued":
      return { ...base, type: "asset.issued", audience: "public", data: { assetType, tokenId: String(a.batchId), submissionId: String(a.submissionId), originator: lc(a.originator), quantity: String(a.quantity), ...chain } };
    case "Listed":
      return { ...base, type: "listing.created", audience: "public", data: { listingId: String(a.listingId), seller: lc(a.seller), asset: lc(a.asset), tokenId: String(a.tokenId), amount: String(a.amount), pricePerUnit: String(a.pricePerUnit), ...chain } };
    case "Sold":
      return { ...base, type: "listing.sold", audience: "public", data: { listingId: String(a.listingId), buyer: lc(a.buyer), seller: lc(a.seller), amount: String(a.amount), totalPrice: String(a.totalPrice), fee: String(a.fee), ...chain } };
    case "ListingCancelled":
      return { ...base, type: "listing.cancelled", audience: "public", data: { listingId: String(a.listingId), ...chain } };
    case "LPOSettled":
      return { ...base, type: "lpo.settled", audience: [lc(a.holder), lc(a.payer)], data: { tokenId: String(a.tokenId), holder: lc(a.holder), payer: lc(a.payer), amount: String(a.amount), method: "onchain", ...chain } };
    case "LPOSettledOffChain":
      return { ...base, type: "lpo.settled", audience: [lc(a.holder)], data: { tokenId: String(a.tokenId), holder: lc(a.holder), method: "offchain", ...chain } };
    case "OfferingCreated":
      return { ...base, type: "xown.offering_created", audience: "public", data: { proposalId: String(a.proposalId), vault: lc(a.vault), ...chain } };
    case "Subscribed":
      return { ...base, type: "xown.subscribed", audience: [lc(a.investor)], data: { vault: e.contract, investor: lc(a.investor), shares: String(a.shares), paid: String(a.paid), ...chain } };
    case "FullySubscribed":
      return { ...base, type: "xown.offering_funded", audience: "public", data: { vault: e.contract, raised: String(a.raised), operator: lc(a.operator), ...chain } };
    case "OfferingFailed":
      return { ...base, type: "xown.offering_failed", audience: "public", data: { vault: e.contract, ...chain } };
    case "YieldDeposited":
      return { ...base, type: "xown.yield_deposited", audience: "public", data: { vault: e.contract, amount: String(a.amount), ...chain } };
    case "CreditsRetired":
      return { ...base, type: "carbon.retired", audience: [lc(a.holder)], data: { retirementId: String(a.retirementId), batchId: String(a.batchId), holder: lc(a.holder), amount: String(a.amount), ...chain } };
    default:
      return null;
  }
}

/** Called by the indexer inside its batch transaction. */
export async function enqueuePartnerEvents(tx: Tx, events: DecodedEvent[], blockTimes: Map<bigint, Date>) {
  if (!events.length) return;
  const hooks = await tx
    .select({ id: schema.webhooks.id, events: schema.webhooks.events, wallet: schema.users.walletAddress })
    .from(schema.webhooks)
    .innerJoin(schema.partners, eq(schema.partners.id, schema.webhooks.partnerId))
    .innerJoin(schema.users, eq(schema.users.id, schema.partners.accountUserId))
    .where(and(eq(schema.webhooks.active, true), eq(schema.partners.status, "active")));
  if (!hooks.length) return;

  for (const e of events) {
    const pe = await toPartnerEvent(tx, e, blockTimes.get(e.blockNumber) ?? new Date());
    if (!pe) continue;
    const payload = jsonSafe({ id: pe.id, type: pe.type, created: pe.created, livemode: env.NODE_ENV === "production", data: pe.data }) as Record<string, unknown>;
    const targets = hooks.filter(
      (h) =>
        (h.events.includes("*") || h.events.includes(pe.type)) &&
        (pe.audience === "public" || (!!h.wallet && pe.audience.includes(h.wallet.toLowerCase()))),
    );
    if (!targets.length) continue;
    await tx
      .insert(schema.webhookDeliveries)
      .values(targets.map((h) => ({ webhookId: h.id, eventId: pe.id, eventType: pe.type, payload })))
      .onConflictDoNothing();
  }
}

/** Queue a synthetic "ping" to one webhook (admin "Send test event"). */
export async function enqueueTestEvent(webhookId: string) {
  const id = `evt_test_${Date.now()}`;
  await db.insert(schema.webhookDeliveries).values({
    webhookId,
    eventId: id,
    eventType: "ping",
    payload: { id, type: "ping", created: new Date().toISOString(), livemode: env.NODE_ENV === "production", data: { message: "Test event from TradeChainX" } },
  });
  return id;
}

export const isEventType = (t: string): t is EventType => t in EVENT_TYPES;
