# Wallets: Privy, Dynamic, Sequence — and how to switch

Users never see a wallet. They sign in to TradeChainX with an email code; behind the scenes a wallet
provider creates (or restores) an embedded wallet for them, and every action is signed with it.
Which provider does this is **configuration only**, so you can start with one and switch later.

## How it fits together

```
1. User signs in with email code  ──▶ TradeChainX API (session cookie)
2. Web app asks the API for a wallet token  ──▶ POST /auth/wallet-token
      API signs a 10-minute RS256 token: iss=https://api.tradechainx.com, sub=<user id>, email, aud=tradechainx-wallet
3. Web app hands the token to the provider SDK (no provider login screen)
4. Provider checks the signature against https://api.tradechainx.com/.well-known/jwks.json
      and creates/restores the wallet for that user id
5. Web app links the wallet address to the account once (signed challenge)  ──▶ POST /me/wallet
6. Every action: simulate → provider signs and sends → wait for confirmation
```

The code:

| File | Role |
| --- | --- |
| `apps/api/src/auth/walletToken.ts` | Signs wallet tokens; publishes the public key (JWKS). |
| `apps/api/src/routes/wallet.ts` | `/.well-known/jwks.json`, `/.well-known/openid-configuration`, `/auth/wallet-token`, `/me/gas` |
| `apps/web/src/wallet/types.ts` | The one `WalletAdapter` interface every screen uses. |
| `apps/web/src/wallet/WalletProvider.tsx` | Picks the provider from `NEXT_PUBLIC_WALLET_PROVIDER`, connects after sign-in, runs calls, handles gas. |
| `apps/web/src/wallet/privy.tsx` · `dynamic.tsx` · `sequence.ts` · `dev.ts` | One adapter per provider. Only the selected one is loaded in the browser. |

## Choosing a provider

| | **Privy** | **Dynamic** | **Sequence** |
| --- | --- | --- | --- |
| Our sign-in → their wallet | "JWT-based auth" (custom auth) | "External JWT" / third-party auth | Custom OIDC provider |
| Wallet type | Embedded EOA (optionally smart wallet) | Embedded (MPC) | Smart contract wallet |
| Gas sponsorship | Smart wallets + paymaster in dashboard | Account abstraction / gas sponsorship add-on | Built-in gas sponsorship per contract |
| Polygon | Yes | Yes | Yes (it's the wallet layer Polygon's OMS builds on) |
| Notes | Most mature docs; simple | Strong multi-wallet and fintech features | Closest fit if you later adopt OMS wallets |

A reasonable default: **Privy** to launch (quickest setup), with Sequence as the alternative if you
move towards Polygon's Open Money Stack. Compare current pricing for your expected monthly active
users before deciding; all three have free tiers for development.

**Important about switching:** each provider creates *different* wallet addresses. Switching is a
config change for the code, but existing users' assets sit in their old addresses. So:

- Choose before mainnet launch if you can.
- If you switch after launch, plan a migration: keep the old provider running, and for each user sign
  a transfer of their assets/USDC from the old wallet to the new one (the API's `/me/wallet` flow
  refuses a second address, so an admin-assisted relink is needed — contact-support message shown to
  users as "account key doesn't match"). Budget time for this.

## Setup: Privy

1. dashboard.privy.io → **Create app** → name `TradeChainX (production)`.
2. **Login methods**: turn off Privy's own methods (email, social, wallets) — we sign users in ourselves.
3. **Authentication → JWT-based auth** (sometimes listed under "Custom auth"): enable it.
   - Verification: **JWKS endpoint** = `https://api.tradechainx.com/.well-known/jwks.json`
   - User ID claim: `sub`
4. **Embedded wallets → Ethereum**: create on login for **all users**. Turn off wallet UIs/confirmation modals if offered (we show our own confirmation).
5. **Settings → Domains / Allowed origins**: `https://tradechainx.com` (and staging).
6. Optional gas sponsorship: **Smart wallets** → enable for Polygon, configure a paymaster, and sponsor only our contract addresses. Then set `NEXT_PUBLIC_GAS_MODE=sponsored`.
7. Env: `WALLET_PROVIDER=privy` (API), `NEXT_PUBLIC_WALLET_PROVIDER=privy`, `NEXT_PUBLIC_PRIVY_APP_ID=<App ID>` (web build).

## Setup: Dynamic

1. app.dynamic.xyz → create a project; use the **Live** environment for production, **Sandbox** for staging.
2. **Sign-in methods → third-party auth / external JWT**: enable.
   - Issuer: `https://api.tradechainx.com`
   - JWKS URL: `https://api.tradechainx.com/.well-known/jwks.json`
   - Audience: `tradechainx-wallet`
3. **Wallets → Embedded wallets**: enable, create on sign-up, EVM.
4. **Chains**: enable Polygon (and Amoy for staging).
5. **Security → Allowed origins / CORS**: `https://tradechainx.com`.
6. Optional: account abstraction / gas sponsorship for Polygon → `NEXT_PUBLIC_GAS_MODE=sponsored`.
7. Env: `WALLET_PROVIDER=dynamic`, `NEXT_PUBLIC_WALLET_PROVIDER=dynamic`, `NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID=<Environment ID>`.

## Setup: Sequence

1. sequence.build → create a project → **Embedded Wallet**.
2. **Configuration → Login providers → add a custom OIDC provider:**
   - Issuer: `https://api.tradechainx.com` (discovery at `/.well-known/openid-configuration`)
   - Audience: `tradechainx-wallet`
3. Networks: Polygon (Amoy for staging).
4. **Gas sponsorship**: sponsor our contract addresses (from `contracts/deployments/137.json`) and native USDC's `approve` → `NEXT_PUBLIC_GAS_MODE=sponsored`.
5. Allowed origins: `https://tradechainx.com`.
6. Env: `WALLET_PROVIDER=sequence`, `NEXT_PUBLIC_WALLET_PROVIDER=sequence`, `NEXT_PUBLIC_SEQUENCE_PROJECT_ACCESS_KEY`, `NEXT_PUBLIC_SEQUENCE_WAAS_CONFIG_KEY` (both from the project's Embedded Wallet page).

Sequence wallets are smart-contract wallets. Their signatures are checked with ERC-1271/6492; the API's
wallet-linking check (viem `verifyMessage`) already handles that.

> Provider SDKs change. The adapters were written against Privy react-auth v2, Dynamic sdk-react-core v4
> and Sequence waas v2. If a hook or method name differs in the version you install, the provider's
> "custom/JWT auth" docs page shows the current name; the change is limited to that one adapter file.

## Gas

Every transaction on Polygon needs a little POL for gas. Users shouldn't have to buy it. Three modes (`NEXT_PUBLIC_GAS_MODE`):

| Mode | Who pays | When to use |
| --- | --- | --- |
| `sponsored` | The wallet provider's paymaster, billed to us | Target for production. |
| `station` | Our **gas station**: before a transaction, if the user's wallet is low, the API sends a small amount of POL (verified users only, once per 24 h, `GAS_STATION_*` settings) | Until sponsorship is set up. |
| `none` | The user | Local development (the dev faucet funds wallets). |

## Local development

`WALLET_PROVIDER=dev` derives a key in the browser from `NEXT_PUBLIC_DEV_WALLET_SEED` + email. Anyone
who knows the seed and an email can derive that key, so it's refused in production builds and must
never hold real funds.

## Switching provider — checklist

1. Set up the new provider (above) on **staging**, including allowed origins and gas.
2. Change `WALLET_PROVIDER` (api.env) and `NEXT_PUBLIC_WALLET_PROVIDER` + the provider's `NEXT_PUBLIC_*` IDs (root `.env`).
3. `./deploy/deploy.sh` (rebuilds the web image).
4. Sign in with a fresh test account: no provider pop-up appears, and the account gets a wallet.
5. For existing users, see "Important about switching" above.
