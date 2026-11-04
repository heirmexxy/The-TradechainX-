# Commodity Units — contract design

Contract: [`contracts/src/CommodityUnits.sol`](../contracts/src/CommodityUnits.sol) · Tests: [`contracts/test/CommodityUnits.t.sol`](../contracts/test/CommodityUnits.t.sol) (58 tests incl. a fuzz test)
Product context: [PRD v3](PRD_v3.md) §4, §6, §7 · Shared rules (TypeScript): [`packages/shared/src/domain/commodity.ts`](../packages/shared/src/domain/commodity.ts)

## What it is

Pooled, fungible claims on graded commodity stock in approved warehouses. One ERC-1155 token id is one
**class** (e.g. Soybean Grade 1). **One base unit is one gram**, so 1 kg = 1000 units and holdings divide
to 0.001 kg. Units of a class are interchangeable across lots; the market has one price per class.

Receipts (`WarehouseReceipt`) stay the legal backing of each lot. The class pools the lots into a
tradable, divisible unit.

## The invariant

```
totalSupply(class)  <=  backedGrams(class) × (10000 − shrinkageBps) / 10000
```

Units outstanding can never exceed the buffered weight of live stock. Every path below either keeps this
true or halts the class.

## Lifecycle

```
warehouse operator ── submitLot ──► Pending
stock auditor      ── attestLot ──► Attested     (weight ≤ claimed; monitoring must be reporting)
listing reviewer   ── approveLot ─► Live         mints  attested × (1 − buffer)  to the class issuer
```

Three different people are required: submitter, attester, approver. The approver also cannot be the
warehouse operator. Approval re-checks that the warehouse is still active and sensors are reporting.
`approveLot` is the **only** path that creates units.

Leaving circulation:

```
class manager      ── proposeSale ──► Proposed   fixes unitsToRetire (proportional share, rounded UP)
listing reviewer   ── approveSale ──► Approved   (not the proposer)
retirement operator── retireForSale ► burns units from holders in batches until unitsToRetire is reached
```

Which holders' units are retired (pro rata or opt-in) is decided off-chain (PRD v3 §7.6, open). The
contract enforces the total, that each holder really has the units, and the audit trail.

## Safety behaviours

| Event | Effect |
|---|---|
| Sensors stop reporting on a live lot (`setMonitoring(false)`) | Class halts automatically |
| Audit finds less stock (`reportShortfall`) and units are now over-issued | Class halts automatically |
| Halted class | No ordinary transfers; mint, fee collection and retirement still work |
| Resume (`resumeClass`, class manager) | Only if `supply ≤ issuable` **and** every live lot is reporting |
| Restore backing after a loss | `retireUnbacked` burns **only** the over-issued amount for that lot; it can never burn backed units |
| Emergency | `pause()` stops everything (pauser); `unpause()` needs the Super Admin multisig |

## Holding fees

Collected **in kind**: units move from the holder to the class fee collector (supply unchanged, the stock
now belongs to the collector). Hard limits enforced on-chain: once per holder per 30-day period, and never
more than the class `maxFeeBps` of the holder's balance (contract cap 5%). Works on frozen holders and
halted classes. Storage and insurance cost is shown to the customer as a line item.

## Transfers

Ordinary transfers require both parties to be verified in `IdentityRegistry` and the class not halted or
paused. Minting, burning and fee collection are separate privileged paths. `isTradable()` is implemented,
so units **also resell through the existing `Marketplace`** (tested).

## Roles

| Role | Does | Notes |
|---|---|---|
| `CLASS_MANAGER_ROLE` | create classes, propose sales, resume a class | |
| `STOCK_AUDITOR_ROLE` | attest lots, report shortfalls, set monitoring | Not the submitter or warehouse operator |
| `LISTING_REVIEWER_ROLE` | approve/reject lots, approve sales | Not submitter, attester, operator or proposer |
| `RETIREMENT_OPERATOR_ROLE` | burn units for approved sales or unbacked amounts | Bounded by on-chain targets |
| `FEE_OPERATOR_ROLE` | collect holding fees | Bounded by period and cap |
| `PAUSER_ROLE` | halt a class, pause everything | |
| Super Admin | roles, unpause | Multisig; two-step transfer |

Set them at deploy time with `CLASS_MANAGER`, `STOCK_AUDITOR`, `RETIREMENT_OPERATOR`, `FEE_OPERATOR`
(see `script/Deploy.s.sol`). Give each to a different named person.

## Trust assumptions to review in the audit

- The retirement operator can burn from any holder, up to the on-chain target for an approved sale or an
  over-issued lot. The allocation policy is off-chain. Treat this key like a treasury key (Safe or KMS).
- The fee operator can charge up to the cap once per period. A compromised key costs holders at most the cap.
- The custodian that holds customers' keys can move customers' units (that is custody). The custodian's
  permissions and recovery are part of the audit scope, not covered by this contract.
- Reference prices and the cash side are **not** on this contract. Prices live in the API/database
  (`reference_prices`), cash in the ledger. The chain proves who owns how many units and that stock backs them.

## Not in this contract (yet)

Reference price feed on-chain, order matching, the liquidity reserve and buyback limits, pledge/lien
support for units (needed for Carrot Credit), and the indexer handlers for the new events.
