import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Marketplace — warehouse receipts, LPOs and carbon credits",
  description: "Buy verified warehouse receipts, discounted purchase orders and registry-backed carbon credits. Payment and asset change hands in one step.",
  alternates: { canonical: "/marketplace" },
};

export default function MarketplaceLayout({ children }: { children: ReactNode }) {
  return children;
}
