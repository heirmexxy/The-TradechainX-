# TradeChainX

Trade and finance verified warehouse receipts, purchase orders (LPOs) and carbon credits, and own shares
in productive farm machinery (XOwn) — with blockchain as invisible infrastructure.

This repository is a full rebuild of the platform against the September 2026 PRD, extended in November 2026
toward [PRD v3](docs/PRD_v3.md): one tokenization engine with plug-in asset types, sold through a
Distribution API to fintechs and used directly on TradeChainX. It replaces the
original contracts and apps, which had critical fund-safety and fraud-control flaws
(see [docs/ORIGINAL_CODE_REVIEW.md](docs/ORIGINAL_CODE_REVIEW.md)).

## What's here

```
contracts/        Solidity (Foundry): identity, warehouses, receipts, LPOs, carbon, commodity units, marketplace, XOwn
packages/shared/  ABIs + addresses (generated), domain rules shared by API and web (enums, money, hashing inputs)
packages/sdk/     @tradechainx/sdk — dependency-free Partner API client + webhook verification
apps/api/         Node + Fastify + Postgres + viem: auth, KYC, drafts, indexer, admin queues, partner API,
                  ramps, health monitor, wallet-token issuer, gas station
apps/web/         Next.js 15: public site, trader/issuer/investor/lender app, admin console
                  (incl. System health, Partners), switchable wallet adapters, public/embed.js widgets
deploy/           Production: Caddyfile, env templates, server setup, deploy/backup/restore scripts
docs/             Runbook, accounts & keys, wallets, OMS, partner API (+ OpenAPI), code review, integration map
```

## Documentation

| Read this | When |
| --- | --- |
| [docs/PRODUCTION_RUNBOOK.md](docs/PRODUCTION_RUNBOOK.md) | Putting it live and running it: hosting, secrets, DNS, Safe, deploy sequence, backups, monitoring, mainnet checklist, incidents |
| [docs/ACCOUNTS_AND_KEYS.md](docs/ACCOUNTS_AND_KEYS.md) | Creating every outside account/key; what the old keys were for |
| [docs/WALLETS.md](docs/WALLETS.md) | Privy / Dynamic / Sequence setup and switching; gas |
| [docs/OMS_INTEGRATION.md](docs/OMS_INTEGRATION.md) | Polygon Open Money Stack: status and how to integrate ramps |
| [docs/PARTNER_API.md](docs/PARTNER_API.md) · [OpenAPI](docs/partner-openapi.yaml) | Third-party API, webhooks, SDK, widgets |
| [docs/APP_INTEGRATION_MAP.md](docs/APP_INTEGRATION_MAP.md) | Which screen calls which endpoint and contract |
| [docs/PRD_v3.md](docs/PRD_v3.md) | Product requirements for the engine + distribution model: layers, decisions, regulation, phasing |
| [docs/COMMODITY_UNITS.md](docs/COMMODITY_UNITS.md) | The pooled 1 kg commodity token: lifecycle, invariant, roles, trust assumptions |
| [docs/DISTRIBUTION_API.md](docs/DISTRIBUTION_API.md) | Design of the fintech Distribution API (naira orders, settlement) and what is built vs not |

### How the pieces fit

```
 Browser (Next.js) ── wallet adapter ──► signs contract calls ──► Polygon / EVM chain
      │                                                                    │
      │ JSON API (cookie session)                                          │ events
      ▼                                                                    ▼
 API (Fastify) ◄──────────── Postgres ◄──────────── Indexer (reads events, re-reads state)
   - drafts: private details → hashed on-chain terms → prepared call
   - KYC review → reviewer signs IdentityRegistry.setIdentity
```

- **The chain is the source of truth.** The indexer is the only writer of on-chain state into Postgres.
  The API never trusts the browser about what happened on-chain (the old app did).
- **The API never signs user transactions.** It prepares calls; the user's wallet signs them.
- **Users never see wallets, gas or seed phrases.** Every screen goes through one `WalletAdapter`
  interface (`apps/web/src/wallet`). Privy, Dynamic and Sequence adapters are built; pick one with
  `NEXT_PUBLIC_WALLET_PROVIDER` (a dev adapter runs locally).

## Run it locally

Prerequisites: Node 22, pnpm 9, Foundry, Docker.

```bash
pnpm install
docker compose up -d                      # Postgres on :5432, anvil chain on :8545

cd contracts
forge install OpenZeppelin/openzeppelin-contracts@v5.1.0 --no-git
forge install OpenZeppelin/openzeppelin-contracts-upgradeable@v5.1.0 --no-git
forge install foundry-rs/forge-std --no-git
./deploy-local.sh                         # deploys everything, writes addresses, regenerates ABIs
cd ..

cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env.local
pnpm db:migrate
pnpm db:seed                              # demo accounts for every role, on-chain roles + KYC
pnpm dev:api                              # :4000 (runs the indexer in-process in dev)
pnpm dev:web                              # :3000
```

Sign in with any seeded account; in development the sign-in code appears on screen.

| Account | Can do |
|---|---|
| `warehouse@tradechainx.local` | Issue receipts at *Iseyin Central Warehouse*, confirm collections |
| `trader@tradechainx.local` | Hold, sell, pledge and redeem receipts |
| `sme@tradechainx.local` | Issue and sell LPOs |
| `originator@tradechainx.local` | Issue and sell carbon credits |
| `investor@tradechainx.local` | Buy assets, invest in XOwn |
| `lender@tradechainx.local` | Take pledges, release or enforce |
| `spv@tradechainx.local` | Operate an XOwn machine (receive raise, pay earnings) |
| `reviewer@tradechainx.local` | KYC reviewer, listing reviewer, pauser |
| `ops@tradechainx.local` | Warehouse registrar, XOwn asset manager |
| `superadmin@tradechainx.local` | Roles, fees, resume after pause |

Duties are split across accounts on purpose: the contracts refuse to let the same wallet submit and
approve, or propose and approve.

## Tests

```bash
pnpm contracts:test          # 180 Foundry tests incl. fuzzing and a full-platform journey
pnpm test:domain             # shared rules; includes a check that TS enums match Solidity
pnpm test:sdk                # partner SDK incl. webhook signature verification
pnpm --filter @tradechainx/api test   # hash functions pinned to values from the deployed contracts
cd contracts && ./smoke-local.sh      # full journey against a deploy-local.sh deployment, via cast
PGDATABASE=tcx apps/api/test/schema-distribution.sh   # money-safety constraints, on a Postgres with migrations applied
```

CI (`.github/workflows/ci.yml`) runs all of the above plus Slither, type-checking and the web build.

### Distribution layer (PRD v3): build status

Added in November 2026. Verified by running in a build environment with Foundry, Postgres 16 and Node
(but no npm registry access):

| Piece | State |
| --- | --- |
| `CommodityUnits` contract: pooled 1 kg units, three-person issuance gate, backing invariant, automatic halt on shortfall or lost monitoring, two-person processor sale, in-kind holding fees, resale via the existing marketplace | **Built.** 58 tests incl. a 256-run fuzz of the backing invariant. Deploys with `deploy-local.sh`; the 16-check smoke journey still passes. Not audited. Runtime size 22.6 KB of the 24.6 KB limit |
| Shared rules: units, quotes, fees, revenue share, net settlement, prefund, asset-module registry, eligibility | **Built.** 14 new tests, pinned to the same numbers as the contract tests |
| Database: classes, lots, prices, distributors, customers, orders, append-only balanced ledger, settlements | **Built.** `migrations/0005_distribution.sql` applied to Postgres 16; 29 constraint checks pass (`apps/api/test/schema-distribution.sh`, also a CI job) |
| Distribution API routes, indexer handlers, price service, market-making desk, naira settlement, custodian wallets, naira ramp, SDK additions, white-label screens, admin screens | **Not built.** See the status table in [docs/DISTRIBUTION_API.md](docs/DISTRIBUTION_API.md) |
| Pledge/lien support for units (Carrot Credit collateral) | **Not built** |

Not run: Slither (CI runs it), and `pnpm install` / typecheck / app tests (npm registry blocked in the
build environment, so the apps' TypeScript is still unverified end to end, as above).

### What was verified while building, and what wasn't

The build environment could run Foundry, Postgres and Node's built-in test runner but **could not
install npm packages** (the registry was blocked). So:

- **Verified by running:** all contracts and tests; the deploy script and a 16-check smoke journey on a
  local chain; the SQL migrations and every raw SQL fragment on Postgres 16; the shared domain tests;
  every contract call the apps build, checked against the ABIs (name and argument count).
- **Also verified by running (operations/partner work):** migrations 0003–0004 and the SQL the
  webhook dispatcher, quota counter and health checks use; the SDK's 10 tests (incl. webhook signatures
  computed independently with node:crypto); the embed widgets rendered in headless Chromium against a
  stub API (host-page CSS can't leak in); shell scripts and YAML parse; every prepared call the partner
  API builds matches the contract ABIs.
- **Checked but not run:** the API and web TypeScript. Every file parses, and the code was type-checked
  strictly with third-party packages stubbed out, which found and fixed one real bug.
- **Your first `pnpm install && pnpm typecheck && pnpm test` is the first full run of the apps.**
  Expect a round of small fixes (library API details), not design changes.

## Polygon Open Money Stack (OMS): provision status

Checked 29 September 2026. OMS is in **technical preview** (access by request, onboarded in waves).
Details and integration steps: [docs/OMS_INTEGRATION.md](docs/OMS_INTEGRATION.md).

| OMS provision | OMS status | In this codebase |
| --- | --- | --- |
| Settlement on Polygon Chain | Live | ✅ Built — all contracts on Polygon PoS, atomic USDC settlement |
| Native USDC | Live | ✅ Built — Circle native USDC hard-coded for mainnet |
| Wallets | Custodial live; **embedded "coming soon"** | ✅ Built — embedded wallets via Privy / Dynamic / Sequence (Sequence is OMS's wallet layer); switch by config |
| Fiat on/off-ramps | **US only** (cash in 48 states, US bank rails) | 🟡 Scaffolded — ramp adapter, webhooks, user page. Needs a **Nigerian ramp partner** (`RAMP_PROVIDER=partner`); OMS adapter is a shell until access + API docs |
| Cross-chain | Separate products, not in the preview | ❌ Not built — not needed while users pay in USDC on Polygon |
| Gas sponsorship | Via the wallet layer | 🟡 Interim gas station built; provider sponsorship is a dashboard switch + `NEXT_PUBLIC_GAS_MODE=sponsored` |
| Compliance dashboards, analytics, swaps | Coming soon | Own KYC/KYB review + on-chain identity registry; admin System health |

## What's built, and what you still integrate

Built in this repository (code complete; see "What was verified" above):
contracts and deploy scripts (Amoy + Polygon mainnet), API, indexer, web app and admin, switchable
wallet adapters, gas station, ramp adapter layer, System health monitor with supplier status pages and
email/Slack/Telegram alerts, Partner API with scoped/rate-limited keys, signed webhooks with retries,
JS SDK, embeddable widgets with referral tracking, Docker images, production compose + Caddy, backup/restore.

You still need to (in order — the runbook walks through each):

1. Create the accounts and keys ([ACCOUNTS_AND_KEYS.md](docs/ACCOUNTS_AND_KEYS.md)); revoke every old key.
2. Run `pnpm install` once, fix any small library-version issues, commit `pnpm-lock.yaml`.
3. Pick the wallet provider and configure its dashboard ([WALLETS.md](docs/WALLETS.md)); test on Amoy.
4. Create the Safe; deploy to Amoy; run the full staging rehearsal (runbook §10.2).
5. Commission the independent smart-contract audit and the legal review of each asset's claim on the underlying goods (PRD §9).
6. Sign a Nigerian fiat ramp partner and adapt `apps/api/src/ramps/partner.ts` to its docs; request OMS access in parallel.
7. Optional: plug an automated ID/liveness KYC provider in front of the manual review queue.
8. Deploy to Polygon mainnet (runbook §7, §10.3).

The contracts are EVM-standard and deploy unchanged to Base, Arbitrum and Celo. Cardano and Stellar
need separate implementations (PRD §8.2).
