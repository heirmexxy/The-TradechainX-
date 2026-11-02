import Fastify, { type FastifyError } from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import { ZodError } from "zod";
import { env } from "./env.ts";
import { HttpError } from "./lib/errors.ts";
import { authPlugin } from "./plugins/auth.ts";
import { authRoutes } from "./routes/auth.ts";
import { documentRoutes } from "./routes/documents.ts";
import { kycRoutes } from "./routes/kyc.ts";
import { draftRoutes } from "./routes/drafts.ts";
import { assetRoutes } from "./routes/assets.ts";
import { marketplaceRoutes } from "./routes/marketplace.ts";
import { portfolioRoutes } from "./routes/portfolio.ts";
import { adminRoutes } from "./routes/admin.ts";
import { directoryRoutes } from "./routes/directory.ts";
import { walletRoutes } from "./routes/wallet.ts";
import { rampRoutes } from "./routes/ramp.ts";
import { healthRoutes } from "./routes/health.ts";
import { partnerRoutes } from "./partner/routes.ts";
import { partnerAdminRoutes } from "./routes/partners.ts";
import { embedRoutes } from "./routes/embed.ts";
import { devRoutes } from "./dev/routes.ts";
import { pool } from "./db/client.ts";
import { publicClient } from "./chain.ts";

export async function buildApp() {
  const app = Fastify({
    logger: {
      level: env.NODE_ENV === "production" ? "info" : "debug",
      redact: ["req.headers.cookie", "req.headers.authorization", "res.headers['set-cookie']"],
    },
    trustProxy: env.NODE_ENV === "production",
    bodyLimit: 1024 * 1024,
  });

  // CORS: the web app (with cookies) everywhere; public embeds from any site (no cookies);
  // the partner API is server-to-server only (no browser access, so API keys never sit in a web page).
  await app.register(cors, () => (req: { url?: string }, cb: (e: Error | null, o: object) => void) => {
    const url = req.url ?? "";
    if (url.startsWith("/embed/") || url.startsWith("/.well-known/")) {
      return cb(null, { origin: "*", credentials: false, methods: ["GET"] });
    }
    if (url.startsWith("/partner/") || url.startsWith("/ramp/webhook")) return cb(null, { origin: false });
    cb(null, {
      origin: env.WEB_ORIGIN,
      credentials: true,
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
      allowedHeaders: ["Content-Type", "X-TradeChainX"],
    });
  });
  await app.register(cookie);
  await app.register(rateLimit, { global: true, max: 300, timeWindow: "1 minute" });
  await app.register(multipart);
  await app.register(authPlugin);

  app.addHook("onSend", async (_req, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("X-Frame-Options", "DENY");
  });

  app.setErrorHandler((err: FastifyError | Error, req, reply) => {
    if (err instanceof HttpError) return reply.status(err.statusCode).send({ error: err.code, message: err.message });
    if (err instanceof ZodError) {
      const first = err.issues[0];
      return reply.status(400).send({
        error: "invalid_input",
        message: first ? `${first.path.join(".") || "input"}: ${first.message}` : "Invalid input.",
        issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      });
    }
    const status = (err as FastifyError).statusCode;
    if (status && status < 500) return reply.status(status).send({ error: "request_error", message: err.message });
    req.log.error({ err }, "unhandled error");
    return reply.status(500).send({ error: "internal", message: "Something went wrong on our side. Please try again." });
  });

  app.get("/health", async () => {
    const [db, block] = await Promise.all([
      pool.query("select 1").then(() => "ok").catch(() => "down"),
      publicClient.getBlockNumber().then((b) => b.toString()).catch(() => null),
    ]);
    return { status: db === "ok" && block ? "ok" : "degraded", db, chainId: env.CHAIN_ID, block };
  });

  await app.register(authRoutes);
  await app.register(documentRoutes);
  await app.register(kycRoutes);
  await app.register(draftRoutes);
  await app.register(assetRoutes);
  await app.register(marketplaceRoutes);
  await app.register(portfolioRoutes);
  await app.register(adminRoutes);
  await app.register(directoryRoutes);
  await app.register(walletRoutes);
  await app.register(rampRoutes);
  await app.register(healthRoutes);
  await app.register(embedRoutes);
  await app.register(partnerAdminRoutes);
  if (env.PARTNER_API_ENABLED) await app.register(partnerRoutes, { prefix: "/partner/v1" });
  if (env.DEV_TOOLS) await app.register(devRoutes);

  return app;
}
