// Persona landing pages (PRD §6.3): the same StoryBrand skeleton with a problem, plan and call to
// action specific to each audience. Also the long-tail SEO pages (PRD §7).

export type Segment = {
  slug: string;
  nav: string;
  title: string; // <title> and H1
  metaDescription: string;
  lede: string;
  problem: string[];
  plan: [string, string][];
  outcomes: string[];
  cta: { label: string; href: string };
};

export const SEGMENTS: Segment[] = [
  {
    slug: "traders",
    nav: "Traders",
    title: "Get paid for your stored grain without waiting for a buyer",
    metaDescription:
      "Commodity traders and aggregators: turn warehouse receipts into cash by selling them or pledging them to a lender. Verified receipts, settled in USDC.",
    lede: "Your maize, soy or sorghum is sitting in a licensed warehouse. The receipt for it should be worth money today — not when a buyer finally turns up.",
    problem: [
      "Buyers want to inspect before they pay, and lenders don't trust paper receipts that can be copied or pledged twice.",
      "So the goods sit, prices move, and your working capital stays locked in a warehouse.",
    ],
    plan: [
      ["Deposit at a registered warehouse", "The warehouse issues your receipt on TradeChainX after our team checks it."],
      ["Sell it or pledge it", "List the receipt on the marketplace, or pledge it to a lender for a loan."],
      ["Collect the goods any time", "Whoever holds the receipt can collect the goods from the warehouse."],
    ],
    outcomes: ["Cash in days, not weeks", "A receipt no one can pledge twice", "Buyers who can check every detail themselves"],
    cta: { label: "Open a trader account", href: "/login?new=1" },
  },
  {
    slug: "warehouses",
    nav: "Warehouses",
    title: "Issue receipts that banks and buyers trust on sight",
    metaDescription:
      "Warehouse operators: issue fraud-proof digital warehouse receipts. Attract depositors and financiers with receipts that can't be duplicated or double-pledged.",
    lede: "A licensed warehouse is only as valuable as the receipts it issues. Make yours the ones lenders accept without a phone call.",
    problem: [
      "Paper receipts get photocopied, altered and pledged to more than one lender, and every fraud makes financiers wary of all warehouses.",
      "Depositors go where they can get financing. Without trusted receipts, they go elsewhere.",
    ],
    plan: [
      ["Register your facility", "We verify your licence and business before you can issue anything."],
      ["Issue receipts from your dashboard", "Enter the lot, attach the scan and inspection report, and send it for review."],
      ["Confirm collections", "When a holder comes for their goods, you confirm the release in one step."],
    ],
    outcomes: ["Each receipt number can only ever be issued once", "Your receipts become financeable for your depositors", "A complete, tamper-proof record of every lot"],
    cta: { label: "Register your warehouse", href: "/login?new=1" },
  },
  {
    slug: "smes",
    nav: "SMEs",
    title: "Working capital against the purchase orders you've already won",
    metaDescription:
      "LPO financing in Nigeria: SMEs and agribusinesses can sell confirmed purchase orders at a small discount and get paid now instead of in 60–90 days.",
    lede: "You've won the order. The buyer pays in 90 days. Your suppliers want paying this week.",
    problem: [
      "Banks want collateral you don't have, and invoice finance is slow and expensive.",
      "Meanwhile the LPO in your drawer is a promise from a creditworthy buyer — it just isn't liquid.",
    ],
    plan: [
      ["Submit the LPO", "Upload the purchase order and the buyer's confirmation. We check it with the buyer."],
      ["Sell it at a small discount", "Investors buy it on the marketplace and you receive USDC straight away."],
      ["The buyer pays as normal", "When the buyer pays the face value, it goes to whoever holds the LPO."],
    ],
    outcomes: ["Money for your suppliers now", "No new debt on your books", "Pricing set by investors, not a single lender"],
    cta: { label: "Finance an LPO", href: "/login?new=1" },
  },
  {
    slug: "investors",
    nav: "Investors",
    title: "Real returns from real trade — verified, not promised",
    metaDescription:
      "Invest in verified trade assets and productive equipment in Africa: discounted purchase orders, warehouse receipts and XOwn fractional machinery. No crypto experience needed.",
    lede: "Fund the trade that feeds Nigeria — purchase orders from known buyers, grain in licensed warehouses, and machines that earn every season.",
    problem: [
      "Most 'agri investment' platforms ask you to trust a promised return. Some of them disappeared with the money.",
      "You deserve to see exactly what you own, who owes it, and where the goods are.",
    ],
    plan: [
      ["Verify once", "A quick ID check. No wallet, seed phrase or crypto exchange needed."],
      ["Choose what to fund", "Every asset shows its documents, its issuer and its full history."],
      ["Get paid on-chain", "LPO payments and XOwn earnings land in your account automatically."],
    ],
    outcomes: ["No guaranteed-return gimmicks — real cash flows", "Every document fingerprinted and checkable", "Own a share of a working tractor or dryer and earn from its hire income"],
    cta: { label: "Join as an investor", href: "/login?new=1" },
  },
  {
    slug: "carbon",
    nav: "Carbon",
    title: "Carbon credits buyers can verify before they pay",
    metaDescription:
      "Carbon credit marketplace for Africa: list registry-verified credits, sell to verified buyers, and retire credits on-chain so they can never be counted twice.",
    lede: "African projects produce high-quality removals. Buyers still hesitate because they can't tell good credits from recycled ones.",
    problem: [
      "The same credit can be sold twice when registries and marketplaces don't talk to each other.",
      "Buyers pay a 'trust discount' — and originators take the loss.",
    ],
    plan: [
      ["Tokenise a registry batch", "Submit the batch and registry statement. A batch can only ever be tokenised once."],
      ["Sell to verified buyers", "List any amount; buyers take what they need."],
      ["Retire on-chain", "Retirement burns the credits permanently and records who they offset."],
    ],
    outcomes: ["No double counting", "Public retirement records", "Faster sales at fairer prices"],
    cta: { label: "List carbon credits", href: "/login?new=1" },
  },
  {
    slug: "institutions",
    nav: "Banks & DFIs",
    title: "A compliant rail for trade finance at scale",
    metaDescription:
      "Banks, microfinance banks and DFIs: finance warehouse receipts and LPOs with on-chain liens, KYC-verified counterparties and a complete audit trail.",
    lede: "Lend against collateral you can see, that can't be pledged twice, and that transfers to you automatically if a loan isn't repaid.",
    problem: ["Agri collateral is hard to verify and easy to double-pledge.", "Manual checks make small loans uneconomic."],
    plan: [
      ["Onboard with our team", "Commercial and compliance onboarding, then API access for your systems."],
      ["Take pledges on-chain", "A pledged receipt or LPO is frozen until you release it."],
      ["Enforce if you must", "After maturity, an unreleased pledge transfers the asset to you."],
    ],
    outcomes: ["One lien per asset, enforced by code", "Every counterparty KYC/KYB-verified", "Audit trail your regulator can follow"],
    cta: { label: "Talk to our team", href: "mailto:partners@tradechainx.com" },
  },
];

export const segmentBySlug = (slug: string) => SEGMENTS.find((s) => s.slug === slug);
