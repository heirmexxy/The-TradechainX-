import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Security & trust",
  description:
    "How TradeChainX protects participants: KYC/KYB verification, independent review of every asset, on-chain rules against double-pledging, non-custodial accounts, and independent audits.",
  alternates: { canonical: "/security" },
};

const SECTIONS: [string, string][] = [
  [
    "You control your account",
    "Your account is created for you when you sign up, and only you can authorise what it does. TradeChainX never holds your keys. Money moving between bank accounts and the platform goes through a licensed payments partner.",
  ],
  [
    "Everyone is verified",
    "Individuals pass an ID and liveness check. Warehouses, SMEs, carbon originators and lenders pass a full business check. Warehouses are separately checked against their operating licence before they can issue anything.",
  ],
  [
    "Two people for every issuance",
    "The person who submits an asset can never be the person who approves it. Reviewers can't approve anything they hold, issued or operate. These rules are enforced in the contracts, not just in our office.",
  ],
  [
    "No double-pledging, no duplicates",
    "Each receipt number, purchase order and registry batch can be issued once. An asset can carry one pledge at a time, and a pledged or listed asset can't move anywhere else.",
  ],
  [
    "Documents you can check",
    "Supporting documents are stored privately, and a fingerprint of them is recorded with the asset. Anyone given the documents can confirm they're exactly the ones that were reviewed.",
  ],
  [
    "An emergency stop",
    "If something looks wrong, our team can pause trading while it's investigated. Resuming needs sign-off from the company's multi-person admin account, so a single compromised login can't undo a pause.",
  ],
  [
    "Independent audit",
    "The smart contracts are open for review and will be independently audited before we scale beyond our pilot. The report and every fix will be published here.",
  ],
];

export default function Security() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
      <h1 className="text-hero">Security & trust</h1>
      <p className="mt-6 max-w-prose text-lg text-slate">
        Trade finance runs on trust. We'd rather you didn't have to extend it to us — so the important rules are built
        into the system where everyone can see them.
      </p>
      <div className="mt-12 grid gap-x-12 gap-y-10 md:grid-cols-2">
        {SECTIONS.map(([t, d]) => (
          <section key={t}>
            <h2 className="text-h3">{t}</h2>
            <p className="mt-2 text-slate">{d}</p>
          </section>
        ))}
      </div>
      <section className="mt-16 rounded border border-line bg-white p-6">
        <h2 className="text-h3">Audit status</h2>
        <p className="mt-2 text-slate">Independent audit: scheduled before mainnet launch. This page will link the report and remediation log.</p>
      </section>
    </div>
  );
}
