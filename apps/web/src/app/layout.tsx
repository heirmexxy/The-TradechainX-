import type { Metadata } from "next";
import type { ReactNode } from "react";
import { IBM_Plex_Sans } from "next/font/google";
import { Providers } from "./providers";
import "./globals.css";

const plex = IBM_Plex_Sans({ subsets: ["latin"], weight: ["400", "500", "600", "700"], variable: "--font-plex", display: "swap" });

const SITE_URL = "https://tradechainx.com";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: "TradeChainX — Turn warehouse receipts, LPOs and carbon credits into capital",
    template: "%s · TradeChainX",
  },
  description:
    "Trade and finance verified warehouse receipts, purchase orders (LPOs) and carbon credits in Nigeria and across Africa. No crypto experience needed.",
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    siteName: "TradeChainX",
    url: SITE_URL,
    title: "Turn trade assets into capital",
    description: "Verified warehouse receipts, LPOs and carbon credits you can trade and finance — simple as any app.",
  },
};

// Organization structured data (PRD §7) — also disambiguates from unrelated "TCX" crypto projects.
const orgJsonLd = {
  "@context": "https://schema.org",
  "@type": "Organization",
  name: "TradeChainX",
  legalName: "Kitovu Technology Company Limited",
  url: SITE_URL,
  description: "Platform for trading and financing verified warehouse receipts, LPOs and carbon credits.",
  address: { "@type": "PostalAddress", addressRegion: "Oyo State", addressCountry: "NG" },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={plex.variable}>
      <body>
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(orgJsonLd) }} />
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
