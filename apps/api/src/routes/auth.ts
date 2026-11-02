import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { getAddress, isAddress } from "viem";
import { USER_TYPES } from "@tradechainx/shared";
import { db, schema } from "../db/client.ts";
import { env } from "../env.ts";
import { issueCode, consumeCode, normalizeEmail } from "../auth/otp.ts";
import { signSession, SESSION_COOKIE, SESSION_TTL_SECONDS } from "../auth/session.ts";
import { mailer } from "../lib/mailer.ts";
import { badRequest, conflict, HttpError } from "../lib/errors.ts";
import { requireUser } from "../plugins/auth.ts";
import { publicClient } from "../chain.ts";
import { fundDevWallet } from "../dev/faucet.ts";
import { profileFor } from "../services/profile.ts";

const cookieOptions = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: env.NODE_ENV === "production",
  path: "/",
  maxAge: SESSION_TTL_SECONDS,
};

export async function authRoutes(app: FastifyInstance) {
  app.post(
    "/auth/request-code",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (req) => {
      const { email } = z.object({ email: z.string().email().max(254) }).parse(req.body);
      const e = normalizeEmail(email);
      const code = await issueCode(e);
      if (code) {
        await mailer.send(
          e,
          "Your TradeChainX sign-in code",
          `Your sign-in code is ${code}. It expires in 10 minutes.\n\nIf you didn't ask for this, you can ignore this email.`,
        );
      }
      // Same response whether or not the email exists or was rate-limited.
      return { ok: true, ...(env.DEV_SHOW_OTP && code ? { devCode: code } : {}) };
    },
  );

  app.post(
    "/auth/verify",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const body = z.object({ email: z.string().email(), code: z.string().regex(/^\d{6}$/) }).parse(req.body);
      const e = normalizeEmail(body.email);
      if (!(await consumeCode(e, body.code))) throw new HttpError(401, "invalid_code", "That code is wrong or has expired.");

      let [user] = await db.select().from(schema.users).where(eq(schema.users.email, e)).limit(1);
      if (!user) [user] = await db.insert(schema.users).values({ email: e }).returning();

      reply.setCookie(SESSION_COOKIE, await signSession(user!.id), cookieOptions);
      return { user: await profileFor(user!) };
    },
  );

  app.post("/auth/logout", async (_req, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.get("/me", async (req) => {
    const user = requireUser(req);
    return { user: await profileFor(user) };
  });

  app.patch("/me", async (req) => {
    const user = requireUser(req);
    const body = z
      .object({
        userType: z.enum(USER_TYPES).optional(),
        displayName: z.string().trim().min(1).max(120).optional(),
        orgName: z.string().trim().max(200).optional(),
      })
      .parse(req.body);

    if (body.userType && user.userType && body.userType !== user.userType) {
      const [kyc] = await db.select().from(schema.kycCases).where(eq(schema.kycCases.userId, user.id)).limit(1);
      if (kyc) throw conflict("Your account type is set once verification has started. Contact support to change it.");
    }
    const [updated] = await db
      .update(schema.users)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(schema.users.id, user.id))
      .returning();
    return { user: await profileFor(updated!) };
  });

  // ---------------------------------------------------------------- wallet binding
  // The embedded wallet is created in the browser (the API never sees keys). To attach it to the
  // account, the wallet signs a one-time challenge. Works for EOAs and smart accounts (ERC-1271/6492).

  app.post("/me/wallet/challenge", async (req) => {
    const user = requireUser(req);
    const { address } = z.object({ address: z.string().refine(isAddress, "Invalid address") }).parse(req.body);
    const nonce = randomBytes(16).toString("hex");
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    await db
      .insert(schema.walletChallenges)
      .values({ userId: user.id, nonce, expiresAt })
      .onConflictDoUpdate({ target: schema.walletChallenges.userId, set: { nonce, expiresAt } });
    return { message: challengeMessage(user.email, getAddress(address), nonce, expiresAt) };
  });

  app.post("/me/wallet", async (req) => {
    const user = requireUser(req);
    const body = z
      .object({
        address: z.string().refine(isAddress, "Invalid address"),
        signature: z.string().regex(/^0x[0-9a-fA-F]+$/),
      })
      .parse(req.body);
    const address = getAddress(body.address);

    if (user.walletAddress && user.walletAddress !== address.toLowerCase()) {
      throw conflict("This account already has a wallet. Contact support to change it.");
    }
    const [challenge] = await db
      .select()
      .from(schema.walletChallenges)
      .where(eq(schema.walletChallenges.userId, user.id))
      .limit(1);
    if (!challenge || challenge.expiresAt < new Date()) throw badRequest("The verification request expired. Try again.");

    const valid = await publicClient.verifyMessage({
      address,
      message: challengeMessage(user.email, address, challenge.nonce, challenge.expiresAt),
      signature: body.signature as `0x${string}`,
    });
    if (!valid) throw badRequest("The wallet signature didn't match.");

    const taken = await db.select().from(schema.users).where(eq(schema.users.walletAddress, address.toLowerCase())).limit(1);
    if (taken[0] && taken[0].id !== user.id) throw conflict("That wallet belongs to another account.");

    await db.delete(schema.walletChallenges).where(eq(schema.walletChallenges.userId, user.id));
    const [updated] = await db
      .update(schema.users)
      .set({ walletAddress: address.toLowerCase(), updatedAt: new Date() })
      .where(eq(schema.users.id, user.id))
      .returning();

    if (env.DEV_TOOLS) await fundDevWallet(address).catch((e) => req.log.warn({ err: e }, "dev faucet failed"));
    return { user: await profileFor(updated!) };
  });
}

function challengeMessage(email: string, address: string, nonce: string, expiresAt: Date) {
  return [
    "TradeChainX wallet verification",
    "",
    "Link this wallet to your TradeChainX account.",
    `Account: ${email}`,
    `Wallet: ${address}`,
    `Nonce: ${nonce}`,
    `Expires: ${expiresAt.toISOString()}`,
  ].join("\n");
}
