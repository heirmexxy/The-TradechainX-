# @tradechainx/sdk

Dependency-free client for the TradeChainX Partner API, plus webhook verification.
Node 18+, Deno, Bun and edge runtimes. **Server-side only** — never put an API key in a browser.

Full reference: `docs/PARTNER_API.md` (and `docs/partner-openapi.yaml`).

```ts
import { TradeChainX, reviveCalls, verifyWebhook } from "@tradechainx/sdk";

const tcx = new TradeChainX({ apiKey: process.env.TRADECHAINX_API_KEY!, baseUrl: "https://api.tradechainx.com" });

// read
const { offerings } = await tcx.offerings.list();
const { listings } = await tcx.listings.list({ type: "lpo" });

// issue: upload evidence, create a draft, sign + send the returned call from YOUR verified wallet
const { document } = await tcx.documents.upload(pdfBlob, { filename: "lpo-2231.pdf", kind: "lpo" });
const { draft, calls } = await tcx.drafts.create("lpo", { fields: { /* see docs */ }, documentIds: [document.id] });

// trade: prepared calls (approve USDC + buy)
const buy = await tcx.trade.buy({ listingId: 12, amount: 1 });
```

## Sending prepared calls (viem example)

TradeChainX never signs for you. Every `issue`/`trade` response contains `calls` for the `signer`
wallet (your verified business account's wallet — ideally a Safe or a KMS-backed signer):

```ts
import { createWalletClient, http, parseAbi } from "viem";
import { polygon } from "viem/chains";
import { abis } from "./tradechainx-abis"; // or fetch ABIs from the repo's packages/shared/src/abis

for (const c of reviveCalls(buy.calls)) {
  const hash = await wallet.writeContract({ address: c.address, abi: abis[c.contract], functionName: c.functionName, args: c.args });
  await publicClient.waitForTransactionReceipt({ hash }); // run calls in order
}
```

## Webhooks

```ts
// Express: use the RAW body — re-serialised JSON won't match the signature.
app.post("/webhooks/tradechainx", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    const event = await verifyWebhook({
      payload: req.body.toString("utf8"),
      header: req.get("TradeChainX-Signature"),
      secret: process.env.TRADECHAINX_WEBHOOK_SECRET!,
    });
    if (event.type === "lpo.settled") { /* … */ }
    res.sendStatus(200); // reply 2xx within 10 s; do slow work asynchronously
  } catch {
    res.sendStatus(400);
  }
});
```

Deliveries retry for about 2 days with backoff. The same event can arrive twice — de-duplicate on `event.id`.

## Errors

Failed requests throw `TradeChainXError` with `status`, `code` (e.g. `insufficient_scope`,
`rate_limited`, `quota_exceeded`, `not_verified`) and `retryAfterSeconds` for 429s.

## Develop

```
pnpm --filter @tradechainx/sdk test    # node:test, no dependencies
pnpm --filter @tradechainx/sdk build   # emits dist/
```
