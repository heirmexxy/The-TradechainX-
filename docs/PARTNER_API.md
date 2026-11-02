# TradeChainX Partner API

For verified businesses that want to build on TradeChainX: show live offerings, assets and listings on
their own site; submit assets for review from their own systems; prepare purchases; and get notified
by webhook when things happen. Plus a JavaScript SDK and drop-in widgets.

- Base URL: `https://api.tradechainx.com/partner/v1` (staging: `https://api.staging.tradechainx.com/partner/v1`)
- Machine-readable spec: [`partner-openapi.yaml`](partner-openapi.yaml)
- SDK: `packages/sdk` ([README](../packages/sdk/README.md))
- Widgets: `https://tradechainx.com/embed.js`

## Ground rules

1. **Partners are verified businesses.** A partner is linked to a TradeChainX account that has passed business verification (KYB) and holds a valid Business or Institutional identity on-chain. If that lapses (expiry, freeze), `issue` and `trade` stop working until it's renewed; `read` keeps working.
2. **The review gate applies to everyone.** Anything a partner submits lands in the same reviewer queue as the TradeChainX app, and a reviewer approves or rejects it. There's no fast lane.
3. **TradeChainX never signs for you.** `issue` and `trade` endpoints return *prepared contract calls*. Your own wallet (the partner account's wallet — use a Safe or a KMS-backed signer, not a hot key on a laptop) signs and sends them. The smart contracts enforce every rule again on-chain.
4. **Server-to-server only.** API keys must never be in a browser or mobile app. The API sends no CORS headers for `/partner/*`. For the browser, use the widgets.

## Getting access (partner onboarding — done by TradeChainX)

1. The partner signs up on tradechainx.com and completes **business verification**.
2. A TradeChainX Super Admin opens **Admin → Partners → Add partner**, enters the partner's account email; the system refuses unless the account is a verified business.
3. The admin creates an **API key** with scopes and limits, and (optionally) **webhooks**. The key and webhook secret are shown **once**. Send them through a secure channel (a password-manager share), never by email or chat.
4. The admin gives the partner their **referral code** and the widget snippet (shown on the partner page).

Suspending a partner (Admin → Partners → Suspend) blocks all its keys immediately. Revoking a key takes effect on the next request.

## Authentication, scopes and limits

```
Authorization: Bearer tcx_live_1a2b3c4d_<secret>
```

Keys start `tcx_live_` (production) or `tcx_test_` (staging/dev). Only a hash is stored; lost keys are replaced, not recovered.

| Scope | Grants |
| --- | --- |
| `read` | Offerings, assets, listings, your webhooks and delivery log |
| `issue` | Upload documents, create drafts (submissions for review), list your drafts |
| `trade` | Prepared calls to buy, list, cancel, subscribe to XOwn, settle LPOs |

Each key has a **per-minute rate limit** (default 60) and a **daily quota** (default 10,000; resets
00:00 UTC). Responses carry `X-RateLimit-Limit` / `X-RateLimit-Remaining`; a 429 carries `Retry-After`.

## Errors

JSON body `{ "error": "<code>", "message": "<human text>" }`.

| HTTP | `error` | Meaning |
| --- | --- | --- |
| 400 | `invalid_input` / `bad_request` | Field problem; `issues[]` lists them |
| 401 | `invalid_api_key` | Missing, malformed, unknown or revoked key |
| 403 | `insufficient_scope` | Key lacks the scope |
| 403 | `not_verified` | Partner account isn't a currently verified business |
| 403 | `partner_suspended` | Contact TradeChainX |
| 404 | `not_found` | |
| 409 | `wallet_required` / `conflict` | e.g. duplicate reference number already live |
| 429 | `rate_limited` / `quota_exceeded` | Slow down / wait for reset |

## Amounts and IDs

- USDC amounts are **integer strings in base units** (6 decimals): `"2500000"` = 2.50 USDC.
- Token IDs, listing IDs and share counts are integer strings (they can exceed JavaScript's safe integer range).
- Addresses are lowercase hex.
- Prepared-call arguments encode big integers as `{"$bigint": "123"}`. The SDK's `reviveCalls()` converts them.

## Endpoints

### Account

| Method | Path | Scope | Returns |
| --- | --- | --- | --- |
| GET | `/me` | any | Partner, account wallet and verification, key scopes/limits/usage today, chain id and contract addresses |
| GET | `/events` | any | Webhook event catalogue |

### Read

| Method | Path | Query | Notes |
| --- | --- | --- | --- |
| GET | `/offerings` | | XOwn offerings (open and closed) with public details |
| GET | `/offerings/{vault}` | | One offering + holder count |
| GET | `/assets` | `type`, `owner`, `limit` (≤100), `cursor` | Issued warehouse receipts, LPOs, carbon batches. Paginate with `nextCursor`. |
| GET | `/assets/{type}/{id}` | | One asset. `type` = `warehouse-receipt` \| `lpo` \| `carbon` |
| GET | `/listings` | `type`, `seller`, `limit` | Active marketplace listings with their asset |
| GET | `/listings/{id}` | | One listing |

Only public details are returned (the same as the public site). Private fields such as buyer
registration numbers or receipt numbers never leave TradeChainX.

### Issue (submit for review)

1. **Upload each supporting document** — `POST /documents`, `multipart/form-data` with `file` (PDF/JPG/PNG, ≤ 15 MB) and `kind`. Returns `{ document: { id, sha256 } }`. The SHA-256 is anchored on-chain with the submission.
2. **Create the draft** — `POST /drafts/{type}` with `{ fields, documentIds }`. Returns `{ draft, calls, signer }`.
3. **Send `calls`** from `signer` (your account wallet), in order, waiting for each to confirm.
4. Optionally `POST /drafts/{id}/tx` with `{ txHash }`.
5. Watch `submission.received`, then `asset.issued` / `submission.needs_info` / `submission.rejected` webhooks, or poll `GET /drafts`.

Fields by type (dates are `YYYY-MM-DD`):

**`warehouse-receipt`** (your account must operate the warehouse): `warehouseId` (number), `receiptNumber`, `commodity` (≤31 chars, e.g. `MAIZE`), `grade`, `quantity` (integer), `unit` (`kg`|`tonne`|`bag`), `depositDate`, `expiryDate`, `holderEmail` (a verified TradeChainX user who will own the receipt), `notes?`.

**`lpo`** (purchase order you've received): `lpoNumber`, `buyerName`, `buyerRegistrationNumber`, `description` (≤31 chars), `faceValue` (USDC, decimal string e.g. `"12500.00"`), `issueDate`, `dueDate`, `notes?`.

**`carbon`**: `registry` (`VERRA`|`GOLD_STANDARD`|`PURO_EARTH`|`ISOMETRIC`|`OTHER`), `registryBatchId`, `projectId`, `projectName`, `methodology` (≤31 chars), `vintage` (year), `quantity` (tonnes, integer), `country?`, `notes?`.

XOwn offerings can't be proposed through the API: the contracts only accept proposals from TradeChainX's
asset managers. To list equipment on XOwn, contact TradeChainX; you can be the offering's operator.

### Trade (prepared calls)

All return `{ signer, calls, totalUsdc? }`. Send the calls from `signer` in order.

| Method | Path | Body | Calls |
| --- | --- | --- | --- |
| POST | `/trade/buy` | `{ listingId, amount? }` | approve USDC → `buy` (price protected: the call fails if the price rose) |
| POST | `/trade/list` | `{ assetType, tokenId, amount?, pricePerUnit }` | approve asset → `list` (the marketplace holds the asset until sold or cancelled) |
| POST | `/trade/cancel` | `{ listingId }` | `cancel` |
| POST | `/trade/subscribe` | `{ vault, shares }` | approve USDC → `subscribe` |
| POST | `/trade/settle-lpo` | `{ tokenId }` | approve USDC → `settle` (pays the face value to the LPO's current holder) |

Your account wallet needs USDC for purchases and a little POL for gas (or gas sponsorship).

### Webhooks (view)

| Method | Path | Scope |
| --- | --- | --- |
| GET | `/webhooks` | read |
| GET | `/webhooks/{id}/deliveries` | read |

Webhook endpoints are created, paused and rotated by TradeChainX admins on request.

## Webhooks

TradeChainX POSTs JSON to your HTTPS endpoint:

```http
POST /webhooks/tradechainx
Content-Type: application/json
TradeChainX-Signature: t=1790000000,v1=5f2b…c9
TradeChainX-Event: lpo.settled
TradeChainX-Delivery: 7d1e…  (same on retries)

{"id":"evt_137_0xabc…_3","type":"lpo.settled","created":"2026-10-01T09:12:44.000Z","livemode":true,
 "data":{"tokenId":"42","holder":"0x…","payer":"0x…","amount":"12500000000","method":"onchain",
         "chainId":137,"txHash":"0x…","blockNumber":"61234567","contract":"0x…"}}
```

**Verify every delivery.** `v1` = hex HMAC-SHA256 of `"<t>.<raw body>"` with your signing secret. Reject
if the signature differs or `t` is more than 5 minutes old. With the SDK:

```ts
const event = await verifyWebhook({ payload: rawBody, header: req.headers["tradechainx-signature"], secret });
```

Without the SDK (Node):

```js
const [t, v1] = header.split(",").map((p) => p.split("=")[1]);
const expected = crypto.createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
const ok = crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(v1)) && Math.abs(Date.now() / 1000 - Number(t)) < 300;
```

**Delivery:** reply 2xx within 10 seconds (do slow work afterwards). Otherwise retries after 1 min, 5 min,
30 min, 2 h, 6 h, 12 h, 24 h, then the delivery is marked failed (admins can retry it). Events can arrive
more than once and out of order — de-duplicate on `id`, and use `blockNumber` to order.

**Events.** *Public* events go to every subscribed partner; *own* events only when your account wallet is involved.

| Type | Audience | `data` |
| --- | --- | --- |
| `submission.received` | own | assetType, submissionId |
| `submission.needs_info` | own | assetType, submissionId, reasonRef (the reviewer's note is on tradechainx.com) |
| `submission.rejected` | own | assetType, submissionId, reasonRef |
| `asset.issued` | public | assetType, tokenId, submissionId, holder / originator, quantity |
| `listing.created` | public | listingId, seller, asset, tokenId, amount, pricePerUnit |
| `listing.sold` | public | listingId, buyer, seller, amount, totalPrice, fee |
| `listing.cancelled` | public | listingId |
| `lpo.settled` | own (holder or payer) | tokenId, holder, payer?, amount?, method (`onchain` \| `offchain`) |
| `xown.offering_created` | public | proposalId, vault |
| `xown.subscribed` | own | vault, investor, shares, paid |
| `xown.offering_funded` | public | vault, raised, operator |
| `xown.offering_failed` | public | vault |
| `xown.yield_deposited` | public | vault, amount |
| `carbon.retired` | own | retirementId, batchId, holder, amount |
| `ping` | — | test event from the admin "Send test" button |

Every event's `data` also has `chainId`, `txHash`, `blockNumber`, `contract`. Events are sent once the
indexer has seen the block with the configured confirmations (5 on mainnet), so they're final in practice.

## Widgets

Add the script once, then place elements where you want widgets:

```html
<script src="https://tradechainx.com/embed.js" data-api="https://api.tradechainx.com" defer></script>

<!-- one XOwn offering card -->
<div data-tradechainx="offering" data-vault="0x…" data-ref="YOURCODE"></div>

<!-- the latest open offerings -->
<div data-tradechainx="offerings" data-limit="3" data-ref="YOURCODE"></div>

<!-- a button for an offering or a listing -->
<div data-tradechainx="buy-button" data-vault="0x…" data-ref="YOURCODE" data-label="Invest now"></div>
<div data-tradechainx="buy-button" data-listing="12" data-ref="YOURCODE"></div>
```

Options: `data-theme="dark"`, `data-label`. Widgets render in a Shadow DOM, set no cookies and load
public data only (from `/embed/v1/*`, cacheable for 30 s). For content added after page load, call
`window.TradeChainX.scan()`.

Buttons open TradeChainX in a new tab. The buyer signs in, is verified if new, and pays there;
**no payment happens on your site**. `data-ref` is remembered for 30 days on the buyer's device; purchases
are then recorded against your partner account (visible to TradeChainX admins for revenue-share reporting).

## Changes and versioning

`/partner/v1` only gets additive changes (new fields, new endpoints, new event types — ignore what you
don't know). Breaking changes go to `/v2` with at least 90 days' notice.
