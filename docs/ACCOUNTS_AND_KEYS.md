# Accounts and keys

Every outside service TradeChainX uses: what it's for, how to create the account and key, and exactly
where the value goes. Put every key in the secrets manager first, then copy it to the server
(see [PRODUCTION_RUNBOOK.md](PRODUCTION_RUNBOOK.md) §4).

General rules for every account:

- Owner is a company mailbox (e.g. `ops@tradechainx.com`), not a personal email. At least two admins.
- Two-factor authentication on (an authenticator app, not SMS, where offered).
- Create **separate keys for staging and production**, named so you can tell them apart (`tcx-prod-api`, `tcx-staging-api`).
- Give each key the smallest permission that works (noted below).

## What happened to the old keys

The old codebase had keys for AWS, Cloudinary, SendGrid, Sendinblue, IPFS, Polygonscan, BscScan and
CoinMarketCap. **All of them were in shared zip files, so revoke every one of them in its provider's
dashboard** even if you think it's unused. Then:

| Old service | What it did | In the rebuild |
| --- | --- | --- |
| AWS (S3 etc.) | File storage and hosting | **Replaced.** Hosting → Hostinger VPS. Files → Cloudflare R2 (S3-compatible, no egress fees). Close the AWS resources once nothing points at them. |
| Cloudinary | Image upload, resizing and CDN (profile/asset pictures) | **Not needed.** Documents are stored privately in R2 and are PDFs/scans, not images to transform. If you add public images later (e.g. equipment photos on XOwn pages), R2 + Cloudflare Images or Next.js image optimisation covers it. Delete the account. |
| SendGrid | Transactional email | **Kept** — new account/key below. |
| Sendinblue (now called **Brevo**) | Email/SMS marketing and transactional email | **Not needed** for the platform: SendGrid sends login codes and alerts. Keep Brevo only if marketing uses it for newsletters, with a new key that the platform never sees. |
| IPFS (Pinata / Infura IPFS) | Storing NFT metadata and files on IPFS | **Not needed now.** Documents are never public: only their SHA-256 hashes go on-chain, and token metadata is served by our API (`/metadata/draft/:id`). IPFS pinning is an optional later step if you want metadata to outlive the company's servers. |
| Polygonscan | Verifying contract source code; reading chain data | **Replaced by one Etherscan API V2 key**, which covers Polygon, Amoy and 60+ other chains. Etherscan retired the per-chain (V1) keys in 2025. |
| BscScan | The same for BNB Chain | **Not needed** — we don't deploy on BNB Chain. The Etherscan V2 key would cover it anyway. |
| CoinMarketCap | Crypto price data | **Not needed.** Everything is priced and settled in USDC (1 USDC = 1 US dollar), so there's no price feed. Delete the key. |

**Old database password and JWT secret:** the rebuild uses a brand-new database and new secrets, so
there is nothing to rotate *in the new system*. What's still needed: shut down the **old** database
(or at least change its password and close it to the internet), because it may still hold users'
personal data. Don't copy any old secret into the new system.

---

## 1. Secrets manager

Pick one: **Doppler** (doppler.com), **Infisical** (infisical.com) or **1Password** (Business, with Secrets Automation).

1. Create the workspace/vault `tradechainx` with environments `staging` and `production`, plus an `offline` vault for the highest-value items.
2. Invite the team with least access: developers get staging, 1–2 people get production.
3. Install its CLI on the server if you want to pull env files directly (optional).

## 2. Cloudflare (DNS, document storage, backups)

1. Sign up at dash.cloudflare.com → **Add a site** → `tradechainx.com` → Free plan → change the nameservers at your registrar to the two Cloudflare shows.
2. **R2** (left menu → R2 Object Storage → subscribe; there's a free tier) → **Create bucket**:
   - `tradechainx-documents` (production), `tradechainx-documents-staging`, `tradechainx-backups`.
   - Keep them **private** (no public access, no r2.dev URL).
3. **R2 → Manage API tokens → Create API token:**
   - Permission: **Object Read & Write**; apply to **specific bucket** `tradechainx-documents` only.
   - Copy the **Access Key ID**, **Secret Access Key** and the S3 endpoint `https://<account-id>.r2.cloudflarestorage.com`.
   - → `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_ENDPOINT`; `S3_BUCKET=tradechainx-documents`; `S3_REGION=auto`; `STORAGE_PROVIDER=s3`.
4. A **second token** limited to `tradechainx-backups` → the rclone `offsite` remote (runbook §8.1).

## 3. Hostinger VPS

1. hostinger.com → VPS → **KVM 2** (or larger) → OS: **Ubuntu 24.04** (plain, no panel).
2. Set a strong root password (you'll disable password login shortly) and add your SSH public key.
3. Enable weekly automatic backups in hPanel.
4. Note the IPv4 (and IPv6) address for DNS. Continue with runbook §7.3.

## 4. GitHub

1. Create an organisation (e.g. `tradechainx`), make the repository **private**.
2. Require 2FA for the organisation; protect `main` (pull requests + passing CI required).
3. Enable **secret scanning** and **push protection** (Settings → Code security), so a committed key is blocked.

## 5. Polygon RPC (Alchemy — or QuickNode/Infura)

1. alchemy.com → create an app → chain **Polygon PoS**, network **Mainnet** (another for **Amoy**).
2. Copy the HTTPS URL (it contains the key) → `RPC_URL` in `api.env`. This one is a secret.
3. For the **browser** (`NEXT_PUBLIC_RPC_URL`) use a *separate* key with **allowlisted domains** set to `tradechainx.com` (Alchemy: app → Security → Allowlist), or a public endpoint. Never reuse the API's key there.
4. Create an account with a second provider too and keep its URL in the secrets manager as a failover.

## 6. SendGrid (email)

1. sendgrid.com → sign up with the company mailbox.
2. **Settings → Sender Authentication → Authenticate Your Domain** → `tradechainx.com` → add the CNAME records it shows in Cloudflare (DNS only) → Verify.
3. **Settings → API Keys → Create API Key** → **Restricted Access** → turn on only **Mail Send** → Full Access. Name `tcx-prod-api`.
4. → `SENDGRID_API_KEY`, `EMAIL_PROVIDER=sendgrid`, `EMAIL_FROM=no-reply@tradechainx.com`.
5. System health verifies the key has the Mail Send permission.

## 7. Wallet provider (pick one)

Full setup, including the dashboard settings, is in [WALLETS.md](WALLETS.md). In short:

| Provider | Where | Values |
| --- | --- | --- |
| Privy | dashboard.privy.io → create app | App ID → `NEXT_PUBLIC_PRIVY_APP_ID` |
| Dynamic | app.dynamic.xyz → create project | Environment ID → `NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID` |
| Sequence | sequence.build → create project → Embedded Wallet | Project Access Key, WaaS Config Key → `NEXT_PUBLIC_SEQUENCE_*` |

All three need our **wallet-token signing key**:

```bash
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out wallet-token.pem
awk 'NF {sub(/\r/, ""); printf "%s\\n",$0;}' wallet-token.pem   # one-line form for the env file
```

→ `WALLET_TOKEN_PRIVATE_KEY` (secret), `WALLET_TOKEN_KID=tcx-2026-1`, `WALLET_TOKEN_AUDIENCE=tradechainx-wallet`. Delete the `.pem` after storing it.

## 8. Safe{Wallet} multisig and hardware wallets

Step-by-step creation is in the runbook §6. You need:

- 3 hardware wallets (Ledger Nano S Plus/X or Trezor), one per owner, bought new from the manufacturer.
- A small amount of POL for the Safe creation and for executing Safe transactions (any owner's wallet can pay).
- Record: Safe address, network, owners, threshold → secrets manager `offline/`.

## 9. Etherscan API V2 key (contract verification)

1. etherscan.io → sign up → **API Keys** → **Add**. Name `tcx-verify`.
2. One key works for Polygon and Amoy.
3. → `ETHERSCAN_API_KEY` for `deploy-polygon.sh` (and `POLYGONSCAN_API_KEY` for `deploy-amoy.sh`, same value). It's only used on the computer that deploys; it never goes on the server.

## 10. Deployer wallet (one-off)

A fresh wallet used only to send the deploy transactions, then emptied.

- Mainnet: use a **Ledger** (`LEDGER=1`, and `DEPLOYER_ADDRESS` = its address) or a Foundry keystore: `cast wallet import tcx-deployer --interactive` (`DEPLOYER_ACCOUNT=tcx-deployer`). Raw private keys are refused by `deploy-polygon.sh`.
- Amoy: a throwaway key is fine (`DEPLOYER_KEY`), funded from a faucet.
- Never reuse the old TradeChainX deployer key; it was exposed.

## 11. Gas station wallet (only if not using gas sponsorship)

1. `cast wallet new` → store the private key in the secrets manager → `GAS_STATION_KEY`, `GAS_STATION_ENABLED=true`.
2. Fund it with a **small float** (e.g. 20–50 POL); refill when System health turns amber.
3. Turn it off (`GAS_STATION_ENABLED=false`) once the wallet provider sponsors gas.

## 12. Alerts

- **Email:** `ALERT_EMAILS=ops@tradechainx.com,cto@…` (sent through SendGrid).
- **Slack:** api.slack.com/apps → Create app → Incoming Webhooks → On → Add to `#ops-alerts` → copy URL → `ALERT_SLACK_WEBHOOK_URL`.
- **Telegram:** message **@BotFather** → `/newbot` → copy the token → `ALERT_TELEGRAM_BOT_TOKEN`; add the bot to your ops group, send a message, open `https://api.telegram.org/bot<TOKEN>/getUpdates` and copy `chat.id` (negative number for groups) → `ALERT_TELEGRAM_CHAT_ID`.
- **Uptime monitor:** uptimerobot.com or betterstack.com → HTTPS monitors (runbook §7.6).

## 13. Other generated secrets

| Variable | How |
| --- | --- |
| `JWT_SECRET`, `OTP_PEPPER`, `WEBHOOK_SECRET_PEPPER` | `openssl rand -base64 48` (each different) |
| `POSTGRES_PASSWORD` | `openssl rand -base64 32 \| tr -d '/+='` (also inside `DATABASE_URL`) |
| Backup key | `age-keygen` (runbook §8.1) |

## Roles: who holds what

On-chain roles decide who can approve what. Give each to a **named person's own wallet**. Admin
wallets are ordinary TradeChainX accounts (the person signs in, which creates their wallet; copy the
address from Admin → People & roles).

| Role | Can | Holder | Separation rule |
| --- | --- | --- | --- |
| Super Admin (`DEFAULT_ADMIN_ROLE`) | Grant/revoke roles, resume, fees, move Super Admin | **Safe multisig only** | Never a single person |
| KYC reviewer | Verify people and businesses | Compliance officer | Can't be the listing reviewer for the same person's assets |
| Listing reviewer | Approve/reject submitted assets and status changes | Operations/credit lead | The contracts block reviewing your own submission |
| Warehouse registrar | Register warehouses | Operations | — |
| Asset manager | Propose XOwn offerings | Investment lead | The listing reviewer approves the proposal, not the asset manager |
| Pauser | Pause contracts (not resume) | CTO or on-call engineer | Single person on purpose — speed in an emergency |
| Fee collector | Receives fees | Treasury Safe | — |
