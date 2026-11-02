# TradeChainX production runbook

This is the step-by-step guide for putting TradeChainX live and keeping it running. It's written for
the developer doing the work. Follow the sections in order the first time. After that, use §11
(routine operations) and §12 (incidents) as a reference.

**Golden rules**

1. **Testnet first.** Every step below is done on Polygon Amoy (chain 80002) end to end before mainnet (chain 137).
2. **No secret ever goes in git, a zip, a chat, an email or a screenshot.** Secrets live in the secrets manager (§4) and are copied to the server as files readable only by the deploy user.
3. **Nobody holds Super Admin alone.** Super Admin is a Safe multisig (§6). Day-to-day roles belong to named people, one duty each.
4. **Back up before every deploy.** `deploy/deploy.sh` does this for you and refuses to deploy if the backup fails.

Related documents:

| Document | What it covers |
| --- | --- |
| [ACCOUNTS_AND_KEYS.md](ACCOUNTS_AND_KEYS.md) | Every outside account and key: what it's for, how to create it, where it goes. What the old keys did. |
| [WALLETS.md](WALLETS.md) | Wallet providers (Privy, Dynamic, Sequence) and how to switch. Gas. |
| [OMS_INTEGRATION.md](OMS_INTEGRATION.md) | Polygon Open Money Stack: what exists today, what we use, what's waiting. |
| [PARTNER_API.md](PARTNER_API.md) | API for third parties, webhooks, SDK and widgets. |
| [APP_INTEGRATION_MAP.md](APP_INTEGRATION_MAP.md) | Which screen calls which API and contract. |

---

## 1. What you are running

```
                    ┌────────────── Hostinger VPS (Ubuntu 24.04, Docker) ──────────────┐
 Browser ──HTTPS──▶ │ caddy ──▶ web (Next.js)                                           │
 Partners ─HTTPS──▶ │   └────▶ api (Fastify) ──▶ postgres (volume, nightly encrypted backup)│
                    │           indexer + webhook dispatcher ─┘                          │
                    └──────────────┬───────────────┬──────────────┬──────────────────────┘
                                   │               │              │
                       Polygon RPC (Alchemy)   Cloudflare R2   SendGrid       Wallet provider (Privy/Dynamic/Sequence)
                       Polygon PoS contracts   (documents,     (login codes,  Fiat ramp partner (optional)
                       + Safe multisig          backups)        alerts)
```

| Part | Where it runs | What it does |
| --- | --- | --- |
| Smart contracts | Polygon PoS | The source of truth: identities, assets, marketplace, XOwn vaults, USDC settlement. |
| `web` | VPS container | Public site, user app, admin area. Stateless. |
| `api` | VPS container | Sign-in, documents, drafts, admin queues, partner API, health monitor. Runs DB migrations on start. |
| `indexer` | VPS container (same image as api) | Reads contract events into Postgres; queues and delivers partner webhooks. |
| `postgres` | VPS container + volume | Off-chain records and a mirror of on-chain state. The mirror can always be rebuilt from the chain; off-chain records (users, KYC files, drafts) can't — that's what backups protect. |
| `caddy` | VPS container | HTTPS certificates (automatic), reverse proxy. |
| Documents | Cloudflare R2 bucket | KYC files and asset evidence. Private bucket. |

## 2. Hosting choice

**Recommended to start: one Hostinger VPS, "KVM 2" or larger** (2 vCPU, 8 GB RAM, 100 GB NVMe), Ubuntu 24.04,
in the region closest to users (for Nigeria, a European data centre usually gives the best latency).
Pick KVM 4 if you expect heavy traffic at launch or want to build images on the server comfortably.

Why this is enough: the heavy lifting (settlement, custody, consensus) happens on Polygon and at the
wallet provider. The VPS runs a web app, an API and a database for a platform that will have thousands,
not millions, of users in year one.

What we deliberately **don't** host ourselves: document storage (R2), email (SendGrid), blockchain
nodes (Alchemy/QuickNode), wallet keys (Privy/Dynamic/Sequence). Each is cheaper and safer as a service.

When to move on from one VPS (any one of these): sustained CPU > 70%, the database > 50 GB, you need
zero-downtime deploys, or a regulator/partner asks for managed-database guarantees. Next step: move
Postgres to a managed service (e.g. a managed Postgres in the same region), then run two app servers
behind a load balancer. The code already supports this (health monitor uses an advisory lock; webhook
dispatch uses `SKIP LOCKED`). The one thing to add is Redis for the partner API rate limiter (see
`apps/api/src/partner/auth.ts`).

Also enable in hPanel: **automatic weekly snapshots** (VPS → Backups). These are a second safety net,
not a substitute for the database backups in §8.

## 3. Accounts to create first

Create these before touching the server. Instructions for each are in
[ACCOUNTS_AND_KEYS.md](ACCOUNTS_AND_KEYS.md). Use a shared company mailbox (e.g. `ops@tradechainx.com`) as the owner, with
two-factor authentication on every account, and at least two team members with access.

| # | Account | Needed for |
| --- | --- | --- |
| 1 | Secrets manager (Doppler, Infisical or 1Password) | Everything below |
| 2 | Cloudflare (DNS + R2) | Domain DNS, document storage, backups |
| 3 | Hostinger VPS | Hosting |
| 4 | GitHub (organisation) | Code, CI |
| 5 | Alchemy (or QuickNode/Infura) | Polygon RPC |
| 6 | SendGrid | Login codes, alerts |
| 7 | Privy **or** Dynamic **or** Sequence | Embedded wallets ([WALLETS.md](WALLETS.md)) |
| 8 | Safe{Wallet} + hardware wallets | Super Admin multisig (§6) |
| 9 | Etherscan (API V2 key) | Verifying contract source on Polygonscan |
| 10 | Uptime monitor (UptimeRobot or Better Stack) | Outside-in monitoring (§9) |
| 11 | Slack or Telegram (optional) | Alerts |
| 12 | Ramp partner (optional, later) | Deposits/withdrawals ([OMS_INTEGRATION.md](OMS_INTEGRATION.md)) |

## 4. Secrets management

Pick **one** secrets manager and keep every secret there. Doppler and Infisical are built for app
config; 1Password works well if the team already uses it. Structure:

```
tradechainx/
  staging/   (Amoy)       api.env, postgres.env, caddy.env, backup.env, web-build.env
  production/ (Polygon)   api.env, postgres.env, caddy.env, backup.env, web-build.env
  offline/                deployer keystore password, age backup private key, Safe owner list
```

Templates for each file are in `deploy/env.templates/`. Every value marked `SECRET` there comes from
the secrets manager.

**Getting secrets onto the server.** Either use the manager's CLI on the server (e.g. `doppler secrets
download --no-file --format env > deploy/env/api.env`) or paste them in over SSH. Then:

```bash
chmod 600 deploy/env/*.env .env
```

Rules:

- Generate every random secret fresh for each environment: `openssl rand -base64 48`.
- Never reuse anything from the old codebase. The old `.env` values, the old deployer key and the old
  DB password were exposed in shared zips; treat them as public.
- When someone with access leaves: rotate `JWT_SECRET` (signs everyone out), `OTP_PEPPER`, the
  database password, SendGrid, R2 and RPC keys (§11.4).
- `NEXT_PUBLIC_*` values are **not** secrets; they're compiled into the browser bundle. Never put a
  secret in one.

## 5. Domains and DNS (Cloudflare)

1. Move `tradechainx.com`'s nameservers to Cloudflare (Cloudflare → Add site → follow the steps at your registrar).
2. Create these records, pointing at the VPS IP from hPanel. Set **Proxy status: DNS only (grey cloud)** so Caddy can obtain certificates directly:

| Type | Name | Value |
| --- | --- | --- |
| A | `@` | VPS IPv4 |
| A | `www` | VPS IPv4 |
| A | `api` | VPS IPv4 |
| AAAA | same three | VPS IPv6 (if the VPS has one) |
| CAA | `@` | `0 issue "letsencrypt.org"` |

3. Email DNS (from SendGrid → Settings → Sender Authentication → Authenticate your domain): add the CNAME records SendGrid shows. Then add:

| Type | Name | Value |
| --- | --- | --- |
| TXT | `_dmarc` | `v=DMARC1; p=quarantine; rua=mailto:ops@tradechainx.com` |

4. Staging uses subdomains: `staging.tradechainx.com` and `api.staging.tradechainx.com` (separate VPS or the same VPS with a second compose project — separate is safer).

You can switch the records to Cloudflare's proxy (orange cloud) later for DDoS protection. If you do,
set SSL/TLS mode to **Full (strict)** first.

## 6. Create the Safe multisig (Super Admin)

The Safe holds `DEFAULT_ADMIN_ROLE` on every contract: it can grant and revoke roles, resume paused
contracts, change the fee and move Super Admin. Nobody can do these alone.

1. **Choose owners and threshold.** Recommended: **3 owners, 2 signatures required** at launch (e.g. CEO, CTO, an independent board member or trusted advisor). Move to 3-of-5 as the team grows. Owners must be different people in different places.
2. **Each owner gets a hardware wallet** (Ledger or Trezor), set up by the owner personally, with the recovery phrase written on paper and stored offline. Never photograph it, type it or store it in the cloud.
3. Each owner installs a browser wallet that connects to their hardware wallet (e.g. Rabby or MetaMask → "Connect hardware wallet") and sends you their **address** (only the address).
4. One owner goes to **app.safe.global**, connects, and chooses **Create account**:
   - Network: **Polygon** (for staging: **Polygon Amoy**).
   - Name: `TradeChainX Super Admin (Polygon)`.
   - Owners: paste all owner addresses; threshold: 2.
   - Deploy. It costs a small amount of POL. The creator needs some POL in their wallet.
5. Copy the Safe address. It goes into `SUPER_ADMIN` for the contract deploy. Record the address and the owner list in the secrets manager's `offline/` section and in the company's records.
6. **Test it before mainnet.** On Amoy, do a real 2-of-3 transaction (e.g. send 0 POL to yourself) so every owner has practised signing.
7. Optional second Safe for **fees and the treasury** (`FEE_COLLECTOR`). The same owners are fine; it keeps revenue separate from admin power.

The admin area has a **Download for Safe** button next to Super Admin actions (roles, resume, fee).
It saves a Transaction Builder file. In the Safe, go to **Apps → Transaction Builder**, drag the file
in, review it, then submit it for the other owners to sign.

## 7. Deploy sequence

Do the whole sequence on **staging (Amoy)** first, run the launch rehearsal (§10.2), then repeat on production.

### 7.1 Prepare the code (on your computer)

```bash
git clone git@github.com:<org>/tradechainx.git && cd tradechainx
pnpm install                                  # creates pnpm-lock.yaml the first time — commit it
cd contracts && forge install OpenZeppelin/openzeppelin-contracts@v5.1.0 --no-git \
  && forge install OpenZeppelin/openzeppelin-contracts-upgradeable@v5.1.0 --no-git \
  && forge install foundry-rs/forge-std --no-git && forge test && cd ..
pnpm generate && pnpm test:domain && pnpm test:sdk && pnpm typecheck
```

All must pass. CI (`.github/workflows/ci.yml`) runs the same checks plus Slither and a Docker build on every push.

### 7.2 Deploy the contracts

You need: the Safe address (§6), role-holder addresses (one named person per role, from their own
hardware or embedded wallet; see [ACCOUNTS_AND_KEYS.md](ACCOUNTS_AND_KEYS.md) §Roles), an RPC URL, an Etherscan
API key, and a **fresh deployer wallet** with enough POL for gas (~5 POL on mainnet is plenty; top up
from the treasury, then empty it afterwards).

Staging (Amoy, uses a mock USDC):

```bash
cd contracts
AMOY_RPC_URL=… DEPLOYER_KEY=… SUPER_ADMIN=0xSafe… POLYGONSCAN_API_KEY=<etherscan v2 key> \
KYC_REVIEWER=0x… LISTING_REVIEWER=0x… WAREHOUSE_REGISTRAR=0x… PAUSER=0x… ASSET_MANAGER=0x… \
./deploy-amoy.sh
```

Production (Polygon, native USDC `0x3c49…3359`, hardware-wallet signer):

```bash
cd contracts
POLYGON_RPC_URL=… DEPLOYER_ADDRESS=0x… LEDGER=1 SUPER_ADMIN=0xSafe… FEE_COLLECTOR=0xTreasurySafe… \
KYC_REVIEWER=0x… LISTING_REVIEWER=0x… WAREHOUSE_REGISTRAR=0x… PAUSER=0x… ASSET_MANAGER=0x… \
ETHERSCAN_API_KEY=… FEE_BPS=100 ./deploy-polygon.sh
```

The script checks that the RPC is chain 137 and that `SUPER_ADMIN` is a deployed contract, asks you
to type `DEPLOY`, deploys and wires everything, starts the Super Admin handover to the Safe, verifies
the source on Polygonscan, and regenerates `packages/shared/src/deployments.ts`.

Then:

1. Commit `contracts/deployments/<chainId>.json` and `packages/shared/src/deployments.ts`; tag the release (`git tag v1.0.0 && git push --tags`).
2. **After `ADMIN_DELAY` (2 days by default)**, the Safe accepts Super Admin on all 7 contracts. In the Safe's Transaction Builder add 7 transactions (one per address in the deployment file: identityRegistry, warehouseRegistry, warehouseReceipt, lpoToken, carbonCredits, marketplace, xownFactory), each calling `acceptDefaultAdminTransfer()`. Collect 2 signatures, execute.
3. Check it on Polygonscan: each contract's `defaultAdmin()` returns the Safe address.
4. Empty the deployer wallet back to the treasury. It must hold nothing and no role afterwards.

### 7.3 Set up the server

```bash
# on the VPS, as root, once:
bash server-setup.sh deploy "ssh-ed25519 AAAA… you@laptop"
# then, as the deploy user:
sudo mkdir -p /srv/tradechainx && sudo chown deploy: /srv/tradechainx
git clone https://github.com/<org>/tradechainx.git /srv/tradechainx && cd /srv/tradechainx
```

(`deploy/server-setup.sh` hardens SSH, enables the firewall, fail2ban and security updates, installs Docker, age and rclone, and adds swap.)

### 7.4 Put the configuration in place

```bash
cp deploy/env.templates/api.env.example       deploy/env/api.env
cp deploy/env.templates/postgres.env.example  deploy/env/postgres.env
cp deploy/env.templates/caddy.env.example     deploy/env/caddy.env
cp deploy/env.templates/backup.env.example    deploy/env/backup.env
cp deploy/env.templates/web-build.env.example .env
# fill every value from the secrets manager, then:
chmod 600 deploy/env/*.env .env
```

Check: the password in `DATABASE_URL` equals `POSTGRES_PASSWORD`; `WALLET_PROVIDER` equals
`NEXT_PUBLIC_WALLET_PROVIDER`; `CHAIN_ID` equals `NEXT_PUBLIC_CHAIN_ID`; `DEV_TOOLS=false`.
The API refuses to start with development settings in production and tells you which one.

Set up backups (§8.1) now. The first deploy needs `deploy/env/backup.env` and the `offsite` rclone remote.

### 7.5 Deploy

```bash
./deploy/deploy.sh v1.0.0
```

It checks the files exist, backs up the database (skipped on the very first run), builds the images,
starts everything, waits for the API to be healthy, and calls `https://api.<domain>/health`.
The first run takes several minutes (image builds). Caddy obtains certificates within a minute of DNS resolving.

### 7.6 Configure the outside services that need your live URLs

1. **Wallet provider** dashboard: set the JWKS URL to `https://api.tradechainx.com/.well-known/jwks.json` (details in [WALLETS.md](WALLETS.md)). Add `https://tradechainx.com` as an allowed origin.
2. **Uptime monitor:** add HTTPS checks for `https://tradechainx.com` and `https://api.tradechainx.com/health` (keyword `"status":"ok"`), every 1–5 minutes, alerting the ops email and phone.
3. **Ramp partner** (when used): webhook URL `https://api.tradechainx.com/ramp/webhook`.

### 7.7 Create the first admin

1. The first Super Admin person signs in at `https://tradechainx.com/login` with their email (this creates their account and wallet).
2. On the server:
   ```bash
   docker compose -f docker-compose.prod.yml exec api node --import tsx src/scripts/grant-admin.ts you@tradechainx.com super_admin
   ```
3. They sign in again. Admin appears in the menu. Add the other team members through **Admin → People & roles**. Role changes that must be recorded on-chain are downloaded for the Safe.

This only unlocks the admin screens. What each person can actually approve is decided by the on-chain
roles set at deploy (§7.2), so the addresses you gave the deploy script must be those people's wallets.
If you didn't know their addresses at deploy time, grant roles afterwards from the Safe via People & roles.

### 7.8 Smoke test (every deploy)

- [ ] Home page loads over HTTPS; `https://api.<domain>/health` shows `"status":"ok"` and the right `chainId`.
- [ ] Admin → **System health**: everything green, except items marked Off on purpose.
- [ ] Sign in with a test email. The code arrives by email, and the account and wallet are created without any wallet pop-up.
- [ ] Upload a KYC document; approve it as a reviewer; the user shows as verified within a minute (indexer working).
- [ ] Staging only: issue → review → list → buy with test USDC; the buyer's portfolio updates.

## 8. Backups and restore

### 8.1 Set up (once)

1. **Encryption key.** On *your computer* (not the server): `age-keygen -o tradechainx-backup-key.txt`. Store the whole file in the secrets manager (`offline/`) and delete it from your disk. Put the public key line (`age1…`) into `deploy/env/backup.env` as `BACKUP_AGE_RECIPIENT`.
2. **Off-site bucket.** Cloudflare → R2 → create bucket `tradechainx-backups` (separate from documents). Add a lifecycle rule: delete objects after 90 days. Create an R2 API token scoped to **this bucket only**, with Object Read & Write.
3. **rclone remote** on the server: `rclone config` → new remote named `offsite` → type `s3` → provider `Cloudflare` → paste the token's access key and secret → endpoint `https://<account-id>.r2.cloudflarestorage.com`.
4. **Schedule:** `crontab -e` as the deploy user:
   ```
   15 2 * * * cd /srv/tradechainx && ./deploy/backup.sh >> /home/deploy/backup.log 2>&1
   ```
5. Run `./deploy/backup.sh` once by hand and confirm the file appears in the bucket.

What's covered: the database (nightly and before every deploy, 14 days on the server, 90 days
off-site). Documents are in R2, which is already replicated; turn on **R2 bucket versioning/lifecycle**
if you want protection against accidental deletes. The blockchain needs no backup.

### 8.2 Test the restore (monthly, and before launch)

```bash
# fetch the private key file from the secrets manager to the server temporarily, then:
./deploy/restore.sh backups/<latest>.dump.age /tmp/backup-key.txt
shred -u /tmp/backup-key.txt
```

It restores into a separate database, `tradechainx_restore`, and prints user count, indexer cursor and
the last migration. Record the date and result in the ops log. A backup you haven't restored isn't a backup.

### 8.3 Real restore (after data loss)

1. Put up a notice (status page or social), then `docker compose -f docker-compose.prod.yml stop api indexer web`.
2. Restore into `tradechainx_restore` (§8.2) and check the numbers.
3. Swap: `docker compose -f docker-compose.prod.yml exec postgres psql -U tradechainx -d postgres -c "ALTER DATABASE tradechainx RENAME TO tradechainx_broken" -c "ALTER DATABASE tradechainx_restore RENAME TO tradechainx"`.
4. `docker compose -f docker-compose.prod.yml up -d`. The indexer continues from the restored cursor and replays anything on-chain since the backup, so asset ownership, listings and trades are complete again. Only off-chain work since the backup (new sign-ups, uploaded files, drafts) is lost; affected users re-submit.
5. When everything checks out, drop `tradechainx_broken`.

If the whole VPS is lost: create a new VPS, run §7.3–7.5 with the same env files, then §8.3 steps 2–4. Update the DNS A records to the new IP.

## 9. Monitoring and alerts

Three layers:

| Layer | Tool | Catches |
| --- | --- | --- |
| Outside-in | UptimeRobot / Better Stack on `/health` and the home page | Server down, DNS/TLS broken, whole-site outages. Works even if our server is dead. |
| Inside | **Admin → System health** + alerts | Each dependency individually (below), with alerts on change. |
| Logs | `docker compose -f docker-compose.prod.yml logs -f api indexer` | Detail when investigating. JSON logs; secrets and cookies are redacted. |

**System health** checks every 60 seconds (`HEALTH_CHECK_INTERVAL_SECONDS`):

| Check | Red / amber means | First thing to do |
| --- | --- | --- |
| API, Database | API can't reach Postgres | `docker compose … ps`, `logs postgres`; disk full? (`df -h`) |
| Blockchain node (RPC) | Wrong chain, unreachable, or stale blocks | Check the RPC provider's status (listed under Suppliers). Switch `RPC_URL` to a backup provider and restart api+indexer. |
| Indexer | More than `INDEXER_MAX_LAG_BLOCKS` behind | `logs indexer`. Usually RPC limits. Restart indexer; it resumes from its cursor. |
| Smart contracts | A contract is paused | Expected during an incident; otherwise find out who paused it. |
| Configuration | Not production mode, or bad `STATUS_PAGES` | Fix env, redeploy. |
| Email | SendGrid key rejected / lacks Mail Send | Rotate the key (§11.4). Users can't sign in until fixed. |
| Document storage | Can't write/read R2 | Check R2 token and bucket. |
| Wallet provider | Signing key missing | Set `WALLET_TOKEN_PRIVATE_KEY`. Provider outages show under Suppliers. |
| Fiat ramp | Provider unreachable / misconfigured | Contact the ramp partner. Deposits pause, nothing else. |
| Gas station | Balance low (amber < 25 top-ups, red < 5) | Send POL from the treasury to the gas-station address. |
| Partner webhooks | Deliveries backing up | Admin → Partners → deliveries: partner endpoint down? |
| Suppliers | Polygon, Alchemy, SendGrid, Cloudflare, Privy, Hostinger, GitHub status pages | Nothing to fix on our side; tell users if affected. |

Alerts go to every configured channel (`ALERT_EMAILS`, Slack webhook, Telegram bot). They fire when a
check turns amber/red **and stays so for one more run**, and again on recovery. Suppliers only alert on
a major outage. Configure at least two channels so an email outage doesn't hide an email outage.

Add more supplier status pages without code: `STATUS_PAGES='[{"name":"Dynamic","url":"https://…","kind":"http"}]'`
(`kind` = `statuspage` for Atlassian pages, `instatus`, or `http` for any URL that returns 2xx when fine).

Also watch: disk usage (Hostinger panel alerts at 80%), and the monthly bills of RPC/SendGrid/wallet
provider for unexpected spikes.

## 10. Mainnet launch checklist

### 10.1 Before the rehearsal

- [ ] **Independent smart-contract audit** completed; all high/medium findings fixed and re-tested. Publish the report.
- [ ] Slither clean in CI; `forge coverage` reviewed for the money paths (buy, settle, subscribe, yield, refund, redeem).
- [ ] Legal: terms of use, privacy policy, risk disclosures for XOwn (earnings are not guaranteed), regulatory view on tokenized receipts/LPOs/fractional equipment in each launch market (Nigeria: SEC Nigeria's digital-asset rules; warehouse receipts: the relevant commodity exchange/warehouse regulation). Get this in writing.
- [ ] KYC/KYB procedure written: what documents, who reviews, how long records are kept.
- [ ] Safe created, all owners have practised signing (§6).
- [ ] Every role holder is a named person with their own wallet; no person holds two review roles for the same flow.
- [ ] Wallet provider on a production plan; gas sponsorship configured or gas station funded.
- [ ] Secrets all in the secrets manager; nothing from the old codebase reused.

### 10.2 Staging rehearsal (Amoy) — all must pass

- [ ] Full deploy sequence §7 done from scratch by someone reading this runbook.
- [ ] Every user journey clicked through by a non-developer: sign-up → KYC → issue receipt → review → list → buy; LPO → settle; carbon → retire; XOwn → subscribe → yield → claim → dissolve → redeem; failed offering → refund.
- [ ] **Pause drill:** the pauser pauses the marketplace from Admin → Controls; buying fails with a clear message; the Safe resumes it via Download for Safe.
- [ ] **Restore drill:** §8.2 done, result recorded.
- [ ] **Alert drill:** stop the indexer for 10 minutes; confirm the alert arrives on every channel, then the recovery message.
- [ ] Partner API: create a test partner, key and webhook; receive a signed `ping`; verify it with the SDK.
- [ ] Load: 50 concurrent users browsing marketplace pages without errors (a simple k6 or autocannon run).

### 10.3 Launch day

- [ ] Contracts deployed to Polygon with `deploy-polygon.sh` from the release tag; source verified on Polygonscan.
- [ ] After `ADMIN_DELAY`: Safe accepted Super Admin on all 7 contracts; `defaultAdmin()` checked on each.
- [ ] Deployer wallet emptied.
- [ ] Production server deployed (§7.3–7.7); smoke test §7.8 passes (without test purchases).
- [ ] System health all green; uptime monitor green; backup ran and reached R2.
- [ ] Soft launch: invite-only first users for 1–2 weeks with low value limits, then open up.

## 11. Routine operations

### 11.1 Deploy a new version

```bash
cd /srv/tradechainx && git fetch --tags && ./deploy/deploy.sh v1.2.0
```

Expect ~30 seconds of API restart. Deploy at quiet hours. Database migrations run automatically and are forward-only.

### 11.2 Roll back

```bash
./deploy/deploy.sh v1.1.0
```

If the newer version applied a database migration, the old code usually still works (migrations only
add). If not, restore the pre-deploy backup (`backups/*-pre-deploy.dump.age`) per §8.3.

### 11.3 Change a setting

Edit it in the secrets manager, copy it to `deploy/env/api.env`, then
`docker compose -f docker-compose.prod.yml up -d api indexer`. A `NEXT_PUBLIC_*` change needs a
rebuild: `./deploy/deploy.sh`.

### 11.4 Rotate a secret

| Secret | How | Side effect |
| --- | --- | --- |
| `JWT_SECRET` | New random value, restart api | Everyone signed out |
| `OTP_PEPPER` | New random value, restart api | Outstanding login codes stop working |
| DB password | `ALTER USER tradechainx PASSWORD '…'` in psql, update both env files, restart | None |
| SendGrid / R2 / RPC keys | Create new key in the provider, update env, restart, then delete the old key | None |
| `WALLET_TOKEN_PRIVATE_KEY` | New key with a new `WALLET_TOKEN_KID`, restart | Providers re-fetch JWKS; users' wallets are unaffected |
| `WEBHOOK_SECRET_PEPPER` | Changes **every** partner's webhook secret. Prefer per-webhook "Rotate secret" in Admin → Partners | Partners must update |
| Gas station key | New wallet, move the balance, update env | None |

### 11.5 Admin tasks

- **Add/remove team members:** Admin → People & roles. On-chain changes → Download for Safe → sign.
- **Someone leaves:** remove their roles (Safe revokes on-chain), remove them from the secrets manager, GitHub, Hostinger, Cloudflare; rotate what they had access to (§11.4). If they were a Safe owner, the Safe removes them (Settings → Owners) and you add a replacement.
- **Refill the gas station:** send POL to its address (shown on System health).
- **Add a partner:** Admin → Partners ([PARTNER_API.md](PARTNER_API.md)).

### 11.6 Housekeeping

Monthly: restore test (§8.2), `sudo apt update && sudo apt upgrade` (security updates are automatic,
this catches the rest), `docker system df` to check image disk use, review Admin → People & roles for stale access.

## 12. Incident response

**First move in any incident involving funds or assets: pause.** The pauser (a single person, for
speed) can pause any contract from Admin → Controls. Pausing stops listing, buying, settling and
subscribing; it never moves anyone's assets. Only the Safe can resume, which forces a second pair of eyes.

| Situation | Do this |
| --- | --- |
| Site down | Check the uptime monitor and Hostinger status. SSH in: `docker compose -f docker-compose.prod.yml ps`; restart the failed service; `logs --tail=200 <service>`. Disk full → `docker system prune`, delete old `backups/`. |
| Suspicious on-chain activity (unexpected transfers, listings, role changes) | **Pause** the affected contracts. Tell the Safe owners. Examine on Polygonscan and in `chain_events`. Don't resume until the cause is understood. |
| A role holder's wallet may be compromised | Pause if they hold an approve/issue role. Safe revokes their role (People & roles → Download for Safe). Grant the role to a new wallet. |
| A Safe owner's device is lost | The other owners replace that owner in the Safe (Settings → Owners → Replace). No funds are at risk while the threshold holds. |
| Secret leaked (committed, pasted, shared) | Rotate it immediately (§11.4), then check the provider's logs for misuse. Assume anything in a leaked file is compromised. |
| RPC provider outage | Switch `RPC_URL` (and `NEXT_PUBLIC_RPC_URL`, rebuild) to a second provider; keep one configured in the secrets manager in advance. |
| Wallet provider outage | Users can browse but not transact. Post a notice; nothing to fix on our side. |
| Data loss | §8.3. |

After every incident: write a short note (what happened, impact, fix, what we'll change) within 48 hours.
