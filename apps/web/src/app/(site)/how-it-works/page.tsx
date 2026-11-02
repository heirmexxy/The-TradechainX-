import type { Metadata } from "next";
import { LinkButton } from "@/components/ui";

export const metadata: Metadata = {
  title: "How it works",
  description:
    "How TradeChainX turns warehouse receipts, LPOs and carbon credits into verified digital assets: verification, review, issuance, trading, pledging and settlement.",
  alternates: { canonical: "/how-it-works" },
};

const FLOWS: { title: string; steps: [string, string][] }[] = [
  {
    title: "Warehouse receipts",
    steps: [
      ["The goods go in", "A trader deposits a lot at a registered warehouse."],
      ["The warehouse submits the receipt", "With the scan and inspection report. Each receipt number can only be used once."],
      ["Our team reviews it", "A reviewer who isn't connected to the warehouse checks the documents and approves."],
      ["The trader receives it", "The digital receipt appears in the trader's account. It can be sold, pledged, or used to collect the goods."],
    ],
  },
  {
    title: "Purchase orders (LPOs)",
    steps: [
      ["The SME submits the LPO", "With the buyer's confirmation."],
      ["We confirm it", "Our reviewer checks the order with the buyer before approving."],
      ["Investors fund it", "The SME sells the LPO at a small discount and gets paid immediately."],
      ["The buyer pays", "When the buyer pays the face value, it goes straight to whoever holds the LPO."],
    ],
  },
  {
    title: "Carbon credits",
    steps: [
      ["The originator submits a registry batch", "A batch can only ever be tokenised once."],
      ["We check the registry", "Batches the registry cancels are frozen immediately."],
      ["Buyers purchase any amount", "Credits within a batch are interchangeable."],
      ["Buyers retire them", "Retired credits are burned forever, with a public record of who they offset."],
    ],
  },
];

export default function HowItWorks() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
      <h1 className="text-hero">How it works</h1>
      <p className="mt-6 max-w-prose text-lg text-slate">
        Every asset on TradeChainX follows the same rule: nothing exists until a verified issuer submits it and an
        independent reviewer approves it. After that, ownership, pledges and payments are enforced automatically.
      </p>

      {FLOWS.map((f) => (
        <section key={f.title} className="mt-16">
          <h2 className="text-h1">{f.title}</h2>
          <ol className="mt-8 grid gap-px overflow-hidden rounded border border-line bg-line md:grid-cols-4">
            {f.steps.map(([t, d], i) => (
              <li key={t} className="bg-white p-5">
                <span className="text-sm font-semibold text-maize-700">Step {i + 1}</span>
                <p className="mt-2 font-semibold text-ink-900">{t}</p>
                <p className="mt-1 text-sm text-slate">{d}</p>
              </li>
            ))}
          </ol>
        </section>
      ))}

      <section className="mt-16 grid gap-8 rounded bg-ink p-8 text-white md:grid-cols-2">
        <div>
          <h2 className="text-h2 text-white">Pledging for a loan</h2>
          <p className="mt-3 text-ink-100">
            Pledge a receipt or LPO to a verified lender. While it's pledged it can't be sold, moved or pledged again.
            When you repay, the lender releases it. If a loan isn't repaid by the agreed date, the lender can take the
            asset.
          </p>
        </div>
        <div>
          <h2 className="text-h2 text-white">XOwn: shares in real machines</h2>
          <p className="mt-3 text-ink-100">
            We list a tractor or dryer run by a verified operator. Investors buy shares. The operator only receives the
            money once the offering is fully funded — otherwise everyone is refunded. Hire income is paid out to
            shareholders as it comes in.
          </p>
        </div>
      </section>

      <div className="mt-12 flex gap-3">
        <LinkButton href="/login?new=1">Get started</LinkButton>
        <LinkButton href="/security" variant="secondary">
          Read about security
        </LinkButton>
      </div>
    </div>
  );
}
