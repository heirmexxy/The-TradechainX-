import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "XOwn — fractional ownership of farm machinery",
  description: "Own shares in working tractors and dryers run by verified operators in Nigeria. Earnings paid as the machine earns; full refunds if an offering doesn't fill.",
  alternates: { canonical: "/xown" },
};

export default function XOwnLayout({ children }: { children: ReactNode }) {
  return children;
}
