import { test } from "node:test";
import assert from "node:assert/strict";
import {
  UNITS_PER_KG, MIN_ORDER_UNITS, kgToUnits, unitsToKg, issuableUnits, unitsToRetire, isWithinBacking,
  unbackedUnits, quoteKoboPerKg, quoteOrder, holdingFeeUnits, revenueShare, netSettlement, checkPrefund,
  validatePriceBook, type PriceBook,
} from "./commodity.ts";
import { parseNaira, formatNaira } from "./naira.ts";
import { assetModules, distributionAssetTypes as assetTypes, eligibilityBlock, toDistributionType, type DistributorAssetGrant } from "./assetModules.ts";
import { LotStatus, SaleStatus } from "./enums.ts";

test("kg <-> units round trip, 3 decimals, no silent rounding", () => {
  assert.equal(UNITS_PER_KG, 1000n);
  assert.equal(kgToUnits("10"), 10_000n);
  assert.equal(kgToUnits("0.001"), 1n);
  assert.equal(kgToUnits("12.345"), 12_345n);
  assert.equal(unitsToKg(10_000n), "10");
  assert.equal(unitsToKg(1n), "0.001");
  assert.equal(unitsToKg(12_345n), "12.345");
  for (const s of ["0.001", "1", "99.9", "1000.25"]) assert.equal(unitsToKg(kgToUnits(s)), s);
  assert.throws(() => kgToUnits("1.0001"));
  assert.throws(() => kgToUnits("-1"));
  assert.throws(() => kgToUnits("abc"));
});

// These numbers are the same ones asserted in contracts/test/CommodityUnits.t.sol.
test("issuance and retirement match CommodityUnits.sol", () => {
  assert.equal(issuableUnits(100_000n, 200), 98_000n); // 100 kg in, 2% buffer
  assert.equal(issuableUnits(90_000n, 200), 88_200n);
  assert.equal(unitsToRetire(98_000n, 40_000n, 100_000n), 39_200n);
  assert.equal(unitsToRetire(98_000n, 100_000n, 100_000n), 98_000n); // whole lot retires everything
  assert.equal(unitsToRetire(98_000n, 10_000n, 100_000n), 9_800n);
  assert.throws(() => unitsToRetire(98_000n, 100_001n, 100_000n));
  assert.throws(() => unitsToRetire(98_000n, 0n, 100_000n));
});

test("backing check and unbacked units after a shortfall", () => {
  assert.equal(isWithinBacking(98_000n, 100_000n, 200), true);
  assert.equal(isWithinBacking(98_001n, 100_000n, 200), false);
  // lot drops from 100 kg to 60 kg: 58_800 supported, 98_000 issued -> 39_200 unbacked
  assert.equal(unbackedUnits(98_000n, 60_000n, 200), 39_200n);
  assert.equal(unbackedUnits(98_000n, 100_000n, 200), 0n);
  assert.equal(isWithinBacking(98_000n - 39_200n, 60_000n, 200), true);
});

test("selling stock then retiring the quoted units never breaks backing (sweep)", () => {
  for (const gross of [1_000n, 12_345n, 100_000n, 987_654_321n]) {
    for (const buf of [0, 1, 200, 777, 2_000]) {
      const issued = issuableUnits(gross, buf);
      for (const pct of [1n, 3n, 33n, 50n, 99n, 100n]) {
        const grams = (gross * pct) / 100n || 1n;
        const retire = unitsToRetire(issued, grams, gross);
        assert.ok(isWithinBacking(issued - retire, gross - grams, buf), `broke at gross=${gross} buf=${buf} pct=${pct}`);
      }
    }
  }
});

const book: PriceBook = { referenceKoboPerKg: parseNaira("900"), userSpreadBps: 100, buybackSpreadBps: 400 };

test("quotes: buy above reference, sell below, buyback widest", () => {
  assert.equal(quoteKoboPerKg(book, "buy"), parseNaira("909"));
  assert.equal(quoteKoboPerKg(book, "sell"), parseNaira("891"));
  assert.equal(quoteKoboPerKg(book, "buyback"), parseNaira("864"));
});

test("order totals round against the customer, minimum purchase is 10 kg", () => {
  const buy = quoteOrder(book, "buy", kgToUnits("10"));
  assert.equal(buy.totalKobo, parseNaira("9090"));
  assert.equal(formatNaira(buy.totalKobo), "₦9,090.00");
  assert.throws(() => quoteOrder(book, "buy", MIN_ORDER_UNITS - 1n), /Minimum purchase/);
  // sells can be any size so a holder can clear a small remainder
  assert.equal(quoteOrder(book, "sell", 1n).totalKobo, 89n); // 0.001 kg at 891/kg = 0.891 naira -> 89 kobo (floor)
  const odd = quoteOrder({ ...book, referenceKoboPerKg: 100_001n }, "buy", 10_001n);
  assert.ok(odd.totalKobo * UNITS_PER_KG >= odd.units * odd.koboPerKg, "buy total rounds up");
});

test("price book validation", () => {
  assert.throws(() => validatePriceBook({ ...book, buybackSpreadBps: 50 }), /narrower/);
  assert.throws(() => validatePriceBook({ ...book, referenceKoboPerKg: 0n }));
  assert.throws(() => validatePriceBook({ ...book, userSpreadBps: 10_000 }));
});

test("holding fee: ₦3/kg/month on 100 kg at ₦900/kg is a third of a kg, capped by class limit", () => {
  const fee = holdingFeeUnits({ balanceUnits: 100_000n, feeKoboPerKgMonth: 300n, referenceKoboPerKg: 90_000n, maxFeeBps: 100 });
  // 100 kg * ₦3 = ₦300 = 30_000 kobo -> 30_000 / 900 per kg = 0.3334 kg -> 334 units (rounded up)
  assert.equal(fee, 334n);
  const capped = holdingFeeUnits({ balanceUnits: 100_000n, feeKoboPerKgMonth: 30_000n, referenceKoboPerKg: 90_000n, maxFeeBps: 100 });
  assert.equal(capped, 1_000n); // 1% of 100_000 units
  assert.equal(holdingFeeUnits({ balanceUnits: 0n, feeKoboPerKgMonth: 300n, referenceKoboPerKg: 90_000n, maxFeeBps: 100 }), 0n);
  assert.throws(() => holdingFeeUnits({ balanceUnits: 1n, feeKoboPerKgMonth: 1n, referenceKoboPerKg: 1n, maxFeeBps: 501 }));
});

test("revenue share never creates or loses a kobo", () => {
  for (const amt of [0n, 1n, 99n, 12_345n, 987_654_321n]) {
    for (const bps of [0, 1, 3_000, 5_000, 10_000]) {
      const s = revenueShare(amt, bps);
      assert.equal(s.distributor + s.platform, amt);
    }
  }
  assert.deepEqual(revenueShare(10_000n, 3_000), { distributor: 3_000n, platform: 7_000n });
  assert.throws(() => revenueShare(1n, 10_001));
});

test("net settlement per distributor and prefund gate", () => {
  const net = netSettlement([
    { distributorId: "combotrader", side: "buy", totalKobo: 5_000_000n },
    { distributorId: "combotrader", side: "sell", totalKobo: 1_500_000n },
    { distributorId: "other", side: "sell", totalKobo: 200_000n },
  ]);
  assert.equal(net.get("combotrader"), 3_500_000n);
  assert.equal(net.get("other"), -200_000n);

  const ok = checkPrefund({ prefundKobo: 10_000_000n, creditLimitKobo: 5_000_000n, unsettledExposureKobo: 12_000_000n, orderKobo: 3_000_000n });
  assert.equal(ok.allowed, true);
  const no = checkPrefund({ prefundKobo: 10_000_000n, creditLimitKobo: 5_000_000n, unsettledExposureKobo: 12_000_000n, orderKobo: 3_000_001n });
  assert.equal(no.allowed, false);
  assert.equal(no.headroomKobo, 3_000_000n);
});

test("naira parsing rejects bad input", () => {
  assert.equal(parseNaira("₦1,250.5"), 125_050n);
  assert.equal(formatNaira(125_050n), "₦1,250.50");
  assert.equal(formatNaira(-5n), "-₦0.05");
  assert.throws(() => parseNaira("1.234"));
  assert.throws(() => parseNaira("-1"));
});

test("every asset type has a module with disclosures and a contract", () => {
  assert.deepEqual([...assetTypes].sort(), ["carbon_credit", "commodity_unit", "lpo", "warehouse_receipt", "xown"]);
  for (const t of assetTypes) {
    const m = assetModules[t];
    assert.equal(m.type, t);
    assert.ok(m.disclosures.length > 0, `${t} needs disclosures`);
    assert.ok(m.exits.length > 0);
    assert.ok(m.defaultEligibleTiers.length > 0);
  }
  // only pooled commodity units are market-made at launch
  assert.deepEqual(assetTypes.filter((t) => assetModules[t].marketMaking), ["commodity_unit"]);
});

test("existing product-line names map onto distribution asset types", () => {
  assert.equal(toDistributionType("warehouse-receipt"), "warehouse_receipt");
  assert.equal(toDistributionType("carbon"), "carbon_credit");
  assert.equal(toDistributionType("lpo"), "lpo");
  assert.equal(toDistributionType("xown"), "xown");
});

test("eligibility: gate per distributor, tier and accepted disclosures", () => {
  const full: DistributorAssetGrant = {
    enabled: true, tiers: ["retail", "qualified", "institutional"], acceptedDisclosures: [...assetModules.commodity_unit.disclosures],
  };
  assert.equal(eligibilityBlock("commodity_unit", "retail", full), null);
  assert.equal(eligibilityBlock("commodity_unit", "retail", undefined), "asset_not_enabled_for_distributor");
  assert.equal(eligibilityBlock("commodity_unit", "retail", { ...full, enabled: false }), "asset_not_enabled_for_distributor");
  assert.equal(eligibilityBlock("commodity_unit", "retail", { ...full, tiers: ["qualified"] }), "tier_not_in_distributor_grant");
  assert.match(eligibilityBlock("commodity_unit", "retail", { ...full, acceptedDisclosures: ["price_risk"] }) ?? "", /^disclosure_not_accepted/);
  // LPOs are not retail by default, even if a distributor's grant tries to include retail
  const lpoGrant: DistributorAssetGrant = { enabled: true, tiers: ["retail", "qualified"], acceptedDisclosures: [...assetModules.lpo.disclosures] };
  assert.equal(eligibilityBlock("lpo", "retail", lpoGrant), "tier_not_eligible_by_default");
  assert.equal(eligibilityBlock("lpo", "qualified", lpoGrant), null);
});

test("lot and sale status mirrors keep the Solidity order", () => {
  assert.equal(LotStatus.Live, 3);
  assert.equal(LotStatus.Depleted, 6);
  assert.equal(SaleStatus.Completed, 3);
});
