// Add money (fiat → USDC) and withdraw (USDC → fiat) through the configured ramp provider.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { desc, eq, or } from "drizzle-orm";
import { db, schema } from "../db/client.ts";
import { env } from "../env.ts";
import { requireWallet } from "../plugins/auth.ts";
import { badRequest, forbidden, HttpError } from "../lib/errors.ts";
import { keepRawJson } from "../lib/rawBody.ts";
import { identityIsValid } from "../services/profile.ts";
import { ramp } from "../ramps/index.ts";

export async function rampRoutes(app: FastifyInstance) {
  app.get("/ramp/config", async () => {
    const r = safeRamp();
    return r
      ? { enabled: true, provider: r.name, directions: r.directions, currencies: r.currencies, countries: r.countries }
      : { enabled: false };
  });

  app.post("/ramp/sessions", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req) => {
    const user = requireWallet(req);
    const r = safeRamp();
    if (!r) throw new HttpError(404, "ramp_disabled", "Adding money isn't available yet.");
    const [id] = await db.select().from(schema.identities).where(eq(schema.identities.address, user.walletAddress)).limit(1);
    if (!identityIsValid(id)) throw forbidden("Finish verification before adding or withdrawing money.");

    const body = z
      .object({
        direction: z.enum(["deposit", "withdraw"]),
        fiatCurrency: z.string().length(3).transform((s) => s.toUpperCase()),
        fiatAmount: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
        usdcAmount: z.string().regex(/^\d+$/).optional(),
      })
      .parse(req.body);
    if (!r.directions.includes(body.direction)) throw badRequest(`${body.direction === "deposit" ? "Adding money" : "Withdrawing"} isn't available.`);
    if (!r.currencies.includes(body.fiatCurrency)) throw badRequest(`Supported currencies: ${r.currencies.join(", ")}.`);

    const [tx] = await db
      .insert(schema.rampTransactions)
      .values({
        userId: user.id,
        provider: r.name,
        direction: body.direction,
        status: "created",
        fiatCurrency: body.fiatCurrency,
        fiatAmount: body.fiatAmount ?? null,
        usdcAmount: body.usdcAmount ?? null,
        walletAddress: user.walletAddress,
      })
      .returning();
    const session = await r.createSession({
      txId: tx!.id,
      direction: body.direction,
      fiatCurrency: body.fiatCurrency,
      fiatAmount: body.fiatAmount,
      usdcAmount: body.usdcAmount,
      walletAddress: user.walletAddress,
      email: user.email,
      returnUrl: `${env.WEB_ORIGIN}/app/funds?tx=${tx!.id}`,
    });
    if (session.providerRef) {
      await db.update(schema.rampTransactions).set({ providerRef: session.providerRef, status: "pending" }).where(eq(schema.rampTransactions.id, tx!.id));
    }
    return { id: tx!.id, redirectUrl: session.redirectUrl ?? null, instructions: session.instructions ?? null };
  });

  app.get("/ramp/transactions", async (req) => {
    const user = requireWallet(req);
    const rows = await db
      .select()
      .from(schema.rampTransactions)
      .where(eq(schema.rampTransactions.userId, user.id))
      .orderBy(desc(schema.rampTransactions.createdAt))
      .limit(50);
    return {
      transactions: rows.map((t) => ({
        id: t.id,
        direction: t.direction,
        status: t.status,
        fiatCurrency: t.fiatCurrency,
        fiatAmount: t.fiatAmount,
        usdcAmount: t.usdcAmount,
        txHash: t.txHash,
        createdAt: t.createdAt,
      })),
    };
  });

  // Provider → us. Signed; exempt from the browser CSRF header (see plugins/auth.ts).
  await app.register(async (scope) => {
    keepRawJson(scope);
    scope.post("/ramp/webhook", { config: { rateLimit: { max: 600, timeWindow: "1 minute" } } }, async (req, reply) => {
      const r = safeRamp();
      if (!r) return reply.status(404).send({ error: "ramp_disabled" });
      let evt;
      try {
        evt = r.parseWebhook(req.rawBody ?? "", req.headers);
      } catch (e) {
        req.log.warn({ err: (e as Error).message }, "ramp webhook rejected");
        return reply.status(401).send({ error: "invalid_signature" });
      }
      const where = [
        evt.txId && /^[0-9a-f-]{36}$/i.test(evt.txId) ? eq(schema.rampTransactions.id, evt.txId) : undefined,
        evt.providerRef ? eq(schema.rampTransactions.providerRef, evt.providerRef) : undefined,
      ].filter(Boolean);
      if (where.length === 0) return reply.status(202).send({ ok: true, matched: false });
      const updated = await db
        .update(schema.rampTransactions)
        .set({
          status: evt.status,
          providerRef: evt.providerRef ?? undefined,
          usdcAmount: evt.usdcAmount ?? undefined,
          fiatAmount: evt.fiatAmount ?? undefined,
          txHash: evt.txHash ?? undefined,
          raw: evt.raw,
          updatedAt: new Date(),
        })
        .where(or(...(where as never[])))
        .returning({ id: schema.rampTransactions.id });
      return { ok: true, matched: updated.length > 0 };
    });
  });
}

function safeRamp() {
  try {
    return ramp();
  } catch {
    return null; // misconfiguration shows on the System health page
  }
}
