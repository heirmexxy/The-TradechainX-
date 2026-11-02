import Link from "next/link";
import { LinkButton } from "@/components/ui";
import { SEGMENTS } from "@/content/segments";
import { LiveStats } from "./LiveStats";

// Home page, structured on the StoryBrand framework in the PRD (§5, §6.2):
// hero → problem → guide → plan → who it's for → stakes → call to action.

export default function Home() {
  return (
    <>
      {/* Hero: the receipt itself is the most characteristic thing in this world, so it leads. */}
      <section className="overflow-hidden border-b border-line bg-white">
        <div className="mx-auto grid max-w-6xl items-center gap-12 px-4 py-16 sm:px-6 md:grid-cols-[1.1fr_0.9fr] md:py-24">
          <div>
            <h1 className="text-hero text-ink-900">Turn trade assets into capital. No crypto experience needed.</h1>
            <p className="mt-6 max-w-xl text-lg text-slate">
              Trade and finance warehouse receipts, purchase orders and carbon credits as verified digital assets —
              secured by blockchain, as simple as any app.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <LinkButton href="/login?new=1">Start trading</LinkButton>
              <LinkButton href="/how-it-works" variant="secondary">
                See how it works
              </LinkButton>
            </div>
            <p className="mt-6 text-sm text-slate-500">Now onboarding our first warehouses, traders and investors in Oyo State.</p>
          </div>
          <HeroReceipt />
        </div>
      </section>

      <LiveStats />

      {/* Problem */}
      <section className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
        <div className="grid gap-10 md:grid-cols-[0.8fr_1.2fr]">
          <h2 className="text-h1">Valuable assets, stuck on paper</h2>
          <div className="space-y-4 text-lg text-slate">
            <p>
              Warehouse receipts get pledged twice. Purchase orders sit unfunded for months. Carbon credits go unsold
              because buyers can't verify them.
            </p>
            <p>
              Meanwhile the businesses holding these assets can't reach the capital they've already earned — and
              investors who want real-economy returns can't find anything they can check for themselves.
            </p>
          </div>
        </div>
      </section>

      {/* Guide */}
      <section className="bg-ink text-white">
        <div className="mx-auto grid max-w-6xl gap-12 px-4 py-20 sm:px-6 md:grid-cols-2">
          <div>
            <h2 className="text-h1 text-white">We built the system we needed ourselves</h2>
            <p className="mt-4 text-ink-100">
              TradeChainX is built by Kitovu, which has worked with farmers, aggregators and warehouses in Oyo State
              since 2016. We've watched good harvests lose value in storage because the paperwork around them couldn't be
              trusted. So we made the paperwork impossible to fake.
            </p>
          </div>
          <ul className="space-y-5">
            {[
              ["Every participant is verified", "Individuals pass an ID check; warehouses, SMEs and lenders pass a full business check."],
              ["Nothing is issued without review", "Our compliance team approves each receipt, LPO and credit batch before it exists."],
              ["One asset, one owner, one pledge", "The rules are enforced in code: an asset can't be issued twice, sold twice or pledged twice."],
              ["Open to inspection", "Contract code, every transaction, and our independent audit report before full launch."],
            ].map(([t, d]) => (
              <li key={t} className="border-l-2 border-maize pl-4">
                <p className="font-semibold text-white">{t}</p>
                <p className="mt-1 text-sm text-ink-100">{d}</p>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* Plan — a real sequence, so it's numbered */}
      <section className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
        <h2 className="text-h1">Three steps</h2>
        <ol className="mt-10 grid gap-8 md:grid-cols-3">
          {[
            ["Sign up and verify", "Quick ID check. No wallet to set up — your secure account is created for you."],
            ["List or browse", "Warehouses and SMEs list receipts, LPOs or carbon credits. Traders and investors browse verified assets."],
            ["Trade and settle", "Buy, sell or fund in one step. Money and assets move together, automatically."],
          ].map(([t, d], i) => (
            <li key={t}>
              <span className="text-5xl font-semibold text-maize">{i + 1}</span>
              <p className="mt-3 text-h3">{t}</p>
              <p className="mt-2 text-slate">{d}</p>
            </li>
          ))}
        </ol>
      </section>

      {/* Who it's for */}
      <section className="border-y border-line bg-white">
        <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
          <h2 className="text-h1">Built for everyone in the trade</h2>
          <div className="mt-10 grid gap-px overflow-hidden rounded border border-line bg-line sm:grid-cols-2 lg:grid-cols-3">
            {SEGMENTS.map((s) => (
              <Link key={s.slug} href={`/for/${s.slug}`} className="group bg-white p-6 hover:bg-ink-50">
                <p className="text-sm font-semibold text-ink-500">{s.nav}</p>
                <p className="mt-2 font-semibold text-ink-900 group-hover:underline">{s.title}</p>
              </Link>
            ))}
          </div>
        </div>
      </section>

      {/* Stakes: without / with */}
      <section className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
        <div className="grid gap-6 md:grid-cols-2">
          <div className="rounded border border-line bg-white p-8">
            <h2 className="text-h2">Without TradeChainX</h2>
            <ul className="mt-5 space-y-3 text-slate">
              <li>Inventory sits idle while prices move against you.</li>
              <li>Cash-flow gaps between delivering and getting paid.</li>
              <li>Exposure to fake or double-pledged paper receipts.</li>
              <li>Shut out of financing and investors outside your town.</li>
            </ul>
          </div>
          <div className="rounded border-2 border-ink bg-white p-8">
            <h2 className="text-h2">With TradeChainX</h2>
            <ul className="mt-5 space-y-3 text-ink-900">
              <li>Assets become capital in days, not months.</li>
              <li>Every receipt, LPO and credit is verified and financeable.</li>
              <li>Investors see exactly what they own and where it is.</li>
              <li>Payments settle automatically, in full view.</li>
            </ul>
          </div>
        </div>
        <div className="mt-14 flex flex-col items-start gap-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-h2">Ready when you are.</p>
          <div className="flex flex-wrap gap-3">
            <LinkButton href="/login?new=1">Start trading</LinkButton>
            <LinkButton href="/for/warehouses" variant="secondary">
              List your asset
            </LinkButton>
          </div>
        </div>
      </section>
    </>
  );
}

/** Illustrative receipt for the hero. Labelled as an example — it isn't live data. */
function HeroReceipt() {
  return (
    <figure className="relative mx-auto w-full max-w-sm md:rotate-[1.5deg]">
      <div className="certificate">
        <div className="px-6 pt-6">
          <div className="flex items-start justify-between">
            <p className="text-xs font-medium text-ink-500">Warehouse receipt / No. 0042</p>
            <span className="stamp text-xs">Verified</span>
          </div>
          <p className="mt-4 text-2xl font-semibold tracking-tight text-ink-900">Maize, Grade 1</p>
          <p className="text-4xl font-semibold tracking-tight text-ink-900">60,000 kg</p>
        </div>
        <dl className="grid grid-cols-2 gap-4 px-6 py-6 text-sm">
          <div>
            <dt className="text-xs text-slate-500">Stored at</dt>
            <dd className="font-medium text-ink-900">Iseyin Central Warehouse</dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500">Storage ends</dt>
            <dd className="font-medium text-ink-900">14 Mar 2027</dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500">Pledges</dt>
            <dd className="font-medium text-ink-900">None</dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500">Asking price</dt>
            <dd className="font-medium text-ink-900">18,000.00 USDC</dd>
          </div>
        </dl>
        <div className="perforation h-3" aria-hidden />
        <p className="border-t border-dashed border-ink-100 px-6 py-2 text-[11px] text-slate-500">Documents fingerprint 0x47bfeac24a39b662…e496f3</p>
      </div>
      <figcaption className="mt-3 text-center text-xs text-slate-500">Example receipt</figcaption>
    </figure>
  );
}
