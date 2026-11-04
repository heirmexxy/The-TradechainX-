// Distribution API v1 — mounted at /distribution/v1 when DISTRIBUTION_API_ENABLED=true.
// Reference: docs/DISTRIBUTION_API.md. Same API keys as the Partner API (scopes: read for GETs, trade for writes).
// Fintechs send naira-denominated orders for their own customers and never touch a chain.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { formatNaira, unitsToKg } from "@tradechainx/shared";
import { partnerAuth, requireScope } from "../partner/auth.ts";
import { HttpError } from "../lib/errors.ts";
import { buildDistributionService } from "./wiring.ts";
import type { Customer, Order, Quote } from "./model.ts";

const R = { config: { rateLimit: false } } as const; // partner keys have their own limits (partner/auth.ts)
const uuid = z.string().uuid();
const intString = z.string().regex(/^\d+$/, "must be an integer string").transform((s) => BigInt(s));

const customerBody = z.object({
  externalRef: z.string().min(1).max(128),
  tier: z.enum(["retail", "qualified", "institutional"]).default("retail"),
  kycVerified: z.boolean().default(false),
});
const quoteBody = z.object({ customerId: uuid, classId: uuid, side: z.enum(["buy", "sell", "buyback"]), units: intString });
const orderBody = z.object({ quoteId: uuid });

const kobo = (v: bigint) => ({ kobo: v.toString(), display: formatNaira(v) });

const customerView = (c: Customer) => ({
  id: c.id, externalRef: c.externalRef, tier: c.tier, kycStatus: c.kycStatus, walletReady: !!c.walletAddress,
});
const quoteView = (q: Quote) => ({
  id: q.id, customerId: q.customerId, classId: q.classId, side: q.side,
  units: q.units.toString(), kg: unitsToKg(q.units), pricePerKg: kobo(q.koboPerKg), total: kobo(q.totalKobo), expiresAt: q.expiresAt.toISOString(),
});
const orderView = (o: Order) => ({
  id: o.id, quoteId: o.quoteId, customerId: o.customerId, side: o.side, units: o.units.toString(), kg: unitsToKg(o.units),
  total: kobo(o.totalKobo), status: o.status, failureReason: o.failureReason, createdAt: o.createdAt.toISOString(),
});

export async function distributionRoutes(app: FastifyInstance) {
  app.addHook("onRequest", partnerAuth);
  const svc = buildDistributionService();
  const distributorId = (req: Parameters<typeof requireScope>[0], scope: "read" | "trade") => requireScope(req, scope).partner.id;

  app.get("/classes", R, async (req) => {
    distributorId(req, "read");
    const market = await svc.listMarket();
    return {
      classes: market.map((m) => ({
        id: m.class.id, name: m.class.displayName, tradable: m.tradable,
        referencePricePerKg: m.referenceKoboPerKg == null ? null : kobo(m.referenceKoboPerKg),
        publishedAt: m.publishedAt?.toISOString() ?? null,
        pricePerKg: m.quotesKoboPerKg && { buy: kobo(m.quotesKoboPerKg.buy), sell: kobo(m.quotesKoboPerKg.sell), buyback: kobo(m.quotesKoboPerKg.buyback) },
      })),
    };
  });

  app.post("/customers", R, async (req, reply) => {
    const id = distributorId(req, "trade");
    const body = customerBody.parse(req.body);
    const { customer, created } = await svc.createCustomer(id, body);
    return reply.status(created ? 201 : 200).send({ customer: customerView(customer) });
  });

  app.get("/customers/:id", R, async (req) => {
    const id = distributorId(req, "read");
    return { customer: customerView(await svc.getCustomer(id, uuid.parse((req.params as { id: string }).id))) };
  });

  app.post("/quotes", R, async (req, reply) => {
    const id = distributorId(req, "trade");
    return reply.status(201).send({ quote: quoteView(await svc.createQuote(id, quoteBody.parse(req.body))) });
  });

  app.post("/orders", R, async (req, reply) => {
    const id = distributorId(req, "trade");
    const key = req.headers["idempotency-key"];
    if (typeof key !== "string" || !key.trim()) throw new HttpError(400, "bad_request", "Send an Idempotency-Key header.");
    const { order, replayed } = await svc.createOrder(id, { quoteId: orderBody.parse(req.body).quoteId, idempotencyKey: key });
    return reply.status(replayed ? 200 : 201).header("Idempotent-Replay", String(replayed)).send({ order: orderView(order) });
  });

  app.get("/orders/:id", R, async (req) => {
    const id = distributorId(req, "read");
    return { order: orderView(await svc.getOrder(id, uuid.parse((req.params as { id: string }).id))) };
  });

  // The distributor has debited the customer's wallet; delivery of units then follows.
  app.post("/orders/:id/confirm-funds", R, async (req) => {
    const id = distributorId(req, "trade");
    return { order: orderView(await svc.confirmFunds(id, uuid.parse((req.params as { id: string }).id))) };
  });

  app.delete("/orders/:id", R, async (req) => {
    const id = distributorId(req, "trade");
    return { order: orderView(await svc.cancelOrder(id, uuid.parse((req.params as { id: string }).id))) };
  });
}
