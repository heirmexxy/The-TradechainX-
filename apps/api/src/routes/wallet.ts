import type { FastifyInstance } from "fastify";
import type { Address } from "viem";
import { env } from "../env.ts";
import { requireUser, requireWallet } from "../plugins/auth.ts";
import { jwks, issuer, walletToken } from "../auth/walletToken.ts";
import { topUpGas } from "../services/gasStation.ts";

export async function walletRoutes(app: FastifyInstance) {
  // Public keys the wallet provider uses to verify our tokens. Configure this URL in the provider dashboard.
  app.get("/.well-known/jwks.json", async (_req, reply) => {
    reply.header("Cache-Control", "public, max-age=300").header("Access-Control-Allow-Origin", "*");
    return jwks();
  });

  // Minimal OIDC discovery document for providers that look up the JWKS through it (e.g. Sequence).
  app.get("/.well-known/openid-configuration", async (_req, reply) => {
    reply.header("Cache-Control", "public, max-age=300").header("Access-Control-Allow-Origin", "*");
    return {
      issuer: issuer(),
      jwks_uri: `${issuer()}/.well-known/jwks.json`,
      id_token_signing_alg_values_supported: ["RS256"],
      subject_types_supported: ["public"],
      response_types_supported: ["id_token"],
      claims_supported: ["sub", "email", "email_verified", "iss", "aud", "exp", "iat"],
    };
  });

  /** A 10-minute token proving "this is TradeChainX user X", for the embedded-wallet provider. */
  app.post("/auth/wallet-token", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req) => {
    const user = requireUser(req);
    return { ...(await walletToken(user)), provider: env.WALLET_PROVIDER };
  });

  /** Ask the gas station for a top-up (no-op when gas sponsorship is used instead). */
  app.post("/me/gas", { config: { rateLimit: { max: 5, timeWindow: "1 hour" } } }, async (req) => {
    const user = requireWallet(req);
    return { result: await topUpGas(user.walletAddress as Address) };
  });
}
