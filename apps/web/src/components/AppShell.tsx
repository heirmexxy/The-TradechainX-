"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { can, KYC_STATUS_LABEL } from "@tradechainx/shared";
import { useSession, useSignOut, hasRole, isAdmin, type Profile } from "@/lib/session";
import { useWallet } from "@/wallet/WalletProvider";
import { Wordmark } from "./SiteChrome";
import { Notice, Pill, Spinner } from "./ui";

type Item = { href: string; label: string; show?: (u: Profile) => boolean };

const APP_NAV: Item[] = [
  { href: "/app", label: "Home" },
  { href: "/app/portfolio", label: "Portfolio" },
  { href: "/marketplace", label: "Marketplace" },
  { href: "/xown", label: "XOwn" },
  { href: "/app/issue", label: "Issue an asset", show: (u) => !!u.userType && ["issue_receipts", "issue_lpos", "issue_carbon"].some((c) => can(u.userType!, c)) },
  { href: "/app/warehouse", label: "My warehouse", show: (u) => u.userType === "warehouse" },
  { href: "/app/financing", label: "Financing", show: (u) => u.userType === "lender" },
  { href: "/app/funds", label: "Add or withdraw money", show: (u) => !!u.walletAddress },
];

const ADMIN_NAV: Item[] = [
  { href: "/admin", label: "Overview" },
  { href: "/admin/kyc", label: "Verification", show: (u) => hasRole(u, "kyc_reviewer") },
  { href: "/admin/reviews", label: "Listing reviews", show: (u) => hasRole(u, "listing_reviewer") },
  { href: "/admin/requests", label: "Status changes", show: (u) => hasRole(u, "listing_reviewer") },
  { href: "/admin/warehouses", label: "Warehouses", show: (u) => hasRole(u, "warehouse_registrar") },
  { href: "/admin/xown", label: "XOwn offerings", show: (u) => hasRole(u, "asset_manager", "listing_reviewer") },
  { href: "/admin/people", label: "People & roles", show: (u) => hasRole(u, "super_admin") },
  { href: "/admin/controls", label: "Controls", show: (u) => hasRole(u, "pauser", "super_admin") },
  { href: "/admin/partners", label: "Partners", show: (u) => hasRole(u, "super_admin") },
  { href: "/admin/health", label: "System health" },
];

/** Signed-in layout for /app and /admin. Redirects to sign-in when there's no session. */
export function AppShell({ children, area }: { children: ReactNode; area: "app" | "admin" }) {
  const { data: user, isLoading } = useSession();
  const { status, error } = useWallet();
  const router = useRouter();
  const path = usePathname();
  const signOut = useSignOut();

  useEffect(() => {
    if (!isLoading && !user) router.replace(`/login?next=${encodeURIComponent(path ?? "/app")}`);
  }, [isLoading, user, router, path]);

  if (isLoading || !user) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (area === "admin" && !isAdmin(user)) {
    return (
      <div className="mx-auto max-w-md p-10">
        <Notice tone="bad" title="No admin access">
          This area is for the TradeChainX team. <Link href="/app" className="underline">Go to your account</Link>.
        </Notice>
      </div>
    );
  }

  const items = (area === "admin" ? ADMIN_NAV : APP_NAV).filter((i) => !i.show || i.show(user));
  return (
    <div className="min-h-screen md:grid md:grid-cols-[240px_1fr]">
      <aside className="border-b border-line bg-white md:min-h-screen md:border-b-0 md:border-r">
        <div className="flex items-center justify-between px-5 py-5">
          <Wordmark />
          {area === "admin" && <Pill tone="warn">Admin</Pill>}
        </div>
        <nav className="flex gap-1 overflow-x-auto px-3 pb-3 md:flex-col md:pb-0" aria-label={area === "admin" ? "Admin" : "Account"}>
          {items.map((i) => {
            const active = i.href === "/app" || i.href === "/admin" ? path === i.href : path?.startsWith(i.href);
            return (
              <Link
                key={i.href}
                href={i.href}
                className={`whitespace-nowrap rounded px-3 py-2 text-sm ${active ? "bg-ink-50 font-semibold text-ink-900" : "text-slate hover:bg-ink-50"}`}
              >
                {i.label}
              </Link>
            );
          })}
        </nav>
        <div className="hidden border-t border-line px-5 py-4 text-sm md:block">
          <p className="truncate font-medium text-ink-900">{user.displayName ?? user.email}</p>
          <p className="mt-0.5 text-slate-500">Verification: {KYC_STATUS_LABEL[user.kyc.status]}</p>
          <div className="mt-3 flex gap-3">
            {area === "app" && isAdmin(user) && (
              <Link href="/admin" className="text-ink-700 underline">
                Admin
              </Link>
            )}
            {area === "admin" && (
              <Link href="/app" className="text-ink-700 underline">
                My account
              </Link>
            )}
            <button className="text-ink-700 underline" onClick={async () => { await signOut(); router.push("/"); }}>
              Sign out
            </button>
          </div>
        </div>
      </aside>
      <main className="px-4 py-8 sm:px-8">
        {(status === "error" || status === "mismatch") && (
          <div className="mb-6">
            <Notice tone="bad" title="We couldn't finish setting up your account">
              {error}
            </Notice>
          </div>
        )}
        <div className="mx-auto max-w-5xl">{children}</div>
      </main>
    </div>
  );
}
