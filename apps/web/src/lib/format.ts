import { formatUsdc, shortAddress } from "@tradechainx/shared";

export const usdc = (v: string | bigint | null | undefined) => (v == null ? "—" : `${formatUsdc(BigInt(v))} USDC`);
export const usdcPlain = (v: string | bigint | null | undefined) => (v == null ? "—" : formatUsdc(BigInt(v)));
export const addr = (a: string | null | undefined) => (a ? shortAddress(a) : "—");
export const num = (v: string | number | bigint | null | undefined) => (v == null ? "—" : Number(v).toLocaleString("en-US"));

export function date(v: number | string | Date | null | undefined) {
  if (v == null) return "—";
  const d = typeof v === "number" ? new Date(v * 1000) : new Date(v);
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

/** "in 12 days" / "3 days ago" */
export function relative(unixSeconds: number) {
  const days = Math.round((unixSeconds * 1000 - Date.now()) / 86_400_000);
  if (days === 0) return "today";
  return days > 0 ? `in ${days} day${days === 1 ? "" : "s"}` : `${-days} day${days === -1 ? "" : "s"} ago`;
}

export const toUnix = (isoDate: string) => BigInt(Math.floor(Date.parse(`${isoDate}T00:00:00Z`) / 1000));
