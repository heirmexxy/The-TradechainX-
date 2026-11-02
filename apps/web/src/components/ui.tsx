import Link from "next/link";
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";

type Variant = "primary" | "secondary" | "quiet" | "danger";
const VARIANTS: Record<Variant, string> = {
  primary: "bg-ink text-white hover:bg-ink-700 disabled:bg-ink-500/60",
  secondary: "bg-white text-ink-900 border border-ink-100 hover:border-ink-500 disabled:text-slate-300",
  quiet: "text-ink-700 hover:bg-ink-50 disabled:text-slate-300",
  danger: "bg-white text-danger border border-danger/40 hover:bg-danger-100",
};
const base = "inline-flex items-center justify-center gap-2 rounded px-4 py-2.5 text-sm font-semibold transition-colors disabled:cursor-not-allowed";

export function Button({ variant = "primary", className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return <button {...props} className={`${base} ${VARIANTS[variant]} ${className}`} />;
}

export function LinkButton({ href, variant = "primary", className = "", children }: { href: string; variant?: Variant; className?: string; children: ReactNode }) {
  return (
    <Link href={href} className={`${base} ${VARIANTS[variant]} ${className}`}>
      {children}
    </Link>
  );
}

export function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="field-label">{label}</span>
      {children}
      {hint && !error && <span className="mt-1 block text-sm text-slate-500">{hint}</span>}
      {error && <span className="mt-1 block text-sm text-danger">{error}</span>}
    </label>
  );
}

export const Input = (p: InputHTMLAttributes<HTMLInputElement>) => <input {...p} className={`input ${p.className ?? ""}`} />;
export const Textarea = (p: TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea rows={3} {...p} className={`input ${p.className ?? ""}`} />;
export const Select = ({ children, ...p }: SelectHTMLAttributes<HTMLSelectElement>) => (
  <select {...p} className={`input pr-8 ${p.className ?? ""}`}>
    {children}
  </select>
);

const TONES = {
  neutral: "bg-ink-50 text-ink-700",
  good: "bg-leaf-100 text-leaf",
  warn: "bg-maize-100 text-maize-700",
  bad: "bg-danger-100 text-danger",
} as const;
export type Tone = keyof typeof TONES;

export function Pill({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${TONES[tone]}`}>{children}</span>;
}

export function Notice({ tone = "neutral", title, children }: { tone?: Tone; title?: string; children?: ReactNode }) {
  const border = { neutral: "border-ink-100", good: "border-leaf/30", warn: "border-maize/50", bad: "border-danger/30" }[tone];
  return (
    <div className={`rounded border ${border} ${TONES[tone].split(" ")[0]} px-4 py-3 text-sm text-slate`} role={tone === "bad" ? "alert" : undefined}>
      {title && <p className="font-semibold text-ink-900">{title}</p>}
      {children && <div className={title ? "mt-1" : ""}>{children}</div>}
    </div>
  );
}

export function PageHeader({ title, intro, actions }: { title: string; intro?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="mb-8 flex flex-wrap items-end justify-between gap-4">
      <div className="max-w-prose">
        <h1 className="text-h1">{title}</h1>
        {intro && <p className="mt-2 text-slate">{intro}</p>}
      </div>
      {actions && <div className="flex gap-2">{actions}</div>}
    </header>
  );
}

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="rounded border border-dashed border-line bg-white px-6 py-10 text-center">
      <p className="font-semibold text-ink-900">{title}</p>
      {children && <p className="mx-auto mt-1 max-w-md text-sm text-slate-500">{children}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Spinner({ label = "Loading" }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-2 text-sm text-slate-500" role="status">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-ink-100 border-t-ink" aria-hidden />
      {label}
    </span>
  );
}

/** Label/value pairs, e.g. on certificates and detail pages. */
export function Facts({ items, cols = 2 }: { items: [string, ReactNode][]; cols?: 2 | 3 }) {
  return (
    <dl className={`grid gap-x-6 gap-y-3 ${cols === 3 ? "sm:grid-cols-3" : "sm:grid-cols-2"}`}>
      {items.map(([k, v]) => (
        <div key={k}>
          <dt className="text-xs text-slate-500">{k}</dt>
          <dd className="mt-0.5 font-medium text-ink-900">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Panel({ title, children, actions }: { title?: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="rounded border border-line bg-white p-5">
      {(title || actions) && (
        <div className="mb-4 flex items-center justify-between gap-4">
          {title && <h2 className="text-h3">{title}</h2>}
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}
