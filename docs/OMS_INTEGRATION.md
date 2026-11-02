# Polygon Open Money Stack (OMS) — integration guide

**Status checked: 29 September 2026.** OMS is changing quickly. Re-check the sources at the end before
building on any part of it.

## What OMS is

Polygon Labs' "Open Money Stack" packages the pieces a payments app needs on Polygon: wallets, fiat
on/off-ramps, cross-chain movement, settlement on Polygon Chain and stablecoin (USDC) handling, behind
one API. Polygon Labs acquired Coinme (US-licensed cash/crypto ramps) and Sequence (wallet
infrastructure) to build it.

There are two views of "what's available", and both are true:

- The **components** exist today as separate products: Sequence's wallet infrastructure, Coinme's ramps, Polygon's bridging (Trails/AggLayer), native USDC on Polygon. Polygon's docs list them as live.
- The **unified OMS product** (one API, one dashboard, one contract) is in **technical preview** since June 2026, with a narrower scope (below) and access by request, onboarded in waves.

## Provision status and what TradeChainX does with each

| OMS capability | Status in the OMS technical preview | TradeChainX today | What to integrate when it's available to us |
| --- | --- | --- | --- |
| **Settlement on Polygon Chain** | Live | ✅ **Built.** All contracts deploy to Polygon PoS; every trade settles atomically on-chain. | Nothing further. |
| **Native USDC** | Live (no wrapping or bridging) | ✅ **Built.** `deploy-polygon.sh` hard-codes Circle's native USDC `0x3c49…3359`. | Nothing further. |
| **Wallets** | Custodial wallets live (auto-created, USDC/USDT on Polygon). **Embedded wallets: "coming soon".** | ✅ **Built, provider-neutral.** Embedded wallets via Privy, Dynamic or Sequence (Sequence is OMS's own wallet layer). Switch by config — [WALLETS.md](WALLETS.md). | When OMS embedded wallets ship: most likely a new adapter next to `sequence.ts` (or Sequence's adapter as-is). Custodial wallets don't fit: our users must sign their own on-chain actions. |
| **Fiat on/off-ramps** | Cash ramps in **48 US states** (Coinme retail network); US business bank rails (ACH, Fedwire, RTP). Consumer bank ramps and wider coverage "coming soon". **No Nigerian or other African coverage.** | 🟡 **Scaffolded.** Ramp adapter layer, hosted-checkout flow, webhook handling, user "Add or withdraw money" page, health check. Two adapters: `partner` (generic hosted checkout — for a Nigerian/African ramp) and `oms` (shell with the request/response mapping isolated and marked `CONFIRM`). | **For Nigeria: sign a local ramp partner** (NGN ↔ USDC on Polygon) and set `RAMP_PROVIDER=partner`. Use `oms` only for US users/partners, once OMS gives you access and the API reference. |
| **Cross-chain** | Bridging exists separately (Trails/AggLayer); **not yet integrated into the OMS preview** | ❌ **Not built.** Not needed at launch: users pay in USDC on Polygon; ramps deliver straight to Polygon. | If partners hold USDC on other chains, add a "deposit from another chain" step using the bridge SDK. Contracts don't change. |
| **Gas sponsorship** | Available through the wallet layer (Sequence gas sponsorship); not a separate OMS preview item | 🟡 **Interim built.** Gas station (API tops up verified users' wallets) + `sponsored` mode ready for provider paymasters. | Turn on sponsorship in the chosen wallet provider, set `NEXT_PUBLIC_GAS_MODE=sponsored`, `GAS_STATION_ENABLED=false`. |
| **Compliance dashboards, analytics, swaps, self-service signup** | "Coming soon" | Our own KYC/KYB review flow + on-chain identity registry; admin System health. | Evaluate when released; our identity registry stays the on-chain gate either way. |
| **Agentic payments (x402, ERC-8004)** | Listed as live components | Not used. | Not relevant to launch. |

Legend: ✅ built and tested · 🟡 built but waiting on an outside provider/contract · ❌ not built.

## How to get OMS access

1. polygon.technology/open-money-stack → **Request early access** form. Describe TradeChainX as: *"regulated trade-finance marketplace settling in native USDC on Polygon PoS; needs embedded wallets and fiat ramps."*
2. Say plainly that the core market is Nigeria. Ask specifically: (a) timeline for ramp coverage outside the US, (b) timeline for embedded wallets, (c) whether Sequence embedded wallets can be used now under the OMS agreement.
3. When access arrives, you'll get API credentials and the API reference. Then follow the ramp steps below.

## Integrating a ramp (either path)

The ramp layer lives in `apps/api/src/ramps/`:

```
types.ts     RampProvider interface: createSession, parseWebhook, health
partner.ts   generic hosted-checkout ramp (URL + signed webhook) — ADAPT markers
oms.ts       OMS shell — CONFIRM markers
index.ts     picks the adapter from RAMP_PROVIDER
routes/ramp.ts   GET /ramp/config · POST /ramp/sessions · GET /ramp/transactions · POST /ramp/webhook
migrations/0003_operations.sql   ramp_transactions table
apps/web/src/app/app/funds/page.tsx   the user's "Add or withdraw money" page
```

Flow: the user picks deposit/withdraw and currency → the API records a `ramp_transactions` row and asks
the provider for a session, passing **our row id** as the provider's order id and the user's verified
wallet as the destination → the user completes KYC and payment on the provider's page → the provider
sends USDC to (or takes USDC from) the wallet and calls `/ramp/webhook` → we verify the signature and
update the row → the user sees the status. TradeChainX never handles card or bank details.

### A) Local ramp partner (Nigeria) — `RAMP_PROVIDER=partner`

1. Choose a licensed partner that supports **NGN ↔ USDC on Polygon PoS** with a hosted checkout and signed webhooks, and that your compliance adviser is happy with. Get their API docs and a sandbox.
2. Open `apps/api/src/ramps/partner.ts` and adjust the three `ADAPT` spots to their docs: checkout URL query parameters, signature header name, and status names / payload fields. Nothing else changes.
3. Env (staging first): `RAMP_PROVIDER=partner`, `RAMP_API_URL=<their hosted checkout URL>`, `RAMP_API_KEY=<their publishable key>`, `RAMP_WEBHOOK_SECRET=<their webhook secret>`, `RAMP_CURRENCIES=NGN`, `RAMP_COUNTRIES=NG`.
4. In their dashboard set the webhook to `https://api.<domain>/ramp/webhook` and the redirect to `https://<domain>/app/funds`.
5. Test on staging: a deposit and a withdrawal in their sandbox; the row goes created → pending → completed; System health shows "Fiat ramp: Working".

If the partner uses a server-to-server "create order" API instead of a URL, implement it inside
`createSession` (see `oms.ts` for the pattern) and return `redirectUrl` or `instructions` (bank details
to show the user).

### B) OMS ramp (US users) — `RAMP_PROVIDER=oms`

1. With OMS credentials and the API reference, open `apps/api/src/ramps/oms.ts` and replace each `CONFIRM` item: endpoint paths, request field names, webhook signature header and algorithm, status names.
2. Env: `RAMP_PROVIDER=oms`, `RAMP_API_URL`, `RAMP_API_KEY`, `RAMP_WEBHOOK_SECRET`. Currencies are fixed to USD and countries to US in the adapter.
3. Register the webhook `https://api.<domain>/ramp/webhook` in the OMS dashboard; test in their sandbox as above.

Only one ramp is active at a time. If you need both (NGN for Nigeria, USD via OMS), extend `ramps/index.ts`
to choose by the user's country — the rest of the flow already works per transaction.

## What doesn't change whatever OMS does

- The contracts, the review gate and the identity registry. OMS moves money; TradeChainX decides who may trade what.
- The wallet adapter interface — any new wallet (OMS embedded wallets included) is one adapter file.
- Settlement in native USDC on Polygon.

## Sources

- Polygon, "Polygon Open Money Stack Enters Technical Preview" (4 June 2026): https://polygon.technology/blog/polygon-open-money-stack-enters-technical-preview
- Polygon docs, "What is the Open Money Stack?": https://docs.polygon.technology/oms/overview
- Polygon, "Polygon Labs to Acquire Coinme and Sequence…": https://polygon.technology/blog/polygon-labs-to-acquire-coinme-and-sequence-to-offer-regulated-stablecoin-payments-in-the-u-s
- Polygon docs, USDC on Polygon PoS: https://docs.polygon.technology/pos/payments/transfers/transfer-usdc
