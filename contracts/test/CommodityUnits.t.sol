// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {PlatformTestBase} from "./helpers/PlatformTestBase.sol";
import {CommodityUnits} from "../src/CommodityUnits.sol";
import {WarehouseRegistry} from "../src/WarehouseRegistry.sol";
import {Marketplace} from "../src/Marketplace.sol";
import {IIdentityRegistry} from "../src/interfaces/IIdentityRegistry.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

contract CommodityUnitsTest is PlatformTestBase {
    CommodityUnits cu;
    WarehouseRegistry whs;

    address operator = makeAddr("warehouseOperator");
    address registrar = makeAddr("registrar");
    address auditor = makeAddr("stockAuditor");
    address classMgr = makeAddr("classManager");
    address retireOp = makeAddr("retirementOperator");
    address feeOp = makeAddr("feeOperator");

    // originator = issuer treasury (Business); lender = fee collector (Institutional)
    uint256 whId;
    uint256 classId;
    uint16 constant BUF = 200;    // 2% shrinkage buffer
    uint16 constant MAXFEE = 100; // 1% max holding fee per period

    function setUp() public {
        _baseSetUp();
        whs = new WarehouseRegistry(superAdmin, 2 days, ids);
        cu = new CommodityUnits(superAdmin, 2 days, ids, whs);

        vm.startPrank(superAdmin);
        whs.grantRole(whs.WAREHOUSE_REGISTRAR_ROLE(), registrar);
        cu.grantRole(cu.CLASS_MANAGER_ROLE(), classMgr);
        cu.grantRole(cu.STOCK_AUDITOR_ROLE(), auditor);
        cu.grantRole(cu.LISTING_REVIEWER_ROLE(), reviewer);
        cu.grantRole(cu.PAUSER_ROLE(), pauser);
        cu.grantRole(cu.RETIREMENT_OPERATOR_ROLE(), retireOp);
        cu.grantRole(cu.FEE_OPERATOR_ROLE(), feeOp);
        vm.stopPrank();

        vm.prank(kycReviewer);
        ids.setIdentity(operator, IIdentityRegistry.Tier.Business, uint64(block.timestamp + YEAR), bytes32("op"));
        vm.prank(registrar);
        whId = whs.registerWarehouse(operator, keccak256("LIC-1"), "");

        vm.prank(classMgr);
        classId = cu.createClass(bytes32("SOYBEAN"), bytes32("GRADE_1"), BUF, MAXFEE, originator, lender, "ipfs://soy");
    }

    // ------------------------------------------------------------------ helpers

    function _terms(uint256 cid, string memory ref, uint256 gross) internal view returns (CommodityUnits.LotTerms memory) {
        return CommodityUnits.LotTerms({
            classId: cid,
            warehouseId: whId,
            lotRefHash: keccak256(bytes(ref)),
            grossGrams: gross,
            intakeDate: uint64(block.timestamp - 1 days),
            documentHash: keccak256("intake+grading"),
            receiptRef: bytes32(0)
        });
    }

    function _submit(string memory ref, uint256 gross) internal returns (uint256 lotId) {
        vm.prank(operator);
        lotId = cu.submitLot(_terms(classId, ref, gross));
    }

    function _attest(uint256 lotId, uint256 grams) internal {
        vm.prank(auditor);
        cu.attestLot(lotId, grams, true, keccak256("attestation"));
    }

    function _live(string memory ref, uint256 gross) internal returns (uint256 lotId) {
        lotId = _submit(ref, gross);
        _attest(lotId, gross);
        vm.prank(reviewer);
        cu.approveLot(lotId);
    }

    function _one(address a) internal pure returns (address[] memory arr) {
        arr = new address[](1);
        arr[0] = a;
    }

    function _amt(uint256 v) internal pure returns (uint256[] memory arr) {
        arr = new uint256[](1);
        arr[0] = v;
    }

    // ------------------------------------------------------------------ classes

    function test_CreateClass_StoresConfig() public view {
        CommodityUnits.Class memory c = cu.getClass(classId);
        assertEq(c.commodity, bytes32("SOYBEAN"));
        assertEq(c.shrinkageBps, BUF);
        assertEq(c.issuer, originator);
        assertEq(c.feeCollector, lender);
        assertTrue(c.active);
        assertFalse(c.halted);
        assertEq(cu.uri(classId), "ipfs://soy");
    }

    function test_CreateClass_DuplicateReverts() public {
        vm.expectRevert(CommodityUnits.DuplicateClass.selector);
        vm.prank(classMgr);
        cu.createClass(bytes32("SOYBEAN"), bytes32("GRADE_1"), BUF, MAXFEE, originator, lender, "");
    }

    function test_CreateClass_SameCommodityOtherGradeAllowed() public {
        vm.prank(classMgr);
        uint256 id2 = cu.createClass(bytes32("SOYBEAN"), bytes32("GRADE_2"), BUF, MAXFEE, originator, lender, "");
        assertEq(id2, classId + 1);
    }

    function test_CreateClass_LimitsEnforced() public {
        vm.startPrank(classMgr);
        vm.expectRevert(CommodityUnits.InvalidTerms.selector);
        cu.createClass(bytes32("MAIZE"), bytes32("G1"), 2001, MAXFEE, originator, lender, "");
        vm.expectRevert(CommodityUnits.InvalidTerms.selector);
        cu.createClass(bytes32("MAIZE"), bytes32("G1"), BUF, 501, originator, lender, "");
        vm.stopPrank();
    }

    function test_CreateClass_OnlyManager() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, cu.CLASS_MANAGER_ROLE()
            )
        );
        vm.prank(stranger);
        cu.createClass(bytes32("MAIZE"), bytes32("G1"), BUF, MAXFEE, originator, lender, "");
    }

    function test_CreateClass_IssuerMustBeVerifiedEntity() public {
        vm.startPrank(classMgr);
        vm.expectRevert(CommodityUnits.IssuerNotVerified.selector);
        cu.createClass(bytes32("MAIZE"), bytes32("G1"), BUF, MAXFEE, stranger, lender, "");
        vm.expectRevert(CommodityUnits.IssuerNotVerified.selector);
        cu.createClass(bytes32("MAIZE"), bytes32("G1"), BUF, MAXFEE, trader, lender, ""); // individual, not entity
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ issuance gate

    function test_SubmitLot_DoesNotMint() public {
        _submit("L-1", 100_000);
        assertEq(cu.totalSupply(classId), 0);
        assertFalse(cu.isTradable(classId));
    }

    function test_SubmitLot_OnlyActiveWarehouseOperator() public {
        vm.expectRevert(CommodityUnits.NotActiveWarehouseOperator.selector);
        vm.prank(stranger);
        cu.submitLot(_terms(classId, "L-1", 100_000));
    }

    function test_SubmitLot_DuplicateReverts() public {
        _submit("L-1", 100_000);
        CommodityUnits.LotTerms memory t = _terms(classId, "L-1", 50_000);
        vm.expectRevert(CommodityUnits.DuplicateLot.selector);
        vm.prank(operator);
        cu.submitLot(t);
    }

    function test_SubmitLot_RejectedRefCannotBeRecycled() public {
        uint256 id = _submit("L-1", 100_000);
        vm.prank(reviewer);
        cu.rejectLot(id, keccak256("bad docs"));
        CommodityUnits.LotTerms memory t = _terms(classId, "L-1", 100_000);
        vm.expectRevert(CommodityUnits.DuplicateLot.selector);
        vm.prank(operator);
        cu.submitLot(t);
    }

    function test_SubmitLot_InvalidTermsRevert() public {
        CommodityUnits.LotTerms memory t = _terms(classId, "L-1", 0);
        vm.expectRevert(CommodityUnits.InvalidTerms.selector);
        vm.prank(operator);
        cu.submitLot(t);
    }

    function test_SubmitLot_InactiveClassReverts() public {
        vm.prank(classMgr);
        cu.setClassActive(classId, false);
        CommodityUnits.LotTerms memory t = _terms(classId, "L-1", 100_000);
        vm.expectRevert(CommodityUnits.ClassInactive.selector);
        vm.prank(operator);
        cu.submitLot(t);
    }

    function test_Attest_OnlyAuditor() public {
        uint256 id = _submit("L-1", 100_000);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, cu.STOCK_AUDITOR_ROLE()
            )
        );
        vm.prank(stranger);
        cu.attestLot(id, 100_000, true, keccak256("a"));
    }

    function test_Attest_CannotExceedGross() public {
        uint256 id = _submit("L-1", 100_000);
        vm.expectRevert(CommodityUnits.InvalidTerms.selector);
        vm.prank(auditor);
        cu.attestLot(id, 100_001, true, keccak256("a"));
    }

    function test_Attest_SubmitterCannotAttest() public {
        uint256 id = _submit("L-1", 100_000);
        bytes32 auditorRole = cu.STOCK_AUDITOR_ROLE();
        vm.prank(superAdmin);
        cu.grantRole(auditorRole, operator);
        vm.expectRevert(CommodityUnits.ReviewerConflict.selector);
        vm.prank(operator);
        cu.attestLot(id, 100_000, true, keccak256("a"));
    }

    function test_Approve_RequiresAttestation() public {
        uint256 id = _submit("L-1", 100_000);
        vm.expectRevert(CommodityUnits.InvalidLotState.selector);
        vm.prank(reviewer);
        cu.approveLot(id);
    }

    function test_Approve_MintsBufferedUnitsToIssuer() public {
        uint256 id = _live("L-1", 100_000); // 100 kg in
        assertEq(cu.balanceOf(originator, classId), 98_000); // 98 kg of units out (2% buffer)
        assertEq(cu.totalSupply(classId), 98_000);
        (uint256 backed, uint256 issuable, uint256 outstanding, bool ok) = cu.backing(classId);
        assertEq(backed, 100_000);
        assertEq(issuable, 98_000);
        assertEq(outstanding, 98_000);
        assertTrue(ok);
        assertEq(uint8(cu.getLot(id).status), uint8(CommodityUnits.LotStatus.Live));
        assertTrue(cu.isTradable(classId));
    }

    function test_Approve_MintsOnAttestedNotClaimedWeight() public {
        uint256 id = _submit("L-1", 100_000);
        _attest(id, 90_000); // auditor finds less than the operator claimed
        vm.prank(reviewer);
        cu.approveLot(id);
        assertEq(cu.totalSupply(classId), 88_200);
    }

    function test_Approve_ReviewerCannotBeAttester() public {
        uint256 id = _submit("L-1", 100_000);
        _attest(id, 100_000);
        bytes32 reviewerRole = cu.LISTING_REVIEWER_ROLE();
        vm.prank(superAdmin);
        cu.grantRole(reviewerRole, auditor);
        vm.expectRevert(CommodityUnits.ReviewerConflict.selector);
        vm.prank(auditor);
        cu.approveLot(id);
    }

    function test_Approve_RequiresMonitoring() public {
        uint256 id = _submit("L-1", 100_000);
        vm.prank(auditor);
        cu.attestLot(id, 100_000, false, keccak256("a")); // sensors not reporting
        vm.expectRevert(CommodityUnits.MonitoringNotReporting.selector);
        vm.prank(reviewer);
        cu.approveLot(id);
    }

    function test_Approve_TwiceReverts() public {
        uint256 id = _live("L-1", 100_000);
        vm.expectRevert(CommodityUnits.InvalidLotState.selector);
        vm.prank(reviewer);
        cu.approveLot(id);
    }

    function test_Approve_BlockedWhenWarehouseSuspended() public {
        uint256 id = _submit("L-1", 100_000);
        _attest(id, 100_000);
        vm.prank(registrar);
        whs.setWarehouseActive(whId, false, keccak256("licence lapsed"));
        vm.expectRevert(CommodityUnits.WarehouseInactive.selector);
        vm.prank(reviewer);
        cu.approveLot(id);
    }

    function test_Withdraw_OnlySubmitter() public {
        uint256 id = _submit("L-1", 100_000);
        vm.expectRevert(CommodityUnits.NotSubmitter.selector);
        vm.prank(stranger);
        cu.withdrawLot(id);
        vm.prank(operator);
        cu.withdrawLot(id);
        assertEq(uint8(cu.getLot(id).status), uint8(CommodityUnits.LotStatus.Withdrawn));
    }

    function test_NoPublicMint() public {
        // The only supply-increasing path is approveLot: an attacker cannot mint by any other call.
        _live("L-1", 100_000);
        (bool ok,) = address(cu).call(abi.encodeWithSignature("mint(address,uint256,uint256,bytes)", stranger, classId, 1, ""));
        assertFalse(ok);
        assertEq(cu.totalSupply(classId), 98_000);
    }

    // ------------------------------------------------------------------ transfers

    function test_Transfer_BetweenVerifiedHolders() public {
        _live("L-1", 100_000);
        vm.prank(originator);
        cu.safeTransferFrom(originator, trader, classId, 10_000, ""); // 10 kg
        assertEq(cu.balanceOf(trader, classId), 10_000);
    }

    function test_Transfer_ToUnverifiedReverts() public {
        _live("L-1", 100_000);
        vm.expectRevert(CommodityUnits.HolderNotVerified.selector);
        vm.prank(originator);
        cu.safeTransferFrom(originator, stranger, classId, 10_000, "");
    }

    function test_Transfer_FrozenHolderCannotSend() public {
        _live("L-1", 100_000);
        vm.prank(originator);
        cu.safeTransferFrom(originator, trader, classId, 10_000, "");
        vm.prank(kycReviewer);
        ids.setFrozen(trader, true);
        vm.expectRevert(CommodityUnits.HolderNotVerified.selector);
        vm.prank(trader);
        cu.safeTransferFrom(trader, investor, classId, 1_000, "");
    }

    function test_Transfer_SingleGramDivisibility() public {
        _live("L-1", 100_000);
        vm.prank(originator);
        cu.safeTransferFrom(originator, trader, classId, 1, ""); // 0.001 kg
        assertEq(cu.balanceOf(trader, classId), 1);
    }

    function test_GlobalPause_BlocksTransfers() public {
        _live("L-1", 100_000);
        vm.prank(pauser);
        cu.pause();
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vm.prank(originator);
        cu.safeTransferFrom(originator, trader, classId, 1_000, "");
        assertFalse(cu.isTradable(classId));
    }

    function test_Halt_BlocksTransfersAndResumeRestores() public {
        _live("L-1", 100_000);
        vm.prank(pauser);
        cu.haltClass(classId, keccak256("incident"));
        vm.expectRevert(abi.encodeWithSelector(CommodityUnits.ClassIsHalted.selector, classId));
        vm.prank(originator);
        cu.safeTransferFrom(originator, trader, classId, 1_000, "");
        assertFalse(cu.isTradable(classId));

        vm.prank(classMgr);
        cu.resumeClass(classId);
        vm.prank(originator);
        cu.safeTransferFrom(originator, trader, classId, 1_000, "");
        assertTrue(cu.isTradable(classId));
    }

    function test_Halt_OnlyPauser() public {
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, cu.PAUSER_ROLE())
        );
        vm.prank(stranger);
        cu.haltClass(classId, keccak256("x"));
    }

    // ------------------------------------------------------------------ monitoring and shortfall

    function test_MonitoringLost_HaltsClassUntilRestored() public {
        uint256 id = _live("L-1", 100_000);
        vm.prank(auditor);
        cu.setMonitoring(id, false);
        assertTrue(cu.getClass(classId).halted);

        vm.expectRevert(CommodityUnits.MonitoringNotReporting.selector);
        vm.prank(classMgr);
        cu.resumeClass(classId);

        vm.prank(auditor);
        cu.setMonitoring(id, true);
        vm.prank(classMgr);
        cu.resumeClass(classId);
        assertFalse(cu.getClass(classId).halted);
    }

    function test_Shortfall_HaltsWhenUnderBacked_ResumeBlocked() public {
        uint256 id = _live("L-1", 100_000);
        vm.prank(auditor);
        cu.reportShortfall(id, 60_000, keccak256("audit: moisture loss and spoilage"));

        assertTrue(cu.getClass(classId).halted);
        (, uint256 issuable, uint256 outstanding, bool ok) = cu.backing(classId);
        assertEq(issuable, 58_800);
        assertEq(outstanding, 98_000);
        assertFalse(ok);

        vm.expectRevert(CommodityUnits.BackingShortfall.selector);
        vm.prank(classMgr);
        cu.resumeClass(classId);
    }

    function test_Shortfall_AnyLossThatLeavesUnitsUnbackedHalts() public {
        uint256 id = _live("L-1", 100_000);
        vm.prank(auditor);
        cu.reportShortfall(id, 99_000, keccak256("1 kg drying loss")); // issuable 97_020 < 98_000 outstanding
        assertTrue(cu.getClass(classId).halted);
    }

    function test_Shortfall_RetireUnbackedRestoresBackingThenResume() public {
        uint256 id = _live("L-1", 100_000);
        vm.prank(auditor);
        cu.reportShortfall(id, 60_000, keccak256("audit"));

        // excess = 98_000 - 58_800 = 39_200
        vm.expectRevert(CommodityUnits.ExceedsRetirementTarget.selector);
        vm.prank(retireOp);
        cu.retireUnbacked(id, _one(originator), _amt(39_201), keccak256("loss settlement"));

        vm.prank(retireOp);
        cu.retireUnbacked(id, _one(originator), _amt(39_200), keccak256("loss settlement"));

        (,,, bool ok) = cu.backing(classId);
        assertTrue(ok);
        assertEq(cu.getLot(id).issuedLive, 58_800);

        vm.prank(classMgr);
        cu.resumeClass(classId);
        assertFalse(cu.getClass(classId).halted);
    }

    function test_RetireUnbacked_CannotBurnBackedUnits() public {
        uint256 id = _live("L-1", 100_000); // fully backed, nothing in excess
        vm.expectRevert(CommodityUnits.ExceedsRetirementTarget.selector);
        vm.prank(retireOp);
        cu.retireUnbacked(id, _one(originator), _amt(1), keccak256("x"));
    }

    function test_Shortfall_OnlyDownwards() public {
        uint256 id = _live("L-1", 100_000);
        vm.expectRevert(CommodityUnits.InvalidTerms.selector);
        vm.prank(auditor);
        cu.reportShortfall(id, 100_000, keccak256("x"));
    }

    // ------------------------------------------------------------------ processor sale

    function test_Sale_ProportionalRetirementKeepsBacking() public {
        uint256 id = _live("L-1", 100_000); // 98_000 units outstanding

        vm.prank(classMgr);
        uint256 sid = cu.proposeSale(id, 40_000, keccak256("processor PO-1"));
        assertEq(cu.getSale(sid).unitsToRetire, 39_200); // 98_000 * 40_000 / 100_000

        vm.prank(reviewer);
        cu.approveSale(sid);

        // retired in two batches
        vm.prank(retireOp);
        cu.retireForSale(sid, _one(originator), _amt(20_000));
        assertEq(uint8(cu.getSale(sid).status), uint8(CommodityUnits.SaleStatus.Approved));
        vm.prank(retireOp);
        cu.retireForSale(sid, _one(originator), _amt(19_200));

        assertEq(uint8(cu.getSale(sid).status), uint8(CommodityUnits.SaleStatus.Completed));
        CommodityUnits.Lot memory l = cu.getLot(id);
        assertEq(l.remainingGrams, 60_000);
        assertEq(l.issuedLive, 58_800);
        assertEq(cu.totalSupply(classId), 58_800);
        (,,, bool ok) = cu.backing(classId);
        assertTrue(ok);
        assertEq(cu.openSaleOfLot(id), 0);
    }

    function test_Sale_RetiresFromMultipleHolders() public {
        uint256 id = _live("L-1", 100_000);
        vm.startPrank(originator);
        cu.safeTransferFrom(originator, trader, classId, 30_000, "");
        cu.safeTransferFrom(originator, investor, classId, 20_000, "");
        vm.stopPrank();

        vm.prank(classMgr);
        uint256 sid = cu.proposeSale(id, 50_000, keccak256("PO-2")); // 49_000 units
        vm.prank(reviewer);
        cu.approveSale(sid);

        address[] memory hs = new address[](3);
        uint256[] memory vs = new uint256[](3);
        hs[0] = trader;     vs[0] = 15_000;
        hs[1] = investor;   vs[1] = 10_000;
        hs[2] = originator; vs[2] = 24_000;
        vm.prank(retireOp);
        cu.retireForSale(sid, hs, vs);

        assertEq(cu.balanceOf(trader, classId), 15_000);
        assertEq(cu.balanceOf(investor, classId), 10_000);
        assertEq(cu.totalSupply(classId), 49_000);
    }

    function test_Sale_FullLotDepletes() public {
        uint256 id = _live("L-1", 100_000);
        vm.prank(classMgr);
        uint256 sid = cu.proposeSale(id, 100_000, keccak256("PO-3"));
        assertEq(cu.getSale(sid).unitsToRetire, 98_000);
        vm.prank(reviewer);
        cu.approveSale(sid);
        vm.prank(retireOp);
        cu.retireForSale(sid, _one(originator), _amt(98_000));

        assertEq(uint8(cu.getLot(id).status), uint8(CommodityUnits.LotStatus.Depleted));
        assertEq(cu.totalSupply(classId), 0);
        (uint256 backed,,,) = cu.backing(classId);
        assertEq(backed, 0);
    }

    function test_Sale_ProposerCannotApprove() public {
        uint256 id = _live("L-1", 100_000);
        vm.startPrank(superAdmin);
        cu.grantRole(cu.LISTING_REVIEWER_ROLE(), classMgr);
        vm.stopPrank();
        vm.prank(classMgr);
        uint256 sid = cu.proposeSale(id, 10_000, keccak256("PO"));
        vm.expectRevert(CommodityUnits.ReviewerConflict.selector);
        vm.prank(classMgr);
        cu.approveSale(sid);
    }

    function test_Sale_CannotRetireBeforeApproval() public {
        uint256 id = _live("L-1", 100_000);
        vm.prank(classMgr);
        uint256 sid = cu.proposeSale(id, 10_000, keccak256("PO"));
        vm.expectRevert(CommodityUnits.InvalidSaleState.selector);
        vm.prank(retireOp);
        cu.retireForSale(sid, _one(originator), _amt(9_800));
    }

    function test_Sale_OnlyRetirementOperatorCanBurn() public {
        uint256 id = _live("L-1", 100_000);
        vm.prank(classMgr);
        uint256 sid = cu.proposeSale(id, 10_000, keccak256("PO"));
        vm.prank(reviewer);
        cu.approveSale(sid);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, cu.RETIREMENT_OPERATOR_ROLE()
            )
        );
        vm.prank(stranger);
        cu.retireForSale(sid, _one(originator), _amt(9_800));
    }

    function test_Sale_CannotRetireMoreThanTarget() public {
        uint256 id = _live("L-1", 100_000);
        vm.prank(classMgr);
        uint256 sid = cu.proposeSale(id, 10_000, keccak256("PO")); // 9_800 units
        vm.prank(reviewer);
        cu.approveSale(sid);
        vm.expectRevert(CommodityUnits.ExceedsRetirementTarget.selector);
        vm.prank(retireOp);
        cu.retireForSale(sid, _one(originator), _amt(9_801));
    }

    function test_Sale_OneOpenSalePerLot() public {
        uint256 id = _live("L-1", 100_000);
        vm.startPrank(classMgr);
        cu.proposeSale(id, 10_000, keccak256("PO-1"));
        vm.expectRevert(CommodityUnits.OpenSaleExists.selector);
        cu.proposeSale(id, 10_000, keccak256("PO-2"));
        vm.stopPrank();
    }

    function test_Sale_CannotSellMoreThanRemaining() public {
        uint256 id = _live("L-1", 100_000);
        vm.expectRevert(CommodityUnits.InvalidAmount.selector);
        vm.prank(classMgr);
        cu.proposeSale(id, 100_001, keccak256("PO"));
    }

    function test_Sale_CancelBeforeRetirementOnly() public {
        uint256 id = _live("L-1", 100_000);
        vm.prank(classMgr);
        uint256 sid = cu.proposeSale(id, 10_000, keccak256("PO"));
        vm.prank(classMgr);
        cu.cancelSale(sid);
        assertEq(cu.openSaleOfLot(id), 0);

        vm.prank(classMgr);
        uint256 sid2 = cu.proposeSale(id, 10_000, keccak256("PO-2"));
        vm.prank(reviewer);
        cu.approveSale(sid2);
        vm.prank(retireOp);
        cu.retireForSale(sid2, _one(originator), _amt(1_000));
        vm.expectRevert(CommodityUnits.InvalidSaleState.selector);
        vm.prank(classMgr);
        cu.cancelSale(sid2);
    }

    function test_Sale_RetirementStillWorksWhileHalted() public {
        uint256 id = _live("L-1", 100_000);
        vm.prank(pauser);
        cu.haltClass(classId, keccak256("incident"));
        vm.prank(classMgr);
        uint256 sid = cu.proposeSale(id, 10_000, keccak256("PO"));
        vm.prank(reviewer);
        cu.approveSale(sid);
        vm.prank(retireOp);
        cu.retireForSale(sid, _one(originator), _amt(9_800));
        assertEq(cu.totalSupply(classId), 88_200);
    }

    // ------------------------------------------------------------------ holding fee

    function _distribute() internal {
        _live("L-1", 1_000_000); // 980_000 units
        vm.prank(originator);
        cu.safeTransferFrom(originator, trader, classId, 100_000, ""); // 100 kg
    }

    function test_Fee_MovesUnitsInKindToCollector() public {
        _distribute();
        vm.prank(feeOp);
        cu.collectHoldingFee(classId, _one(trader), _amt(1_000)); // 1% of 100_000
        assertEq(cu.balanceOf(trader, classId), 99_000);
        assertEq(cu.balanceOf(lender, classId), 1_000);
        assertEq(cu.totalSupply(classId), 980_000); // supply unchanged: stock now belongs to the collector
    }

    function test_Fee_CapEnforced() public {
        _distribute();
        vm.expectRevert(abi.encodeWithSelector(CommodityUnits.FeeExceedsCap.selector, trader));
        vm.prank(feeOp);
        cu.collectHoldingFee(classId, _one(trader), _amt(1_001));
    }

    function test_Fee_OncePerPeriodThenAgainNextPeriod() public {
        _distribute();
        vm.prank(feeOp);
        cu.collectHoldingFee(classId, _one(trader), _amt(500));
        vm.expectRevert(abi.encodeWithSelector(CommodityUnits.FeeAlreadyChargedThisPeriod.selector, trader));
        vm.prank(feeOp);
        cu.collectHoldingFee(classId, _one(trader), _amt(500));

        vm.warp(block.timestamp + 31 days);
        vm.prank(feeOp);
        cu.collectHoldingFee(classId, _one(trader), _amt(500));
        assertEq(cu.balanceOf(lender, classId), 1_000);
    }

    function test_Fee_OnlyFeeOperator() public {
        _distribute();
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, cu.FEE_OPERATOR_ROLE()
            )
        );
        vm.prank(stranger);
        cu.collectHoldingFee(classId, _one(trader), _amt(100));
    }

    function test_Fee_CannotChargeCollectorOrZero() public {
        _distribute();
        vm.startPrank(feeOp);
        vm.expectRevert(CommodityUnits.InvalidAmount.selector);
        cu.collectHoldingFee(classId, _one(lender), _amt(1));
        vm.expectRevert(CommodityUnits.InvalidAmount.selector);
        cu.collectHoldingFee(classId, _one(trader), _amt(0));
        vm.stopPrank();
    }

    function test_Fee_WorksOnFrozenHolderAndHaltedClass() public {
        _distribute();
        vm.prank(kycReviewer);
        ids.setFrozen(trader, true);
        vm.prank(pauser);
        cu.haltClass(classId, keccak256("incident"));
        vm.prank(feeOp);
        cu.collectHoldingFee(classId, _one(trader), _amt(1_000));
        assertEq(cu.balanceOf(lender, classId), 1_000);
    }

    function test_Fee_BypassFlagDoesNotLeak() public {
        _distribute();
        vm.prank(feeOp);
        cu.collectHoldingFee(classId, _one(trader), _amt(1_000));
        // after fee collection, ordinary transfers must be gated again
        vm.expectRevert(CommodityUnits.HolderNotVerified.selector);
        vm.prank(trader);
        cu.safeTransferFrom(trader, stranger, classId, 1, "");
    }

    // ------------------------------------------------------------------ marketplace resale

    function test_Marketplace_UnitsResellThroughExistingMarketplace() public {
        Marketplace mkt = new Marketplace(superAdmin, 2 days, usdc, ids, makeAddr("treasury"), 100);
        _registerPlatform(address(mkt));
        vm.prank(superAdmin);
        mkt.setAssetKind(address(cu), Marketplace.AssetKind.ERC1155);

        _distribute();
        usdc.mint(investor, _usdc(1_000));
        vm.prank(investor);
        usdc.approve(address(mkt), type(uint256).max);

        // trader sells 10 kg (10_000 units) at 0.001 USDC per gram = 10 USDC
        vm.startPrank(trader);
        cu.setApprovalForAll(address(mkt), true);
        uint256 listingId = mkt.list(address(cu), classId, 10_000, 1_000);
        vm.stopPrank();

        vm.prank(investor);
        mkt.buy(listingId, 10_000, _usdc(11));
        assertEq(cu.balanceOf(investor, classId), 10_000);
        assertEq(cu.balanceOf(trader, classId), 90_000);
    }

    function test_Marketplace_HaltedClassCannotBeListed() public {
        Marketplace mkt = new Marketplace(superAdmin, 2 days, usdc, ids, makeAddr("treasury"), 100);
        _registerPlatform(address(mkt));
        vm.prank(superAdmin);
        mkt.setAssetKind(address(cu), Marketplace.AssetKind.ERC1155);
        _distribute();
        vm.prank(pauser);
        cu.haltClass(classId, keccak256("incident"));
        vm.startPrank(trader);
        cu.setApprovalForAll(address(mkt), true);
        vm.expectRevert(Marketplace.NotTradable.selector);
        mkt.list(address(cu), classId, 1_000, 1_000);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ fuzz

    /// Whatever the lot size, buffer and sale size, selling stock and retiring the quoted units
    /// keeps the class within its backing, and per-lot accounting matches the token supply.
    function testFuzz_SaleKeepsBackingInvariant(uint64 grossIn, uint16 bufIn, uint64 saleIn) public {
        uint256 gross = bound(uint256(grossIn), 1_000, 1e15);
        uint16 buf = uint16(bound(uint256(bufIn), 0, 2_000));

        vm.prank(classMgr);
        uint256 cid = cu.createClass(bytes32("FUZZ"), bytes32("G"), buf, MAXFEE, originator, lender, "");
        vm.prank(operator);
        uint256 lotId = cu.submitLot(_terms(cid, "FZ-1", gross));
        vm.prank(auditor);
        cu.attestLot(lotId, gross, true, keccak256("a"));
        vm.prank(reviewer);
        cu.approveLot(lotId);

        (,,, bool ok0) = cu.backing(cid);
        assertTrue(ok0);

        uint256 grams = bound(uint256(saleIn), 1, gross);
        vm.prank(classMgr);
        uint256 sid = cu.proposeSale(lotId, grams, keccak256("PO"));
        vm.prank(reviewer);
        cu.approveSale(sid);

        uint256 units = cu.getSale(sid).unitsToRetire;
        if (units > 0) {
            vm.prank(retireOp);
            cu.retireForSale(sid, _one(originator), _amt(units));
        } else {
            // a sale so small it rounds to zero units cannot be completed by retirement; the quote itself must be 0
            assertEq(units, 0);
            return;
        }

        (,,, bool ok) = cu.backing(cid);
        assertTrue(ok, "backing broken after sale");
        assertEq(cu.getLot(lotId).issuedLive, cu.totalSupply(cid), "lot accounting drifted from supply");
    }
}
