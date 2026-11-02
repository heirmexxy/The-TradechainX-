import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { Tier } from "@tradechainx/shared";
import { db, schema } from "../db/client.ts";
import { requireUser } from "../plugins/auth.ts";
import { notFound } from "../lib/errors.ts";
import { identityIsValid } from "../services/profile.ts";

export async function directoryRoutes(app: FastifyInstance) {
  /**
   * Resolve a verified business or institution by email, so people can pledge to a lender or name an
   * operator without handling addresses. Individuals are never returned.
   */
  app.get("/directory/entity", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req) => {
    requireUser(req);
    const { email } = z.object({ email: z.string().email() }).parse(req.query);
    const [u] = await db.select().from(schema.users).where(eq(schema.users.email, email.trim().toLowerCase())).limit(1);
    if (!u?.walletAddress) throw notFound("No verified business uses that email.");
    const [id] = await db.select().from(schema.identities).where(eq(schema.identities.address, u.walletAddress)).limit(1);
    if (!identityIsValid(id) || (id!.tier !== Tier.Business && id!.tier !== Tier.Institutional)) {
      throw notFound("No verified business uses that email.");
    }
    return { address: u.walletAddress, name: u.orgName ?? u.displayName ?? email, tier: id!.tier };
  });
}
