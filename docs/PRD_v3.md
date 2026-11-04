# TradeChainX — Product Requirements Document (v3)
### One tokenization engine, five asset types, two doors: direct and distributed

**Owner:** Emeka (Founder/CEO)
**Prepared:** 4 November 2026
**Status:** Draft for review
**Supersedes:** v2 (September 2026). Source inputs: Commodity Units Product Spec v0.1 (2 Nov 2026), the TradeChainX rebuild repository (`heirmexxy/The-TradechainX-`, commit `c78ad01`), and the decisions recorded in Section 1.3.

---

## 0. What changed from v2

| Topic | v2 | v3 |
|---|---|---|
| Positioning | A marketplace for receipts, LPOs, carbon and XOwn, with a partner API on the side | **Tokenization infrastructure**: one engine with plug-in asset types, sold as an API to fintechs and used directly on TradeChainX |
| Asset types | Warehouse receipts, LPOs, carbon credits, XOwn | Adds **Commodity Units** (1 kg pooled, redeemable claims on graded, warehoused stock). **All five** are in the distribution API |
| Distribution | Phase 3 "partner API" for banks | **Core product from day one**: Distribution API, SDK, white-label screens and revenue share |
| Settlement | Atomic USDC on Polygon | **Naira, settled off-chain** through a licensed custodian. The chain records ownership. USDC stays internal (cross-border and institutional flows only) |
| Custody | Non-custodial embedded wallets for retail | **Per-customer wallets whose keys a licensed custodian holds**, for direct and distributed customers alike |
| Market | Seller-set fixed-price listings | Adds **reference price, bid/ask, matching and Kitovu market-making** for Commodity Units; listings remain for the other assets |
| Direct users | Self-held wallets, USDC | **Same model as fintech users**: naira through a ramp, custodian-held wallets, one rulebook |

---

## 1. Purpose, strategy and decisions

### 1.1 Purpose
TradeChainX lets people own and trade verified real-world assets without seeing a blockchain. Businesses create and verify assets; TradeChainX tokenizes, registers and trades them; fintechs distribute them to their own customers; and customers can also trade directly on tradechainx.com.

### 1.2 The four layers

1. **Create and verify the assets.** Intake, grading, document checks, stock attestations and reviewer approval. Nothing is issued before it is verified.
2. **The TradeChainX registry.** The token contracts and the identity gate that record who owns what. Polygon first, EVM-standard so other chains can follow.
3. **The market.** Primary subscriptions and resales for every asset type. For Commodity Units, a priced market with bid/ask, user-to-user matching and Kitovu as market-maker at first.
4. **Distribution.** A Distribution API and SDK, ready-made white-label screens and a revenue share for fintechs. They own the customer and the wallet; TradeChainX owns the asset and the plumbing.

### 1.3 Decisions made (4 November 2026)

| Decision | Choice | Consequence |
|---|---|---|
| Naira settlement | Off-chain naira through a licensed custodian's client-money account; on-chain delivery of units | Settlement is no longer atomic delivery-versus-payment. Needs prefunding and reconciliation controls (Section 5) |
| Custody and ownership record | Per-customer wallets, keys held by a licensed custodian; ownership recorded on the TradeChainX registry | Fits the existing per-wallet identity gate and per-owner pledging. A licensed custodian partner is a launch dependency |
| Launch scope | **All five asset types available through the API from the start** | Largest build and compliance surface. Production enablement is gated per asset (Section 4.2) rather than all at once |
| Direct channel | Same model as fintech users | One rulebook, one ledger; users can move between a fintech and direct. Requires a Nigerian naira ramp for direct users |

### 1.4 Out of scope for this PRD
Legal opinions, final spread and fee levels, and the choice of named licensed partners. These are listed as open decisions (Section 14).

---

## 2. Goals and success metrics

| Goal | Metric |
|---|---|
| Prove the distribution model | First distributor (ComboTrader) live with real stock and real money; second outside distributor signed |
| Prove the asset is real | 100% of outstanding units backed by attested stock; monthly independent stock audit with zero unexplained variance |
| Liquidity that works | Instant-buyback fill rate within published limits; median quote-to-fill time; reserve ratio never below the published floor |
| Easy integration | Median time from sandbox key to first live order for a fintech: under 6 weeks |
| Invisible blockchain | 0 steps in any customer flow that mention wallets, gas, chains or keys |
| Conversion and discoverability | Direct signup conversion; fintech lead conversion from the developer pages; organic ranking for target keywords (Section 8) |
| Safety | Clean independent audit of all contracts; no unresolved critical or high findings before production volume |

---

## 3. Users, channels and roles

### 3.1 User types

| Type | Who | Enters through |
|---|---|---|
| Retail saver / investor | Wants real-asset, price-linked exposure from 10 kg of a commodity, or shares in equipment | A fintech app (primary) or tradechainx.com |
| Commodity trader / aggregator | Holds or buys receipts and units, wants liquidity | Direct, or via a distributor |
| Warehouse operator / issuer | Issues receipts and supplies attested stock | Direct (issuer console) and the issuer API |
| SME with LPOs | Raises working capital against confirmed purchase orders | Direct, or via a distributor |
| Carbon originator / buyer | Lists, buys and retires credits | Direct, or via a distributor |
| Distributor (fintech, wealth app, brokerage) | Offers TradeChainX assets to its own customers under its brand | Distribution API and SDK |
| Lender (e.g. Carrot Credit) | Accepts units and receipts as collateral | Lender API |
| Institutional partner (bank, MFB, DFI) | Needs an auditable rail | API and reporting |
| Platform staff | Reviewers, registrar, price committee, reserve manager, auditor, super admin | Admin console |

### 3.2 Channel rules
- One registry and one order book serve both doors. A unit is the same unit whoever sold it.
- A customer has one origin channel (the fintech or direct), which controls revenue share. Terms must include non-circumvention for distributors.
- Holdings can be moved between channels (for example from a fintech to direct) only through a logged transfer that both parties' KYC allows.
- Price and fees shown to a customer must be consistent across channels. Only the channel's own revenue share differs behind the scenes.

### 3.3 Admin and compliance roles
KYC/KYB reviewer; listing reviewer; warehouse registrar; stock auditor (attests lots); **price committee** (independent of Kitovu's trading desk); **reserve manager**; class manager (creates commodity classes); pauser (market and per-class pause); super admin (multisig-gated). No person holds two roles on the same flow. Each role maps to an on-chain role where the action is on-chain.

---

## 4. Layer 1 — Create and verify assets (plug-in asset types)

### 4.1 The AssetModule interface
Every asset type plugs into the engine through one interface. Adding an asset type means implementing it, not rewriting the platform.

| Element | What the module defines |
|---|---|
| Issuance workflow | Who may submit, required documents, automated checks, reviewer steps, what is minted and when |
| Verification | Duplicate detection, registry or oracle checks, attestations |
| Trading mode | `pooled` (fungible by class), `unique` (individual lots), `primary-only` (subscription windows), or `primary + resale` |
| Price source | Reference-price method, or issuer-set price, or face-value discount |
| Exit | How holders realise value: resale, buyback, redemption, settlement, retirement |
| Eligibility | Which customer tiers and which distributors may buy, with required disclosures |
| API surface | The endpoints and webhook events the module adds |

### 4.2 The five modules

| Asset | Trading mode | Price source | Exit | Notes for distribution |
|---|---|---|---|---|
| **Commodity Units** (1 kg of a named commodity and grade) | Pooled, fungible per class | Published reference price with bid/ask | Sell to users; instant buyback by Kitovu; retirement on processor sale | The retail wrapper around warehoused stock. Not a fixed-return product; price risk shown in every screen |
| **Warehouse receipts** | Unique lots (and the legal backing for Commodity Units) | Seller-set price | Resale, pledge, redemption of goods | Traders and institutions; high ticket |
| **LPOs** | Unique, with maturity | Discount to face value | Settlement by the buyer pays the holder | Credit instrument with buyer-default risk; requires risk disclosure and qualified-investor gating per distributor |
| **Carbon credits** | Unique vintages, fungible within a vintage | Seller-set or reference | Resale or retirement with a certificate | Natural fit for an "impact" tab; registry linkage |
| **Fractional tokens (XOwn)** | Primary subscription, then resale | Offering price | Earnings paid in naira; dissolution and redemption | Most securities-like of the five; each offering individually approved |

**Production enablement gate (applies to every asset type).** An asset type goes live for a given distributor only when: the contracts are audited; the disclosure pack is approved; the licensed issuer/custodian coverage is in place; and the distributor has accepted that asset's eligibility rules. The API contract and sandbox expose all five from day one; the gate controls production, so one asset's legal timeline does not block the others.

### 4.3 Listing and issuance approval flow (all assets)
1. **Submit.** A verified business submits details and documents. For Commodity Units, the unit of submission is a *lot*: weight, grade, warehouse, intake date and monitoring status.
2. **Automated checks.** Duplicate detection (same document number, or same warehouse + commodity + date fingerprint), document checks, registry or oracle checks where available.
3. **Manual review.** A reviewer verifies authority to submit this specific asset; for stock, the warehouse registrar confirms the facility is licensed and approved.
4. **Attestation (stock only).** A stock auditor or approved warehouse standard attests quantity and grade; live monitoring (StorageX + WareGuard) must be reporting before issuance.
5. **Mint after approval, never before.** Enforced on-chain: the contract cannot mint without the approval and, for stock, the attestation.
6. **Go live.** The asset appears in the market and gets a public, verifiable page.
7. **Status changes re-enter the gate.** Redemption, settlement, retirement and write-downs are reviewed and logged.

### 4.4 Commodity class requirements
A class needs: an approved warehouse, a grading standard, a price source and an offtake buyer. Adding a class must need no new code. First class: soybean Grade 1 in one StorageX warehouse with an existing offtake buyer (to confirm).

---

## 5. Settlement and money flow

### 5.1 Principles
- Customers pay and are paid in **naira** through their fintech wallet (distributed) or a ramp (direct).
- Naira moves through a **licensed custodian's client-money account**, never TradeChainX's or Kitovu's operating account.
- The blockchain records unit ownership. USDC is internal, for cross-border and institutional flows only.
- A customer never sees a wallet, a chain, gas or a seed phrase.

### 5.2 Buy flow (distributed)
1. The fintech app requests a **quote** (valid for a short, stated window; price includes the displayed spread and fees).
2. The customer confirms; the fintech sends an **order** with an idempotency key.
3. TradeChainX checks the customer's tier and limits, the class status (not paused) and available supply or counterparty.
4. The fintech debits the customer's wallet and confirms the debit to TradeChainX.
5. Units are credited to the customer's custodian-held wallet on the registry; the fintech receives a webhook.
6. Cash settles to the custodian's client-money account by **net settlement per distributor** (cadence set with the custodian).

### 5.3 Sell and buyback flow
Mirror of the buy flow. Sells to another user settle at the matched price. Instant buyback by Kitovu pays from the liquidity reserve at the bid, within the daily limit.

### 5.4 Settlement risk controls
Because settlement is not atomic, units can be delivered before cash arrives. Required controls:
- **Distributor settlement account** with a prefund and a credit limit; orders above the available limit are declined.
- Intraday reconciliation between the fintech's ledger, the custodian's account and the registry; unmatched items alert within minutes.
- Hold-and-release on units bought on credit until funds are confirmed (limits unit transfer or sale until then).
- A daily close with a signed reconciliation report shared with each distributor.

### 5.5 Direct users
Naira in and out through a Nigerian ramp partner into the same custodian account structure, with a virtual account per customer. OMS ramps are US-only today, so a local ramp is required; OMS access is requested in parallel.

---

## 6. Layer 2 — Registry, custody and identity

### 6.1 Contracts
Reuse the existing contracts (identity registry, warehouse registry, receipts, LPOs, carbon, marketplace, XOwn); none has been independently audited yet. Added in the repository (see `docs/COMMODITY_UNITS.md`):

- **`CommodityUnits`** (built, 58 tests, not yet audited): one ERC-1155 id per commodity class; one unit is one gram (3 decimals of a kg).
  - Mints only through a three-person gate (operator submits, stock auditor attests, reviewer approves); units issued = attested weight minus the shrinkage buffer; the invariant `supply <= buffered live stock` is enforced and fuzz-tested.
  - Two-person-approved processor sales retire units; in-kind holding fees with an on-chain cap and one charge per 30-day period.
  - Halts automatically on a reported shortfall or lost sensor monitoring; resumes only when back within backing.
  - Transfers restricted by the identity gate; resells through the existing marketplace.
  - The lot registry is part of this contract rather than a separate one.

Still to build:

- **Reference price feed**: attested reference prices with timestamps, method version and committee approval. Currently modelled off-chain (`reference_prices` table), with an on-chain feed optional.
- **Class market**: matched-order and buyback settlement (off-chain matching, on-chain settlement), reserve and limit enforcement.
- **Pledge support for units**: lets a lender lock units per owner, enforce or release.

### 6.2 Custody
Each customer, direct or distributed, has an individual wallet created silently at onboarding. A **licensed custodian holds the keys** (MPC or equivalent); TradeChainX instructs but cannot move assets alone. The TradeChainX registry, not only the fintech's ledger, is the record of who owns what, so holdings can move to another distributor if a partner fails.

### 6.3 Identity and KYC reliance
- Individual tiers: lightweight KYC for browsing and small limits; fuller verification for higher limits.
- Distributed customers: the fintech performs KYC under a **reliance agreement**; TradeChainX verifies the fintech (KYB) and samples its records. Fintech-verified customers get the identity flag on-chain only once a custodian accepts them.
- Direct customers: TradeChainX (or its KYC provider) verifies them, and the same on-chain identity applies.
- Businesses (warehouse, SME, carbon originator): full KYB before any submission.

### 6.4 Holding fee
Storage and insurance (about ₦3/kg/month at the StorageX rate, plus margin) are shown as a line item. **Recommended mechanism:** accrue the fee daily in an off-chain fee ledger and settle by burning units monthly and on exit, so wallet balances stay stable between settlements and the charge is always visible. Engineering to confirm against the alternatives (index-based balance or continuous burn).

### 6.5 Proof of stock
Each class publishes its lots, weights, grades, monitoring readings (moisture, temperature, humidity), reserve and audit status in a public page and via the API. Units are issued only after intake, grading and monitoring. Independent monthly audits; insurance; shrinkage buffer.

---

## 7. Layer 3 — The market

### 7.1 Commodity Units
- **Reference price:** a blend of independent quoted prices (NCX, AFEX, commodity.ng) and Kitovu's executed eProcure sale prices, refreshed at least daily. The method is published. **Controls:** several independent sources, outlier filter, a cap on the weight Kitovu's own prices can carry, an independent price committee, and an audit trail.
- **Bid and ask** around the reference price. Narrow spread for user-to-user matches; wider for instant buyback.
- **Order types (MVP):** buy and sell at market. Limit orders later, once there is enough two-way volume.
- **Minimum purchase:** 10 units (10 kg). Holdings divisible to 0.001 kg.

### 7.2 Three exits (each ends in cash)
| Exit | How | Price | Funded by |
|---|---|---|---|
| Sell to another user | Matched across every connected channel | Reference price, narrow spread | The buyer |
| Instant buyback | Kitovu buys at the bid, any time within limits | Bid, wider spread | Kitovu's liquidity reserve |
| Processor sale | When a lot is sold through eProcure, units are retired and holders paid | Price the processor paid, less costs | The processor |

### 7.3 Buyback protections
- Liquidity reserve sized as a share of units outstanding, held in cash or treasury bills, reported publicly.
- Daily buyback limits per user and in total; above them, sales go to the order book or wait for the next processor sale.
- Bought-back units are resold or delivered into eProcure contracts so the reserve turns over.
- **Circuit breaker:** if the reference price moves sharply in a day, instant buyback pauses and only user-to-user trading continues.
- Physical delivery above a large minimum, for traders and processors only (later phase).

### 7.4 Conflict-of-interest controls
Kitovu would be stock owner, issuer, market-maker and a price source. Required: separate legal entities or ring-fenced desks for market-making; the price committee independent of the trading desk; published quote and trade logs; no use of non-public customer order data by the trading desk.

### 7.5 Other assets
Receipts, LPOs, carbon and XOwn trade through listings and primary subscriptions on the same registry, without Kitovu market-making. Resale is available where the asset module allows it and the distributor's eligibility rules permit.

### 7.6 Open item: processor-sale retirement rule
When a pooled class has one lot sold to a processor, which units retire? Options: pro rata across all holders (everyone shares quality risk), or a holder opt-in queue plus Kitovu inventory first. Decision needed before the first class goes live (Section 14).

---

## 8. Layer 4 — Distribution

### 8.1 What a distributor gets
- **REST API and webhooks** for all five asset types.
- **SDK** (existing JavaScript SDK extended) and **white-label screens** for web and mobile.
- **Sandbox** with test commodities and test assets; **compliance pack** (legal structure, custody, reserve reports, price method, disclosures).
- **Revenue share** on trades and holding fees, with a monthly statement and an API for it.
- Settlement in naira through the distributor's existing wallet (Section 5).

### 8.2 Who does what
| Distributor | TradeChainX |
|---|---|
| Customer KYC under reliance agreement; wallet; customer support; screens (or uses ours); required disclosures | Assets, pricing, registry, matching, reserves, reporting, settlement reconciliation, compliance pack |

### 8.3 API v1 (indicative)
Auth: scoped partner keys; per-key rate limits and daily quotas (existing model); idempotency keys on all writes.

| Group | Endpoints |
|---|---|
| Catalogue | `GET /asset-types`, `/classes`, `/classes/{id}`, `/classes/{id}/price`, `/classes/{id}/proof`, `/offerings`, `/listings` |
| Customers | `POST /customers` (with KYC reference), `GET /customers/{id}`, `PATCH /customers/{id}/limits` |
| Trading | `POST /quotes`, `POST /orders` (buy, sell, buyback), `GET /orders/{id}`, `DELETE /orders/{id}` |
| Other assets | `POST /subscriptions` (XOwn, LPO primary), `POST /purchases` (listings), `POST /retirements` (carbon), `GET /distributions` (XOwn earnings), `POST /settle-lpo` |
| Holdings | `GET /holdings`, `GET /statements`, `GET /pledges` |
| Money | `GET /settlements`, `GET /revenue-share` |
| Webhooks | `order.filled`, `settlement.completed`, `kyc.status`, `holding_fee.charged`, `class.price_updated`, `class.paused`, `retirement.paid`, `distribution.paid`, `listing.approved` |

The existing Partner API (issuers and B2B, partner-signed prepared calls in USDC) stays for issuers; the Distribution API is separate and never asks a fintech to touch a chain.

### 8.4 Distributor onboarding
1. Commercial agreement and KYB.
2. Reliance and settlement agreements; prefund and credit limit set.
3. Sandbox keys; integration; certification test.
4. Per-asset enablement (Section 4.2 gate).
5. Production keys; monitored launch with low limits; open up.

### 8.5 First partners
**ComboTrader** (Kitovu's own app) is the first distributor and proves the flow. **Carrot Credit** is a lender: units accepted as collateral give holders cash without selling and signal credit quality. Next: one or two wealth or savings apps with an existing investment tab.

### 8.6 On the NGX comparison
The NGX Invest model (one platform, many licensed channels) is a useful analogy for the distribution design. NGX reported over 2 million retail investors onboarded in 2025, more than ₦3 trillion raised since its 2024 launch, and 180+ channels by September 2026. It distributes primary-market offers through licensed intermediaries, so it supports the *channel* model, not commodity trading specifically. Quote the figures with their sources and dates.

---

## 9. Regulation and compliance

### 9.1 Approach
**Partner-first.** Phase 1: a licensed issuer or platform issues the units; a licensed custodian holds the keys and investor cash; an approved warehouse standard or commodity exchange covers receipts and grading. TradeChainX provides the technology and Kitovu the stock and market-making. Phase 2: apply for TradeChainX's own licence once volumes can carry the capital, or bring a licensed partner in as a shareholder. A Rwanda or Benin entity sandbox is a parallel option.

### 9.2 Capital thresholds (SEC Circular 26-1, 16 January 2026; compliance by 30 June 2027)
| Category | Minimum capital |
|---|---|
| Ancillary VASP | ₦300 million |
| Digital Asset Intermediary | ₦500 million |
| Digital Assets Platform Operator (including token issuers) | ₦500 million |
| Digital Assets Offering Platform | ₦1 billion |
| Real-World Assets Tokenization and Offering Platform (RATOP) | ₦1 billion |
| Digital Asset Exchange / Digital Asset Custodian | ₦2 billion |

### 9.3 Questions for capital-markets counsel (before issuing any unit)
1. Are Commodity Units, receipts, LPOs and XOwn tokens securities under the Investments and Securities Act 2025, and which approvals does each need?
2. Does a cross-channel order book with Kitovu quoting both sides make the market a digital asset exchange (₦2B tier) rather than an offering platform (₦1B)?
3. What licence or agency cover does each distributor need to offer these assets to its customers?
4. Does the custodian-held-key model plus off-chain naira settlement satisfy custody and client-money rules?
5. How do the proposed Digital and Virtual Assets rules (published 20 August 2026, not yet adopted) change the structure? The design must be able to change with them.

*This is a product design, not legal advice.*

### 9.4 Design implications
Issuer, custodian and venue roles must be swappable. Regulatory flags (asset eligibility, investor tier, disclosure version) live on the asset and on the distributor, not in code paths. Every customer-facing screen carries price-risk language and no fixed-return claims; Commodity Units must stay clearly separate from ComboTrader's fixed-return product.

---

## 10. Website, SEO and messaging

### 10.1 Two audiences, two journeys
- **Customers** (direct): the SB7 story from v2, extended to Commodity Units.
- **Fintechs and developers:** a distinct journey with its own pages and calls to action.

### 10.2 SB7 for the fintech audience
- **Character:** the product lead at a fintech or wealth app with an "Invest" tab.
- **Problem:** customers want real-asset products; building issuance, custody, pricing and licensing alone takes years.
- **Guide:** TradeChainX handles the assets and plumbing; proof of stock; live monitoring; partner-first compliance.
- **Plan:** (1) get sandbox keys, (2) integrate in weeks, (3) go live and share revenue.
- **CTA:** "Get API keys" / "Talk to partnerships" / "Read the docs".
- **Failure:** a stale investment tab and slow product roadmap. **Success:** a new product line, new revenue, retained customers.

### 10.3 Site structure
```
Home
├── Buy commodities (Commodity Units)
├── For traders & aggregators
├── For warehouses & issuers
├── For SMEs (LPO financing)
├── For carbon originators & buyers
├── For investors (XOwn)
├── For fintechs & lenders          ← new
├── Developers (docs, sandbox, status, changelog)  ← new
├── How it works  ·  Proof of stock (public)  ·  Security & trust
├── Resources / blog (SEO engine)
└── About / partners
```
The Proof of stock page shows live classes, lots, weights, grades, monitoring readings, reserve and audits.

### 10.4 Home page direction
Hero: "Own real commodities from ₦ — priced live, backed by stock you can verify." Remove the 0/0/3 stats; show partner logos and live stock proof instead. All claims avoid guaranteed returns.

### 10.5 SEO
- Clusters: commodity investing Nigeria; buy soybean / maize / sesame online; warehouse receipt financing and tokenization; LPO financing; carbon credit marketplace Africa; RWA tokenization API; investment API for fintechs.
- Per-page titles, descriptions and canonicals (fix the current metadata, which inherited a third-party gas-exchange description); organization, FAQ and product schema; developer docs indexed.
- Disambiguate "TCX" from unrelated crypto projects through consistent full-name use.
- Public asset pages as an indexable page type.

---

## 11. Chains

Polygon first; all contracts are EVM-standard. The planned footprint remains: **Polygon, Base, Arbitrum, Solana, Celo, Lisk, Asset Chain, Cardano, Stellar, Plasma, Tempo, Codex**. Cross-chain is not needed for the first release because customers never choose a chain and settlement is in naira. Sequence: EVM chains next (Base, Arbitrum, Celo, Lisk, Asset Chain); Solana, Cardano and Stellar need separate implementations; the newer stablecoin chains are opportunistic. Each new chain requires its own review of bridging or mint/burn patterns before use.

---

## 12. Smart contract and system review scope

Independent audit before production volume, covering:

- **Core:** reentrancy, access control and separation of duties, upgrade keys and timelocks, pause and circuit breaker, static analysis.
- **Mint-after-approval** and **attestation gating** enforced on-chain.
- **`CommodityClass`:** issuance cap and shrinkage buffer, rounding at 3 decimals, fee-burn accounting, retirement correctness, transfer restrictions.
- **Price feed:** who can write prices, bounds, staleness handling, manipulation resistance.
- **Reserve and buyback accounting**, and daily limits.
- **Custodian operator role:** the permissions the custodian's keys hold, and recovery.
- **Pledge/lien logic for units and receipts.**
- **XOwn:** vault, share token, redemption and dissolution.
- **Off-chain settlement system:** idempotency, reconciliation, hold-and-release, partner credit limits (this is as risky as the contracts).
- **Legal wrapper:** each token has an enforceable claim on the underlying asset (SPV or custody agreement) — parallel legal review.

Deliverable: public audit report and remediation log on the Security & trust page.

---

## 13. Growth loops and revenue

### 13.1 Growth loops
1. **Distributor loop:** each fintech brings its own customer base; revenue share aligns it. This is the main acquisition channel.
2. **Two-sided referral:** reward warehouses and traders for bringing counterparties; weight supply-side referrals at least equally.
3. **Shareable proof pages:** every asset and class has a public verifiable page that issuers send to banks and buyers.
4. **Founding cohort:** an invite-code cohort of founding traders, warehouses and distributors with reduced fees, solving the empty-marketplace problem.
5. **Lender loop:** collateral acceptance (Carrot) makes units more useful, which draws more holders.

### 13.2 Revenue (placeholders to test with partners)
| Stream | Charged to | Shared with distributor |
|---|---|---|
| Trading spread | User | Yes, a split |
| Instant-buyback spread | User | No |
| Holding fee | User | Yes, a split |
| Integration and platform fee | Distributor | No |
| Issuance fee (per tonne tokenized) | Asset originator | No |
| Collateral data feed | Lenders | No |
| Fees on LPO, carbon, receipt and XOwn activity | User / issuer | Per asset module |

Kitovu also earns its eProcure margin and StorageX fees on the physical side.

---

## 14. Risks and open decisions

### 14.1 Risks
| Risk | Control |
|---|---|
| Run on buybacks | Reserve, daily limits, circuit breaker, order book fallback |
| Missing or spoiled stock | Issue only after intake, grading and monitoring; monthly independent audit; insurance; shrinkage buffer |
| Price manipulation | Multiple independent sources, published method, outlier filter, price committee, cap on Kitovu's own price weight |
| Settlement failure (cash vs units) | Prefund and credit limits, reconciliation, hold-and-release |
| Custodian or partner failure | Registry as record of ownership; swappable custodian and distributor |
| Regulatory change or misclassification | Partner-first; swappable roles; counsel review; track the proposed rules |
| Mis-selling | Price-risk language; no fixed-return claims; separation from ComboTrader |
| Kitovu conflicts and balance-sheet strain | Ring-fenced desk, independent price committee, resale of bought-back units, reserve sized to units outstanding |
| Scope risk from launching all five assets | Per-asset production gate; shared engine; stage the commercial launches |
| Brand confusion with unrelated "TCX" projects | Consistent naming, disambiguation, trademark review |

### 14.2 Open decisions
- [ ] Licence path: which licensed issuer, custodian and exchange or warehouse-standard partners to approach first
- [ ] Naira ramp partner for direct users, and the custodian's settlement cadence
- [ ] Liquidity reserve size, daily buyback limits, circuit-breaker threshold
- [ ] Spread levels, holding fee, distributor revenue split
- [ ] Holding-fee mechanism (daily accrual with monthly burn recommended)
- [ ] Processor-sale retirement rule (pro rata vs opt-in queue)
- [ ] Price committee membership and the cap on Kitovu's price weight
- [ ] First class and confirmed warehouse and offtake buyer (soybean recommended)
- [ ] Whether ComboTrader users see Commodity Units under ComboTrader or as a separate tab
- [ ] Consumer product name, and name for fintechs that don't white-label
- [ ] Classification of the market (exchange vs offering platform) from counsel

---

## 15. Phasing

Indicative; the legal and partner path sets the real dates.

| Stage | Work |
|---|---|
| **A. Foundations (weeks 0–8)** | Counsel engaged; licensed issuer and custodian shortlisted and approached; contract audit booked; run the install, typecheck and test pass on the existing repository; account and key setup; website rebuild (customer and fintech journeys, proof page) |
| **B. Engine (weeks 4–16)** | `CommodityClass`, lot registry and price feed; AssetModule interface; Distribution API v1 and sandbox with all five asset types; custodian wallet integration; naira ledger, reconciliation and settlement controls; reference price service and market-making desk; direct-channel ramp |
| **C. Closed pilot (weeks 14–22)** | Staging rehearsal (pause, restore and alert drills); Kitovu staff and ComboTrader users on one soybean class with real stock; reserve and stock dashboard public to partners |
| **D. Controlled launch (weeks 22–30)** | Audit complete; ComboTrader live; Carrot collateral pilot; enable other asset types for ComboTrader one by one through the production gate |
| **E. Scale (after)** | Second outside distributor; second commodity class; limit orders; more chains; own licence application when volume justifies the capital |

---

## Appendix A — What the current repository covers

| Requirement | Repository today | Status |
|---|---|---|
| Identity gate, roles, review queues, pause | `IdentityRegistry`, roles, admin console, pauser | Reusable |
| Receipts, LPOs, carbon, XOwn contracts | Present with tests | Reusable; add distribution and eligibility metadata |
| Marketplace | Seller-set fixed-price listings, USDC | Keep for non-pooled assets; settle off-chain naira path added |
| Pooled commodity token | `CommodityUnits` built and tested (58 tests); not audited | Done in code; audit, indexer handlers and API remain |
| Reference price, matching, market-maker, reserve, breaker | Price and market-parameter tables built; no service or desk | Service, desk, reserve logic and breaker to build |
| Distribution API | Partner API for issuers (partner-signed USDC calls); Distribution API data model, shared rules and design doc built | Routes and services to build; reuse key, quota and webhook plumbing |
| Naira settlement | Balanced append-only ledger and settlement tables built; ramp adapter scaffolded; OMS adapter a shell | Settlement service, custodian integration and reconciliation to build |
| Custodian-held per-customer wallets | Wallet adapters (Privy, Dynamic, Sequence) | Replace or extend with the custodian's MPC |
| Proof-of-stock feeds | Not present | New (StorageX, WareGuard) |
| Indexer, health monitor, deploy, runbook | Present | Reusable |
| Dependency install, typecheck, full test run | Not yet run end to end | Immediate next step |

## Appendix B — Sources
- SEC Nigeria Circular No. 26-1 (16 January 2026), capital thresholds: Nairametrics, Mondaq, BusinessDay summaries.
- SEC proposed Digital and Virtual Assets rules (published 20 August 2026; not yet adopted).
- NGX Invest: NGX Group release on distribution channels; Nairametrics (23 September 2026); Legit.ng; New Telegraph.
- Polygon Open Money Stack: Polygon blog (technical preview, 4 June 2026) and documentation.
- Commodity Units Product Spec v0.1 (2 November 2026).

*End of document.*
