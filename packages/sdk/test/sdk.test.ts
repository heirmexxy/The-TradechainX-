import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { TradeChainX, TradeChainXError, reviveCalls, verifyWebhook } from "../src/index.ts";

// Same construction as the API (apps/api/src/partner/keys.ts signWebhook), computed independently.
const sign = (secret: string, body: string, t: number) => `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;

const SECRET = "whsec_test_secret";
const BODY = JSON.stringify({ id: "evt_1", type: "lpo.settled", created: "2026-09-29T00:00:00Z", livemode: false, data: { tokenId: "7" } });
const NOW = 1_790_000_000;

test("verifyWebhook accepts a valid signature", async () => {
  const evt = await verifyWebhook({ payload: BODY, header: sign(SECRET, BODY, NOW), secret: SECRET, now: NOW });
  assert.equal(evt.type, "lpo.settled");
  assert.equal(evt.data.tokenId, "7");
});

test("verifyWebhook rejects a tampered body", async () => {
  const header = sign(SECRET, BODY, NOW);
  await assert.rejects(verifyWebhook({ payload: BODY.replace('"7"', '"8"'), header, secret: SECRET, now: NOW }), /Invalid webhook signature/);
});

test("verifyWebhook rejects the wrong secret", async () => {
  await assert.rejects(verifyWebhook({ payload: BODY, header: sign("whsec_other", BODY, NOW), secret: SECRET, now: NOW }), /Invalid/);
});

test("verifyWebhook rejects old timestamps (replay)", async () => {
  await assert.rejects(verifyWebhook({ payload: BODY, header: sign(SECRET, BODY, NOW - 301), secret: SECRET, now: NOW }), /tolerance/);
});

test("verifyWebhook rejects malformed headers", async () => {
  await assert.rejects(verifyWebhook({ payload: BODY, header: "garbage", secret: SECRET, now: NOW }), /Malformed/);
  await assert.rejects(verifyWebhook({ payload: BODY, header: undefined, secret: SECRET, now: NOW }), /Missing/);
});

test("reviveCalls turns $bigint markers into bigints, deeply", () => {
  const [c] = reviveCalls([
    { contract: "marketplace", address: "0x0000000000000000000000000000000000000001", functionName: "buy", args: [{ $bigint: "5" }, { t: { $bigint: "10" } }, "x"], summary: "" },
  ]);
  assert.deepEqual(c!.args, [5n, { t: 10n }, "x"]);
});

test("client sends the bearer key and parses responses", async () => {
  let seen: { url: string; auth: string | null; method: string; body: unknown } | null = null;
  const fakeFetch = (async (url: URL, init: RequestInit) => {
    seen = { url: String(url), auth: new Headers(init.headers).get("authorization"), method: init.method!, body: init.body };
    return new Response(JSON.stringify({ signer: "0xabc", calls: [] }), { status: 200 });
  }) as unknown as typeof fetch;
  const tcx = new TradeChainX({ apiKey: "tcx_test_abcd1234_x", baseUrl: "https://api.example/", fetch: fakeFetch });
  await tcx.trade.buy({ listingId: 3n, amount: 2 });
  assert.equal(seen!.url, "https://api.example/partner/v1/trade/buy");
  assert.equal(seen!.auth, "Bearer tcx_test_abcd1234_x");
  assert.equal(seen!.method, "POST");
  assert.deepEqual(JSON.parse(seen!.body as string), { listingId: "3", amount: "2" });
});

test("client encodes query strings and skips undefined", async () => {
  let url = "";
  const fakeFetch = (async (u: URL) => {
    url = String(u);
    return new Response(JSON.stringify({ assets: [], nextCursor: null }));
  }) as unknown as typeof fetch;
  await new TradeChainX({ apiKey: "tcx_test_x", baseUrl: "https://api.example", fetch: fakeFetch }).assets.list({ type: "lpo", owner: undefined, limit: 10 });
  assert.equal(url, "https://api.example/partner/v1/assets?type=lpo&limit=10");
});

test("client raises TradeChainXError with code and Retry-After", async () => {
  const fakeFetch = (async () =>
    new Response(JSON.stringify({ error: "rate_limited", message: "slow down" }), { status: 429, headers: { "Retry-After": "12" } })) as unknown as typeof fetch;
  const tcx = new TradeChainX({ apiKey: "tcx_test_x", fetch: fakeFetch });
  await assert.rejects(tcx.me(), (e: unknown) => e instanceof TradeChainXError && e.status === 429 && e.code === "rate_limited" && e.retryAfterSeconds === 12);
});

test("constructor rejects keys that aren't TradeChainX keys", () => {
  assert.throws(() => new TradeChainX({ apiKey: "sk_live_123" }), /tcx_/);
});
