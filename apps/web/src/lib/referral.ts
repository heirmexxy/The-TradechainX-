// Partner referral attribution. Partner widgets link here with ?ref=<code>; we keep the code for
// 30 days on this device and report it after a purchase so the partner gets credit.
import { api } from "./api";

const KEY = "tcx_ref";
const TTL_MS = 30 * 86_400_000;

export function captureReferral() {
  if (typeof window === "undefined") return;
  const ref = new URLSearchParams(window.location.search).get("ref");
  if (!ref || !/^[a-z0-9]{4,16}$/.test(ref)) return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify({ ref, at: Date.now() }));
  } catch {
    /* storage blocked — attribution is best-effort */
  }
}

function currentReferral(): string | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const { ref, at } = JSON.parse(raw) as { ref: string; at: number };
    return Date.now() - at < TTL_MS ? ref : null;
  } catch {
    return null;
  }
}

/** Call after a successful buy/subscribe. Never throws. */
export async function reportReferral(targetType: "listing" | "xown", targetId: string, txHash?: string) {
  const ref = typeof window === "undefined" ? null : currentReferral();
  if (!ref) return;
  try {
    await api("/referrals", { body: { ref, targetType, targetId, txHash } });
  } catch {
    /* best-effort */
  }
}
