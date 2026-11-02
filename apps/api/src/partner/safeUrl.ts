// Webhook URLs are supplied by partners, so we must not let them point the server at internal
// services (SSRF). HTTPS only in production, and the host must resolve to public addresses only.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { env } from "../env.ts";

function isPrivate(ip: string): boolean {
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase();
    if (v === "::1" || v === "::") return true;
    if (v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80")) return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
    return mapped ? isPrivate(mapped[1]!) : false;
  }
  const [a, b] = ip.split(".").map(Number) as [number, number];
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
  );
}

/** Throws a user-facing message if the URL isn't an acceptable webhook target. */
export async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Enter a full URL, e.g. https://example.com/webhooks/tradechainx");
  }
  const prod = env.NODE_ENV === "production";
  if (url.protocol !== "https:" && (prod || url.protocol !== "http:")) throw new Error("Webhook URLs must use https.");
  if (url.username || url.password) throw new Error("Don't put credentials in the webhook URL.");
  if (!prod) return url; // local development may target localhost receivers
  const host = url.hostname;
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) throw new Error("Webhook URL must be publicly reachable.");
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivate(a.address))) throw new Error("Webhook URL must resolve to a public address.");
  return url;
}
