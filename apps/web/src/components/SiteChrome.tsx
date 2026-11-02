"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { useSession, isAdmin } from "@/lib/session";

const NAV = [
  { href: "/marketplace", label: "Marketplace" },
  { href: "/xown", label: "XOwn" },
  { href: "/how-it-works", label: "How it works" },
  { href: "/security", label: "Security" },
];

export function Wordmark({ light }: { light?: boolean }) {
  return (
    <Link href="/" className={`flex items-center gap-2 font-semibold tracking-tight ${light ? "text-white" : "text-ink-900"}`}>
      <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden>
        <rect x="1" y="1" width="20" height="20" rx="2" fill="none" stroke="currentColor" strokeWidth="2" />
        <path d="M5 8h12M5 12h8M5 16h5" stroke="#E0A526" strokeWidth="2" strokeLinecap="round" />
      </svg>
      TradeChainX
    </Link>
  );
}

export function SiteHeader() {
  const { data: user } = useSession();
  const path = usePathname();
  const [open, setOpen] = useState(false);
  return (
    <header className="border-b border-line bg-white">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-6 px-4 py-4 sm:px-6">
        <Wordmark />
        <nav className="hidden items-center gap-6 text-sm md:flex" aria-label="Main">
          {NAV.map((n) => (
            <Link key={n.href} href={n.href} className={`hover:text-ink-900 ${path?.startsWith(n.href) ? "font-semibold text-ink-900" : "text-slate"}`}>
              {n.label}
            </Link>
          ))}
        </nav>
        <div className="hidden items-center gap-3 md:flex">
          {user ? (
            <>
              {isAdmin(user) && (
                <Link href="/admin" className="text-sm text-slate hover:text-ink-900">
                  Admin
                </Link>
              )}
              <Link href="/app" className="rounded bg-ink px-4 py-2 text-sm font-semibold text-white hover:bg-ink-700">
                My account
              </Link>
            </>
          ) : (
            <>
              <Link href="/login" className="text-sm font-medium text-ink-900">
                Sign in
              </Link>
              <Link href="/login?new=1" className="rounded bg-ink px-4 py-2 text-sm font-semibold text-white hover:bg-ink-700">
                Get started
              </Link>
            </>
          )}
        </div>
        <button className="md:hidden" onClick={() => setOpen(!open)} aria-expanded={open} aria-label="Menu">
          <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden>
            <path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      {open && (
        <nav className="border-t border-line px-4 py-3 md:hidden" aria-label="Main">
          {[...NAV, user ? { href: "/app", label: "My account" } : { href: "/login", label: "Sign in" }].map((n) => (
            <Link key={n.href} href={n.href} className="block py-2 text-ink-900" onClick={() => setOpen(false)}>
              {n.label}
            </Link>
          ))}
        </nav>
      )}
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="mt-24 bg-ink-900 text-ink-100">
      <div className="mx-auto grid max-w-6xl gap-10 px-4 py-14 sm:px-6 md:grid-cols-4">
        <div className="md:col-span-2">
          <Wordmark light />
          <p className="mt-3 max-w-sm text-sm text-ink-100/80">
            Verified warehouse receipts, purchase orders and carbon credits you can trade and finance. Built by Kitovu Technology Company, Oyo State, Nigeria.
          </p>
        </div>
        <FooterCol title="For" links={[["/for/traders", "Traders"], ["/for/warehouses", "Warehouses"], ["/for/smes", "SMEs"], ["/for/investors", "Investors"], ["/for/institutions", "Banks & DFIs"]]} />
        <FooterCol title="Platform" links={[["/marketplace", "Marketplace"], ["/xown", "XOwn"], ["/how-it-works", "How it works"], ["/security", "Security & trust"]]} />
      </div>
      <div className="border-t border-white/10">
        <p className="mx-auto max-w-6xl px-4 py-5 text-xs text-ink-100/60 sm:px-6">
          TradeChainX is operated by Kitovu Technology Company Limited. Digital assets represent claims on real goods and obligations; their value depends on those goods and counterparties.
        </p>
      </div>
    </footer>
  );
}

function FooterCol({ title, links }: { title: string; links: [string, string][] }) {
  return (
    <div>
      <p className="text-sm font-semibold text-white">{title}</p>
      <ul className="mt-3 space-y-2 text-sm">
        {links.map(([href, label]) => (
          <li key={href}>
            <Link href={href} className="text-ink-100/80 hover:text-white">
              {label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
