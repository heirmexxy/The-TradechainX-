// DEVELOPMENT ONLY — registered only when DEV_TOOLS=true (refused in production by loadEnv).
import type { FastifyInstance } from "fastify";
import { requireWallet } from "../plugins/auth.ts";
import { fundDevWallet } from "./faucet.ts";

export async function devRoutes(app: FastifyInstance) {
  /** Top up the signed-in user's wallet with gas (local chain) and 100,000 mock USDC. */
  app.post("/dev/faucet", async (req) => {
    const user = requireWallet(req);
    await fundDevWallet(user.walletAddress as `0x${string}`);
    return { ok: true };
  });
}
