# Review of the original TradeChainX contracts

Reviewed: `Contract Updated.zip` (10 contracts, Hardhat, OpenZeppelin 5.3 upgradeable), 29 Sept 2026.
Proof tests: `test/LegacyIssues.t.sol` runs against copies of the original contracts in `legacy/`.
Each test passes because the issue is present.

**Verdict: replace, don't patch.** The problems are in the design (who can issue, where money comes
from, who controls funds), not in isolated lines. Every contract would need rewriting to meet PRD §4.3,
§4.4 and §9, and the originals appear to be testnet-only, so there's no live state to preserve.

## Do this first: exposed keys

- The zip contains a real `.env` with `PRIVATE_KEY` and a Polygonscan API key.
- `hardhat.config.js` hardcodes two block-explorer API keys (BscScan and Polygon Amoy).

Treat the private key as compromised: move anything it controls to a new wallet, and never reuse it
on mainnet. Regenerate the explorer API keys. Remove `.env` from every shared copy (Drive included).
That key is also the sole `owner` of every contract (see below).

## Critical

| # | Contract | Issue | Proof |
|---|---|---|---|
| C1 | XOwnAssetManager | `distributeYield` records yield without moving any tokens in (the `transferFrom` is commented out), so "yield" is paid from investors' principal. | `test_Legacy_XOwnYieldDoubleClaimFromPrincipal` |
| C2 | XOwnAssetManager | The same yield can be claimed again by moving shares to a second wallet: claims are tracked per wallet, not per share. | same test: 10 TXC distributed, 20 TXC claimed |
| C3 | XOwnAssetManager | `withdrawTokens(token)` lets the owner take the contract's entire balance, including all investor principal, at any time. | by inspection |
| C4 | Marketplace | `withdrawTokens` ignores escrowed amounts, so the owner can take buyers' escrowed payments and the seller can never be paid. | `test_Legacy_OwnerCanWithdrawEscrowedBuyerFunds` |
| C5 | Marketplace | `liquidate` pays the seller a fixed premium (+30% warehouse, +4% LPO, ~+128% carbon via 3.5%/month compounded 24 times) out of the marketplace's own balance, which holds other users' escrowed funds. `basePrice` is set by the submitter. Anyone can call it. Currently unreachable only because of H1; fixing H1 alone would open this. | by inspection |
| C6 | WarehouseReceiptNFT, LPOToken | Anyone can submit a receipt (no warehouse/issuer check) and the same receipt can be tokenised repeatedly. No duplicate detection at all. | `test_Legacy_NoIssuerCheckAndDuplicatesAllowed` |

## High

| # | Contract | Issue |
|---|---|---|
| H1 | Marketplace | Expiry is computed as `issuedTime + expiryTime`, but `expiryTime` is already an absolute timestamp, so nothing ever expires. Expired receipts stay listable and tradable. Proven by `test_Legacy_ExpiryNeverTriggers`. |
| H2 | All | A single EOA `owner` approves listings, sets fees, burns any holder's token (`burnFromMarketplace`), mints unlimited TXC, and upgrades every contract instantly (UUPS, no timelock or multisig). The PRD's role separation (§4.4) doesn't exist. |
| H3 | All tokens | No KYC transfer restrictions, no pause (except XOwn), no liens/pledging, no redemption or status-change flow. Nothing stops double pledging (PRD's headline fraud case). |
| H4 | Marketplace | Listings don't lock the asset. A seller can list, then sell or move the token elsewhere; the listing stays "active" until a buy fails. |
| H5 | Marketplace | Escrow has no cancel/refund path. If buyer and arbitrator don't approve, the seller's money is stuck forever; the buyer already has the token, so escrow protects no one. |
| H6 | CarbonCreditToken | `mintBatch` lets the owner mint credits with no submission or review, bypassing the approval gate. There's no retirement function, so a credit can be "used" and still traded (double counting). `burnFromMarketplace` burns from the contract's own balance, so carbon liquidation always reverts. |
| H7 | TXCToken | All payments settle in TXC, which the owner can mint without limit. PRD calls for stablecoin settlement; guaranteed fixed returns (C5) paid in a self-minted token also raise securities and consumer-protection concerns. |

## Medium / hygiene

- Upgradeable contracts don't call `_disableInitializers()` in a constructor; implementations can be initialised by anyone.
- `initialize` calls `transferOwnership` after `__Ownable_init(admin)`, so it only works if called by `admin`; misleading and fragile.
- Unbounded arrays (`_pendingSubmissionIds` etc.) with linear removal: approval gas grows with the queue.
- ERC20 `transferFrom`/`transfer` return values unchecked in the tokens and XOwn (safe with TXC, unsafe with USDT-style tokens). Use `SafeERC20`.
- `XOwnAssetManager` ships its own copy of `ReentrancyGuard` and `IERC20` instead of OpenZeppelin's.
- `invest` resets `lastClaimedTime` on every top-up; `sellShares` redeems at par from pooled funds, so early sellers are paid from later investors.
- XOwnFactory/XOwnAssetNFT/XOwnFractionToken aren't connected to XOwnAssetManager: the "locked NFT + fraction token" pattern the PRD describes isn't actually enforced.
- `Escrow.sol` is marked unused; `package.json` deploy scripts point to a `scripts/deploy.js` that doesn't exist.
- No tests in the repo.

## What carries over into the rebuild

- The three asset types (warehouse, LPO, carbon) and submit → approve → mint shape.
- Fee concepts (listing, resale, liquidation) and ERC-2981 royalties, to be re-specified.
- Event names the backend may already index (`ReceiptSubmitted`, `SubmissionApproved`, `ReceiptMinted`): worth keeping compatible names where cheap.
- Deployed proxy addresses in `scripts/` (Polygon Amoy, presumably): only needed if any testnet data matters.

## Rebuild status

All replaced — see the repository root README.

| Original | Replacement |
|---|---|
| WarehouseReceiptNFT | `WarehouseReceipt` + `WarehouseRegistry` + `IdentityRegistry` |
| LPOToken | `LPOToken` with on-chain settlement to the current holder |
| CarbonCredits | `CarbonCredits` with one-time batch tokenisation, retirement and suspension |
| Marketplace + Escrow | `Marketplace`: asset held while listed, atomic USDC settlement, no admin access to funds |
| TXCToken | Dropped; settlement in USDC |
| XOwn* | `XOwnFactory` + `XOwnVault` + `XOwnEquipment`: real-deposit yield per share, refunds, dissolution |
