import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { LinkButton } from "@/components/ui";
import { SEGMENTS, segmentBySlug } from "@/content/segments";

export function generateStaticParams() {
  return SEGMENTS.map((s) => ({ segment: s.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ segment: string }> }): Promise<Metadata> {
  const s = segmentBySlug((await params).segment);
  if (!s) return {};
  return { title: s.title, description: s.metaDescription, alternates: { canonical: `/for/${s.slug}` } };
}

export default async function SegmentPage({ params }: { params: Promise<{ segment: string }> }) {
  const s = segmentBySlug((await params).segment);
  if (!s) notFound();
  return (
    <article>
      <header className="border-b border-line bg-white">
        <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
          <p className="text-sm font-semibold text-ink-500">For {s.nav.toLowerCase()}</p>
          <h1 className="mt-3 max-w-3xl text-hero">{s.title}</h1>
          <p className="mt-6 max-w-2xl text-lg text-slate">{s.lede}</p>
          <div className="mt-8">
            <LinkButton href={s.cta.href}>{s.cta.label}</LinkButton>
          </div>
        </div>
      </header>

      <section className="mx-auto grid max-w-6xl gap-10 px-4 py-16 sm:px-6 md:grid-cols-[0.8fr_1.2fr]">
        <h2 className="text-h1">The problem</h2>
        <div className="space-y-4 text-lg text-slate">
          {s.problem.map((p) => (
            <p key={p}>{p}</p>
          ))}
        </div>
      </section>

      <section className="border-y border-line bg-white">
        <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
          <h2 className="text-h1">How it works</h2>
          <ol className="mt-10 grid gap-8 md:grid-cols-3">
            {s.plan.map(([t, d], i) => (
              <li key={t}>
                <span className="text-5xl font-semibold text-maize">{i + 1}</span>
                <p className="mt-3 text-h3">{t}</p>
                <p className="mt-2 text-slate">{d}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
        <h2 className="text-h1">What you get</h2>
        <ul className="mt-8 grid gap-4 md:grid-cols-3">
          {s.outcomes.map((o) => (
            <li key={o} className="border-l-2 border-leaf bg-white px-5 py-4 font-medium text-ink-900">
              {o}
            </li>
          ))}
        </ul>
        <div className="mt-12">
          <LinkButton href={s.cta.href}>{s.cta.label}</LinkButton>
        </div>
      </section>
    </article>
  );
}
