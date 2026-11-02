import { SignJWT, jwtVerify } from "jose";
import { env } from "../env.ts";

const key = new TextEncoder().encode(env.JWT_SECRET);
export const SESSION_COOKIE = "tcx_session";
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

export async function signSession(userId: string): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuedAt()
    .setIssuer("tradechainx-api")
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(key);
}

export async function verifySession(token: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, key, { issuer: "tradechainx-api", algorithms: ["HS256"] });
    return typeof payload.sub === "string" ? payload.sub : null;
  } catch {
    return null;
  }
}
