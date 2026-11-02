// Short-lived, signed identity tokens for the embedded-wallet provider (Privy, Dynamic, Sequence).
//
// The user signs in to TradeChainX once (email code). The web app then asks for a wallet token and
// hands it to the wallet provider, which verifies it against our public keys at
// /.well-known/jwks.json and silently creates or restores that user's wallet. The provider never runs
// its own login screen, and TradeChainX never sees wallet keys.
import { SignJWT, exportJWK, generateKeyPair, importPKCS8, importSPKI, type JWK, type KeyLike } from "jose";
import { createPublicKey } from "node:crypto";
import { env } from "../env.ts";

const ALG = "RS256";
const TTL_SECONDS = 10 * 60;

let signingKey: KeyLike | null = null;
let publicJwk: (JWK & { kid: string; alg: string; use: string }) | null = null;

async function keys() {
  if (signingKey && publicJwk) return { signingKey, publicJwk };
  const kid = env.WALLET_TOKEN_KID || "tcx-wallet-1";
  if (env.WALLET_TOKEN_PRIVATE_KEY) {
    const pem = env.WALLET_TOKEN_PRIVATE_KEY.replace(/\\n/g, "\n");
    signingKey = await importPKCS8(pem, ALG);
    const spki = createPublicKey(pem).export({ type: "spki", format: "pem" }).toString();
    publicJwk = { ...(await exportJWK(await importSPKI(spki, ALG))), kid, alg: ALG, use: "sig" };
  } else {
    if (env.NODE_ENV === "production") throw new Error("WALLET_TOKEN_PRIVATE_KEY is required in production");
    // Development: an ephemeral key. Wallet sessions reset when the API restarts, which is fine locally.
    const pair = await generateKeyPair(ALG, { extractable: true });
    signingKey = pair.privateKey;
    publicJwk = { ...(await exportJWK(pair.publicKey)), kid, alg: ALG, use: "sig" };
  }
  return { signingKey, publicJwk };
}

export async function jwks() {
  const { publicJwk } = await keys();
  return { keys: [publicJwk] };
}

export function issuer() {
  return env.PUBLIC_API_URL;
}

/** OIDC-style ID token for the wallet provider. `sub` is the stable TradeChainX user id. */
export async function walletToken(user: { id: string; email: string }) {
  const { signingKey, publicJwk } = await keys();
  const token = await new SignJWT({ email: user.email, email_verified: true })
    .setProtectedHeader({ alg: ALG, kid: publicJwk.kid, typ: "JWT" })
    .setIssuer(issuer())
    .setSubject(user.id)
    .setAudience(env.WALLET_TOKEN_AUDIENCE || "tradechainx-wallet")
    .setIssuedAt()
    .setExpirationTime(`${TTL_SECONDS}s`)
    .sign(signingKey);
  return { token, userId: user.id, expiresIn: TTL_SECONDS };
}
