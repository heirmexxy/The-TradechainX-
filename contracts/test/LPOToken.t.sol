// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {PlatformTestBase} from "./helpers/PlatformTestBase.sol";
import {LPOToken} from "../src/LPOToken.sol";
import {RWA721Base} from "../src/base/RWA721Base.sol";
import {IIdentityRegistry} from "../src/interfaces/IIdentityRegistry.sol";

contract LPOTokenTest is PlatformTestBase {
    LPOToken lpo;

    function setUp() public {
        _baseSetUp();
        lpo = new LPOToken(superAdmin, 2 days, ids, usdc);
        bytes32 role = lpo.LISTING_REVIEWER_ROLE();
        vm.prank(superAdmin);
        lpo.grantRole(role, reviewer);
    }

    function _terms(string memory lpoNo) internal view returns (LPOToken.LPOTerms memory) {
        return LPOToken.LPOTerms({
            lpoNumberHash: keccak256(bytes(lpoNo)),
            buyerRefHash: keccak256("RC-123456"),
            description: bytes32("MAIZE_50T"),
            faceValue: _usdc(25_000),
            issueDate: uint64(block.timestamp - 1 days),
            dueDate: uint64(block.timestamp + 90 days),
            documentHash: keccak256("lpo-docs"),
            metadataURI: "https://api.tradechainx.com/metadata/lpo/1"
        });
    }

    function _issue(string memory lpoNo) internal returns (uint256 tokenId) {
        vm.prank(sme);
        uint256 sid = lpo.submitLPO(_terms(lpoNo));
        vm.prank(reviewer);
        tokenId = lpo.approveSubmission(sid);
    }

    // ---------------------------------------------------------------- gate

    function test_SubmitThenApproveMintsToSupplier() public {
        vm.prank(sme);
        uint256 sid = lpo.submitLPO(_terms("LPO-1"));
        assertEq(lpo.nextTokenId(), 0);
        vm.prank(reviewer);
        uint256 id = lpo.approveSubmission(sid);
        assertEq(lpo.ownerOf(id), sme);
        assertEq(lpo.originatorOf(id), sme);
        assertEq(lpo.getLPO(id).faceValue, _usdc(25_000));
    }

    function test_IndividualsCannotSubmit() public {
        LPOToken.LPOTerms memory t = _terms("LPO-1");
        vm.expectRevert(LPOToken.NotVerifiedEntity.selector);
        vm.prank(trader);
        lpo.submitLPO(t);
    }

    function test_SubmitterCannotApproveOwnLPO() public {
        bytes32 role = lpo.LISTING_REVIEWER_ROLE();
        vm.prank(superAdmin);
        lpo.grantRole(role, sme);
        vm.prank(sme);
        uint256 sid = lpo.submitLPO(_terms("LPO-1"));
        vm.expectRevert(RWA721Base.ReviewerConflict.selector);
        vm.prank(sme);
        lpo.approveSubmission(sid);
    }

    function test_DuplicateLPOForSameBuyerBlocked() public {
        _issue("LPO-1");
        LPOToken.LPOTerms memory t = _terms("LPO-1");
        vm.expectRevert(LPOToken.DuplicateLPO.selector);
        vm.prank(sme);
        lpo.submitLPO(t);
    }

    function test_SameNumberDifferentBuyerAllowed() public {
        _issue("LPO-1");
        LPOToken.LPOTerms memory t = _terms("LPO-1");
        t.buyerRefHash = keccak256("RC-999");
        vm.prank(sme);
        lpo.submitLPO(t);
    }

    function test_RejectFreesNumber() public {
        vm.prank(sme);
        uint256 sid = lpo.submitLPO(_terms("LPO-1"));
        vm.prank(reviewer);
        lpo.rejectSubmission(sid, bytes32("unconfirmed"));
        vm.prank(sme);
        lpo.submitLPO(_terms("LPO-1"));
    }

    function test_NeedsInfoResubmitCannotChangeBuyer() public {
        vm.prank(sme);
        uint256 sid = lpo.submitLPO(_terms("LPO-1"));
        vm.prank(reviewer);
        lpo.requestInfo(sid, bytes32("need buyer letter"));
        LPOToken.LPOTerms memory t = _terms("LPO-1");
        t.buyerRefHash = keccak256("other");
        vm.expectRevert(LPOToken.InvalidTerms.selector);
        vm.prank(sme);
        lpo.resubmit(sid, t);

        t = _terms("LPO-1");
        t.documentHash = keccak256("with letter");
        vm.prank(sme);
        lpo.resubmit(sid, t);
        vm.prank(reviewer);
        lpo.approveSubmission(sid);
    }

    function test_ZeroFaceValueRejected() public {
        LPOToken.LPOTerms memory t = _terms("LPO-1");
        t.faceValue = 0;
        vm.expectRevert(LPOToken.InvalidTerms.selector);
        vm.prank(sme);
        lpo.submitLPO(t);
    }

    // ---------------------------------------------------------------- settlement

    function test_SettlementPaysCurrentHolderAndRetires() public {
        uint256 id = _issue("LPO-1");
        vm.prank(sme);
        lpo.transferFrom(sme, investor, id); // SME sold the LPO to an investor

        address payer = makeAddr("buyerTreasury");
        usdc.mint(payer, _usdc(25_000));
        vm.startPrank(payer);
        usdc.approve(address(lpo), type(uint256).max);
        lpo.settle(id);
        vm.stopPrank();

        assertEq(usdc.balanceOf(investor), _usdc(25_000));
        vm.expectRevert();
        lpo.ownerOf(id);
    }

    function test_SettlementBlockedWhileLiened() public {
        uint256 id = _issue("LPO-1");
        vm.prank(sme);
        lpo.grantLien(id, lender, uint64(block.timestamp + 60 days), bytes32("facility"));
        usdc.mint(address(this), _usdc(25_000));
        usdc.approve(address(lpo), type(uint256).max);
        vm.expectRevert(RWA721Base.AlreadyLiened.selector);
        lpo.settle(id);
    }

    function test_SettlementBlockedWhileHeldByPlatform() public {
        address market = makeAddr("market");
        _registerPlatform(market);
        uint256 id = _issue("LPO-1");
        vm.prank(sme);
        lpo.transferFrom(sme, market, id);
        usdc.mint(address(this), _usdc(25_000));
        usdc.approve(address(lpo), type(uint256).max);
        vm.expectRevert(LPOToken.HeldByPlatform.selector);
        lpo.settle(id);
    }

    function test_OffChainSettlementThroughReviewer() public {
        uint256 id = _issue("LPO-1");
        vm.prank(sme);
        lpo.requestOffChainSettlement(id, bytes32("bank alert"));
        assertFalse(lpo.isTradable(id));
        vm.prank(reviewer);
        lpo.approveStatusRequest(id);
        vm.expectRevert();
        lpo.ownerOf(id);
    }

    function test_CancelBySupplierClearsLienAndBurns() public {
        uint256 id = _issue("LPO-1");
        vm.prank(sme);
        lpo.transferFrom(sme, investor, id);
        vm.prank(investor);
        lpo.grantLien(id, lender, uint64(block.timestamp + 30 days), bytes32("loan"));

        vm.prank(sme); // supplier, not holder, reports cancellation
        lpo.requestOriginatorChange(id, LPOToken.RequestKind.Cancel, 0, bytes32("buyer cancelled"));
        vm.prank(reviewer);
        lpo.approveStatusRequest(id);
        assertEq(lpo.getLien(id).lienholder, address(0));
    }

    function test_OnlySupplierCanRequestCancel() public {
        uint256 id = _issue("LPO-1");
        vm.prank(sme);
        lpo.transferFrom(sme, investor, id);
        vm.expectRevert(LPOToken.NotAuthorisedRequester.selector);
        vm.prank(investor);
        lpo.requestOriginatorChange(id, LPOToken.RequestKind.Cancel, 0, bytes32(0));
    }

    function test_ExtendDueDate() public {
        uint256 id = _issue("LPO-1");
        uint64 newDue = uint64(block.timestamp + 150 days);
        vm.prank(sme);
        lpo.requestOriginatorChange(id, LPOToken.RequestKind.ExtendDueDate, newDue, bytes32(0));
        vm.prank(reviewer);
        lpo.approveStatusRequest(id);
        assertEq(lpo.getLPO(id).dueDate, newDue);
    }

    function test_OverdueLPOCannotTrade() public {
        uint256 id = _issue("LPO-1");
        vm.warp(block.timestamp + 91 days);
        assertFalse(lpo.isTradable(id));
        vm.expectRevert(abi.encodeWithSelector(RWA721Base.TransferBlocked.selector, id));
        vm.prank(sme);
        lpo.transferFrom(sme, investor, id);
    }

    function test_TransferToUnverifiedBlocked() public {
        uint256 id = _issue("LPO-1");
        vm.expectRevert(RWA721Base.HolderNotVerified.selector);
        vm.prank(sme);
        lpo.transferFrom(sme, stranger, id);
    }

    function testFuzz_SettlementAlwaysPaysExactFaceValue(uint96 face) public {
        vm.assume(face > 0);
        LPOToken.LPOTerms memory t = _terms("LPO-F");
        t.faceValue = face;
        vm.prank(sme);
        uint256 sid = lpo.submitLPO(t);
        vm.prank(reviewer);
        uint256 id = lpo.approveSubmission(sid);

        usdc.mint(address(this), face);
        usdc.approve(address(lpo), face);
        uint256 before = usdc.balanceOf(sme);
        lpo.settle(id);
        assertEq(usdc.balanceOf(sme) - before, face);
        assertEq(usdc.balanceOf(address(lpo)), 0);
    }
}
