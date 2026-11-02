# TradeChainX contracts

Solidity 0.8.24, Foundry, OpenZeppelin 5.1. Not upgradeable by design (see "Decisions").

## Contracts

| Contract | Purpose |
|---|---|
| `IdentityRegistry` | KYC/KYB outcomes on-chain: tier (Individual / Business / Institutional / Platform), expiry, freeze. No personal data. |
| `WarehouseRegistry` | Licensed facilities confirmed by the Warehouse Registrar. One licence backs one warehouse. |
| `base/RWA721Base` | Shared rules for whole assets: roles, pause, one-lien-at-a-time pledging, KYC-gated transfers, expiry, pending-change locks. |
| `WarehouseReceipt` | One token per receipt. Warehouse submits → reviewer approves → minted to depositor. Redemption, partial redemption, void, extension all re-reviewed. |
| `LPOToken` | One token per confirmed purchase order. SME submits → reviewer approves → minted to SME. `settle()` pays the face value in USDC straight to the current holder. |
| `CarbonCredits` | ERC-1155, one id per registry batch (1 unit = 1 tCO2e). A registry batch can be tokenised once. On-chain retirement; reviewer can suspend a batch. |
| `Marketplace` | Fixed-price listings; the asset is held by the marketplace while listed; purchases are atomic USDC-for-asset swaps. Fee ≤ 5%, fixed at listing. Holds no user funds. |
| `xown/XOwnFactory` | Asset manager proposes, a different reviewer approves → deploys a vault and mints the machine's NFT into it. Pausing the factory pauses every vault. |
| `xown/XOwnVault` | Whole-number, KYC-gated shares in one machine. Funds release to the operator only when fully subscribed; otherwise full refunds. Yield only from real deposits, tracked per share. Dissolution pays pro-rata. |
| `xown/XOwnEquipment` | Non-transferable NFT per machine, held by its vault. Serial numbers can't be reused. |
| `mocks/MockUSDC` | Test/local only. The deploy script refuses to use it on mainnets. |

## Rules enforced on-chain (PRD §4.3, §4.4, §9)

| Rule | Where |
|---|---|
| Nothing is minted without reviewer approval | `approveSubmission` / `approve` are the only mint paths |
| Reviewer ≠ submitter / holder / operator | `ReviewerConflict` checks in every approval |
| No duplicate issuance | `receiptKeyUsed`, `lpoKeyUsed`, `batchKeyUsed`, `serialUsed`, `licenceRegistered` |
| No double pledging | One lien per token; liened tokens can't move, list, redeem or settle |
| Status changes go back through review | Request → (warehouse confirmation) → reviewer approval |
| Only verified parties hold assets | Identity checks in every `_update` override |
| Marketplace can't sell a locked asset | `ITradableAsset.isTradable` checked at listing and at sale |
| Emergency stop | `PAUSER_ROLE` pauses; only the Super Admin unpauses |
| Admin key safety | `AccessControlDefaultAdminRules`: 2-step admin transfer with a delay |
| No admin access to user funds | Marketplace holds no USDC; vaults pay out only through their own rules |

## Tests

122 tests: unit suites per contract, fuzz tests (settlement amounts, fee arithmetic, carbon supply
conservation, yield conservation across share transfers), a full-platform journey
(`PlatformJourney.t.sol`), and 4 proof tests of the original contracts' flaws (`LegacyIssues.t.sol`,
against copies in `legacy/`, which are not part of the new system).

```bash
forge test
forge test --match-test testFuzz --fuzz-runs 10000
./smoke-local.sh          # after anvil + ./deploy-local.sh
```

## Deploying

- Local: `anvil`, then `./deploy-local.sh` (dev keys, roles to anvil accounts 1–5).
- Amoy: `./deploy-amoy.sh` with `AMOY_RPC_URL`, a fresh `DEPLOYER_KEY`, and `SUPER_ADMIN` (a Safe).
- Every deployment writes `deployments/<chainId>.json`; `node ../packages/shared/scripts/generate.mjs`
  turns it into typed addresses and ABIs for the apps.

## Decisions (confirm or overrule)

1. **Not upgradeable.** Smaller audit surface and no upgrade key to steal. Fixes ship as a new
   deployment plus migration. The original used UUPS with a single-key owner and no timelock.
2. **Receipts and LPOs are whole tokens (ERC-721).** Fractional exposure is what XOwn is for.
3. **Lien enforcement is time-based.** After maturity an unreleased pledge lets the lender take the
   asset; the Super Admin can release a disputed lien. Needs legal review under Nigerian law.
4. **Redemption needs three parties:** holder requests, warehouse confirms release, reviewer approves.
5. **LPO settlement is blocked while pledged or listed** so money can't land where it would be stuck;
   the lender releases the lien once repaid, or the seller cancels the listing.
6. **Expired receipts and overdue LPOs freeze** until the issuer gets an extension approved.
7. **Near-duplicate checks stay off-chain** (same warehouse + commodity + date; buyer exposure;
   same project + vintage). The API shows them to reviewers; exact duplicates are blocked on-chain.
8. **Settlement in USDC** (6 decimals). Fees are paid by the seller from the sale price.

## Not done

- Independent audit; Slither runs in CI but wasn't available in the build environment.
- Legal review of each token's claim on the underlying goods.
- Non-EVM chains (Cardano, Stellar) — separate implementations.
