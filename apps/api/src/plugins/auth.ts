import type { FastifyInstance, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { eq } from "drizzle-orm";
import type { AdminRole } from "@tradechainx/shared";
import { db, schema } from "../db/client.ts";
import { SESSION_COOKIE, verifySession } from "../auth/session.ts";
import { forbidden, unauthorized, HttpError } from "../lib/errors.ts";

export type User = typeof schema.users.$inferSelect;

declare module "fastify" {
  interface FastifyRequest {
    user: User | null;
  }
}

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Routes that are not called by our web app with the session cookie, so the CSRF header doesn't apply:
 * provider webhooks (signature-verified), the partner API (bearer API key) and public embeds (read-only).
 */
export const NON_BROWSER_PREFIXES = ["/health", "/ramp/webhook", "/partner/", "/embed/"];
const isNonBrowser = (url: string) => NON_BROWSER_PREFIXES.some((p) => url.startsWith(p));

/**
 * Loads the signed-in user from the session cookie on every request.
 *
 * CSRF: the session is an httpOnly SameSite=Lax cookie, and every state-changing request must carry
 * `X-TradeChainX: 1`. Browsers can't add custom headers cross-origin without a CORS preflight, which
 * only the configured web origin passes.
 */
export const authPlugin = fp(async (app: FastifyInstance) => {
  app.decorateRequest("user", null);

  app.addHook("onRequest", async (req) => {
    if (isNonBrowser(req.url)) return; // no cookie session on these routes
    if (MUTATING.has(req.method) && req.headers["x-tradechainx"] !== "1") {
      throw new HttpError(403, "csrf", "Missing request header.");
    }
    const token = req.cookies[SESSION_COOKIE];
    if (!token) return;
    const userId = await verifySession(token);
    if (!userId) return;
    const [user] = await db.select().from(schema.users).where(eq(schema.users.id, userId)).limit(1);
    req.user = user ?? null;
  });
});

export function requireUser(req: FastifyRequest): User {
  if (!req.user) throw unauthorized();
  return req.user;
}

export function requireWallet(req: FastifyRequest): User & { walletAddress: string } {
  const user = requireUser(req);
  if (!user.walletAddress) throw new HttpError(409, "wallet_required", "Your account wallet isn't set up yet.");
  return user as User & { walletAddress: string };
}

/** Admin screens. The on-chain role is what actually authorises each action; this gates the UI/API. */
export function requireAdmin(req: FastifyRequest, ...roles: AdminRole[]): User {
  const user = requireUser(req);
  const has = user.adminRoles.includes("super_admin") || roles.some((r) => user.adminRoles.includes(r));
  if (!has) throw forbidden();
  return user;
}
