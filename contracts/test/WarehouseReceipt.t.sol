// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IdentityRegistry} from "../src/IdentityRegistry.sol";
import {IIdentityRegistry} from "../src/interfaces/IIdentityRegistry.sol";
import {WarehouseRegistry} from "../src/WarehouseRegistry.sol";
import {WarehouseReceipt} from "../src/WarehouseReceipt.sol";
import {RWA721Base} from "../src/base/RWA721Base.sol";

contract WarehouseReceiptTest is Test {
    IdentityRegistry ids;
    WarehouseRegistry whs;
    WarehouseReceipt wr;

    address superAdmin = makeAddr("superAdmin");
    address kycReviewer = makeAddr("kycReviewer");
    address registrar = makeAddr("registrar");
    address reviewer = makeAddr("reviewer");
    address pauser = makeAddr("pauser");

    address operator = makeAddr("warehouseOperator");
    address trader = makeAddr("trader");
    address buyer = makeAddr("buyer");
    address lender = makeAddr("lender");
    address stranger = makeAddr("stranger");

    uint256 whId;
    uint64 constant YEAR = 365 days;

    function setUp() public {
        vm.warp(1_780_000_000);

        ids = new IdentityRegistry(superAdmin, 2 days);
        whs = new WarehouseRegistry(superAdmin, 2 days, ids);
        wr = new WarehouseReceipt(superAdmin, 2 days, ids, whs);

        vm.startPrank(superAdmin);
        ids.grantRole(ids.KYC_REVIEWER_ROLE(), kycReviewer);
        whs.grantRole(whs.WAREHOUSE_REGISTRAR_ROLE(), registrar);
        wr.grantRole(wr.LISTING_REVIEWER_ROLE(), reviewer);
        wr.grantRole(wr.PAUSER_ROLE(), pauser);
        vm.stopPrank();

        uint64 until = uint64(block.timestamp + 2 * YEAR);
        vm.startPrank(kycReviewer);
        ids.setIdentity(operator, IIdentityRegistry.Tier.Business, until, keccak256("kyb-op"));
        ids.setIdentity(trader, IIdentityRegistry.Tier.Individual, until, keccak256("kyc-trader"));
        ids.setIdentity(buyer, IIdentityRegistry.Tier.Individual, until, keccak256("kyc-buyer"));
        ids.setIdentity(lender, IIdentityRegistry.Tier.Institutional, until, keccak256("kyb-lender"));
        vm.stopPrank();

        vm.prank(registrar);
        whId = whs.registerWarehouse(operator, keccak256("LIC-001"), "ipfs://warehouse-1");
    }

    // ------------------------------------------------------------------ helpers

    function _terms(string memory receiptNo) internal view returns (WarehouseReceipt.ReceiptTerms memory t) {
        t = WarehouseReceipt.ReceiptTerms({
            warehouseId: whId,
            receiptNumberHash: keccak256(bytes(receiptNo)),
            commodity: bytes32("MAIZE"),
            grade: bytes32("GRADE_1"),
            quantity: 50_000,
            depositDate: uint64(block.timestamp - 1 days),
            expiryDate: uint64(block.timestamp + 180 days),
            documentHash: keccak256("docs"),
            metadataURI: "ipfs://receipt"
        });
    }

    function _submit(string memory receiptNo) internal returns (uint256 sid) {
        vm.prank(operator);
        sid = wr.submitReceipt(_terms(receiptNo), trader);
    }

    function _issue(string memory receiptNo) internal returns (uint256 tokenId) {
        uint256 sid = _submit(receiptNo);
        vm.prank(reviewer);
        tokenId = wr.approveSubmission(sid);
    }

    // ------------------------------------------------------------------ gate: submit → review → mint

    function test_SubmitDoesNotMint() public {
        uint256 sid = _submit("WR-1");
        assertEq(wr.nextTokenId(), 0);
        assertEq(uint8(wr.getSubmission(sid).status), uint8(WarehouseReceipt.SubmissionStatus.Pending));
    }

    function test_ApproveMintsToHolder() public {
        uint256 tokenId = _issue("WR-1");
        assertEq(wr.ownerOf(tokenId), trader);
        assertEq(wr.getReceipt(tokenId).quantity, 50_000);
        assertEq(wr.tokenURI(tokenId), "ipfs://receipt");
        assertEq(wr.submissionOfToken(tokenId), 1);
    }

    function test_OnlyReviewerCanApprove() public {
        uint256 sid = _submit("WR-1");
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, wr.LISTING_REVIEWER_ROLE()));
        vm.prank(stranger);
        wr.approveSubmission(sid);
    }

    function test_ReviewerWhoIsOperatorCannotApprove() public {
        bytes32 role = wr.LISTING_REVIEWER_ROLE();
        vm.prank(superAdmin);
        wr.grantRole(role, operator);
        uint256 sid = _submit("WR-1");
        vm.expectRevert(RWA721Base.ReviewerConflict.selector);
        vm.prank(operator);
        wr.approveSubmission(sid);
    }

    function test_CannotApproveTwiceOrUnknown() public {
        uint256 sid = _submit("WR-1");
        vm.startPrank(reviewer);
        wr.approveSubmission(sid);
        vm.expectRevert(WarehouseReceipt.InvalidSubmissionState.selector);
        wr.approveSubmission(sid);
        vm.expectRevert(WarehouseReceipt.InvalidSubmissionState.selector);
        wr.approveSubmission(999);
        vm.stopPrank();
    }

    function test_NonOperatorCannotSubmit() public {
        WarehouseReceipt.ReceiptTerms memory t = _terms("WR-1");
        vm.expectRevert(WarehouseReceipt.NotActiveWarehouseOperator.selector);
        vm.prank(trader);
        wr.submitReceipt(t, trader);
    }

    function test_UnverifiedHolderRejectedAtSubmit() public {
        WarehouseReceipt.ReceiptTerms memory t = _terms("WR-1");
        vm.expectRevert(RWA721Base.HolderNotVerified.selector);
        vm.prank(operator);
        wr.submitReceipt(t, stranger);
    }

    function test_HolderKycLapsedBeforeApprovalBlocksMint() public {
        uint256 sid = _submit("WR-1");
        vm.prank(kycReviewer);
        ids.setFrozen(trader, true);
        vm.expectRevert(RWA721Base.HolderNotVerified.selector);
        vm.prank(reviewer);
        wr.approveSubmission(sid);
    }

    function test_InvalidTermsRejected() public {
        WarehouseReceipt.ReceiptTerms memory t = _terms("WR-1");
        t.quantity = 0;
        vm.expectRevert(WarehouseReceipt.InvalidTerms.selector);
        vm.prank(operator);
        wr.submitReceipt(t, trader);

        t = _terms("WR-1");
        t.expiryDate = uint64(block.timestamp);
        vm.expectRevert(WarehouseReceipt.InvalidTerms.selector);
        vm.prank(operator);
        wr.submitReceipt(t, trader);
    }

    function test_SuspendedWarehouseBlocksSubmitAndApproval() public {
        uint256 sid = _submit("WR-1");
        vm.prank(registrar);
        whs.setWarehouseActive(whId, false, keccak256("licence lapsed"));

        vm.expectRevert(WarehouseReceipt.WarehouseInactive.selector);
        vm.prank(reviewer);
        wr.approveSubmission(sid);

        WarehouseReceipt.ReceiptTerms memory t = _terms("WR-2");
        vm.expectRevert(WarehouseReceipt.NotActiveWarehouseOperator.selector);
        vm.prank(operator);
        wr.submitReceipt(t, trader);
    }

    function test_NeedsInfoThenResubmitThenApprove() public {
        uint256 sid = _submit("WR-1");
        vm.prank(reviewer);
        wr.requestInfo(sid, keccak256("blurry scan"));

        // Can't approve while waiting on info
        vm.expectRevert(WarehouseReceipt.InvalidSubmissionState.selector);
        vm.prank(reviewer);
        wr.approveSubmission(sid);

        WarehouseReceipt.ReceiptTerms memory t = _terms("WR-1");
        t.documentHash = keccak256("clear scan");
        vm.prank(operator);
        wr.resubmit(sid, t, trader);

        vm.prank(reviewer);
        uint256 tokenId = wr.approveSubmission(sid);
        assertEq(wr.getReceipt(tokenId).documentHash, keccak256("clear scan"));
    }

    function test_ResubmitCannotChangeReceiptNumber() public {
        uint256 sid = _submit("WR-1");
        vm.prank(reviewer);
        wr.requestInfo(sid, bytes32(0));
        WarehouseReceipt.ReceiptTerms memory t = _terms("WR-OTHER");
        vm.expectRevert(WarehouseReceipt.InvalidTerms.selector);
        vm.prank(operator);
        wr.resubmit(sid, t, trader);
    }

    // ------------------------------------------------------------------ duplicate issuance

    function test_DuplicateReceiptNumberBlocked() public {
        _submit("WR-1");
        WarehouseReceipt.ReceiptTerms memory t = _terms("WR-1");
        vm.expectRevert(WarehouseReceipt.DuplicateReceipt.selector);
        vm.prank(operator);
        wr.submitReceipt(t, trader);
    }

    function test_RejectedReceiptNumberCanBeResubmitted() public {
        uint256 sid = _submit("WR-1");
        vm.prank(reviewer);
        wr.rejectSubmission(sid, keccak256("wrong grade"));
        _submit("WR-1"); // allowed again
    }

    function test_RedeemedReceiptNumberCanNeverBeReissued() public {
        uint256 tokenId = _issue("WR-1");
        _redeemFully(tokenId);
        WarehouseReceipt.ReceiptTerms memory t = _terms("WR-1");
        vm.expectRevert(WarehouseReceipt.DuplicateReceipt.selector);
        vm.prank(operator);
        wr.submitReceipt(t, trader);
    }

    function testFuzz_SameNumberDifferentWarehousesIndependent(bytes32 numberHash) public {
        vm.assume(numberHash != bytes32(0));
        address op2 = makeAddr("op2");
        vm.prank(kycReviewer);
        ids.setIdentity(op2, IIdentityRegistry.Tier.Business, uint64(block.timestamp + YEAR), bytes32(0));
        vm.prank(registrar);
        uint256 wh2 = whs.registerWarehouse(op2, keccak256("LIC-002"), "");

        WarehouseReceipt.ReceiptTerms memory t = _terms("x");
        t.receiptNumberHash = numberHash;
        vm.prank(operator);
        wr.submitReceipt(t, trader);

        t.warehouseId = wh2;
        vm.prank(op2);
        wr.submitReceipt(t, trader); // same number, different warehouse: fine

        vm.expectRevert(WarehouseReceipt.DuplicateReceipt.selector);
        vm.prank(op2);
        wr.submitReceipt(t, trader);
    }

    // ------------------------------------------------------------------ transfers

    function test_TransferBetweenVerifiedHolders() public {
        uint256 tokenId = _issue("WR-1");
        vm.prank(trader);
        wr.transferFrom(trader, buyer, tokenId);
        assertEq(wr.ownerOf(tokenId), buyer);
    }

    function test_TransferToUnverifiedBlocked() public {
        uint256 tokenId = _issue("WR-1");
        vm.expectRevert(RWA721Base.HolderNotVerified.selector);
        vm.prank(trader);
        wr.transferFrom(trader, stranger, tokenId);
    }

    function test_FrozenHolderCannotTransfer() public {
        uint256 tokenId = _issue("WR-1");
        vm.prank(kycReviewer);
        ids.setFrozen(trader, true);
        vm.expectRevert(RWA721Base.HolderNotVerified.selector);
        vm.prank(trader);
        wr.transferFrom(trader, buyer, tokenId);
    }

    function test_ExpiredReceiptCannotTransfer() public {
        uint256 tokenId = _issue("WR-1");
        vm.warp(block.timestamp + 181 days);
        assertFalse(wr.isTransferable(tokenId));
        vm.expectRevert(abi.encodeWithSelector(RWA721Base.TransferBlocked.selector, tokenId));
        vm.prank(trader);
        wr.transferFrom(trader, buyer, tokenId);
    }

    function test_PlatformContractCanHoldReceipts() public {
        address escrow = makeAddr("escrow");
        vm.prank(superAdmin);
        ids.registerPlatformContract(escrow, keccak256("escrow-v1"));
        uint256 tokenId = _issue("WR-1");
        vm.prank(trader);
        wr.transferFrom(trader, escrow, tokenId);
        assertEq(wr.ownerOf(tokenId), escrow);
    }

    // ------------------------------------------------------------------ liens (double pledging)

    function _pledge(uint256 tokenId) internal {
        vm.prank(trader);
        wr.grantLien(tokenId, lender, uint64(block.timestamp + 90 days), keccak256("loan-1"));
    }

    function test_LienBlocksTransfer() public {
        uint256 tokenId = _issue("WR-1");
        _pledge(tokenId);
        vm.expectRevert(abi.encodeWithSelector(RWA721Base.TransferBlocked.selector, tokenId));
        vm.prank(trader);
        wr.transferFrom(trader, buyer, tokenId);
    }

    function test_CannotPledgeTwice() public {
        uint256 tokenId = _issue("WR-1");
        _pledge(tokenId);
        vm.expectRevert(RWA721Base.AlreadyLiened.selector);
        vm.prank(trader);
        wr.grantLien(tokenId, lender, uint64(block.timestamp + 30 days), keccak256("loan-2"));
    }

    function test_LienholderMustBeVerifiedEntity() public {
        uint256 tokenId = _issue("WR-1");
        vm.expectRevert(RWA721Base.LienholderNotVerifiedEntity.selector);
        vm.prank(trader);
        wr.grantLien(tokenId, buyer, uint64(block.timestamp + 30 days), bytes32(0)); // individual, not entity
    }

    function test_LienMaturityCannotExceedExpiry() public {
        uint256 tokenId = _issue("WR-1");
        vm.expectRevert(RWA721Base.InvalidMaturity.selector);
        vm.prank(trader);
        wr.grantLien(tokenId, lender, uint64(block.timestamp + 365 days), bytes32(0));
    }

    function test_ReleaseLienRestoresTransfer() public {
        uint256 tokenId = _issue("WR-1");
        _pledge(tokenId);
        vm.prank(lender);
        wr.releaseLien(tokenId);
        vm.prank(trader);
        wr.transferFrom(trader, buyer, tokenId);
    }

    function test_OnlyLienholderReleases() public {
        uint256 tokenId = _issue("WR-1");
        _pledge(tokenId);
        vm.expectRevert(RWA721Base.NotLienholder.selector);
        vm.prank(trader);
        wr.releaseLien(tokenId);
    }

    function test_EnforceLienOnlyAfterMaturity() public {
        uint256 tokenId = _issue("WR-1");
        _pledge(tokenId);
        vm.expectRevert(RWA721Base.LienNotMatured.selector);
        vm.prank(lender);
        wr.enforceLien(tokenId);

        vm.warp(block.timestamp + 91 days);
        vm.prank(lender);
        wr.enforceLien(tokenId);
        assertEq(wr.ownerOf(tokenId), lender);
        assertEq(wr.getLien(tokenId).lienholder, address(0));
    }

    function test_EnforceLienWorksEvenIfHolderKycLapsed() public {
        uint256 tokenId = _issue("WR-1");
        _pledge(tokenId);
        vm.prank(kycReviewer);
        ids.setFrozen(trader, true);
        vm.warp(block.timestamp + 91 days);
        vm.prank(lender);
        wr.enforceLien(tokenId);
        assertEq(wr.ownerOf(tokenId), lender);
    }

    function test_AdminCanResolveLienDispute() public {
        uint256 tokenId = _issue("WR-1");
        _pledge(tokenId);
        vm.prank(superAdmin);
        wr.adminReleaseLien(tokenId);
        assertEq(wr.getLien(tokenId).lienholder, address(0));
    }

    function test_CannotRedeemWhileLiened() public {
        uint256 tokenId = _issue("WR-1");
        _pledge(tokenId);
        vm.expectRevert(RWA721Base.AlreadyLiened.selector);
        vm.prank(trader);
        wr.requestRedemption(tokenId, 0, bytes32(0));
    }

    // ------------------------------------------------------------------ status changes

    function _redeemFully(uint256 tokenId) internal {
        vm.prank(wr.ownerOf(tokenId));
        wr.requestRedemption(tokenId, 0, keccak256("release note"));
        vm.prank(operator);
        wr.confirmWarehouseRelease(tokenId);
        vm.prank(reviewer);
        wr.approveStatusRequest(tokenId);
    }

    function test_FullRedemptionBurns() public {
        uint256 tokenId = _issue("WR-1");
        _redeemFully(tokenId);
        vm.expectRevert();
        wr.ownerOf(tokenId);
    }

    function test_RedemptionNeedsWarehouseConfirmation() public {
        uint256 tokenId = _issue("WR-1");
        vm.prank(trader);
        wr.requestRedemption(tokenId, 0, bytes32(0));
        vm.expectRevert(WarehouseReceipt.WarehouseConfirmationRequired.selector);
        vm.prank(reviewer);
        wr.approveStatusRequest(tokenId);
    }

    function test_PendingRequestBlocksTransferAndPledge() public {
        uint256 tokenId = _issue("WR-1");
        vm.prank(trader);
        wr.requestRedemption(tokenId, 0, bytes32(0));

        vm.expectRevert(abi.encodeWithSelector(RWA721Base.TransferBlocked.selector, tokenId));
        vm.prank(trader);
        wr.transferFrom(trader, buyer, tokenId);

        vm.expectRevert(RWA721Base.RequestPending.selector);
        vm.prank(trader);
        wr.grantLien(tokenId, lender, uint64(block.timestamp + 30 days), bytes32(0));

        vm.prank(trader);
        wr.cancelStatusRequest(tokenId);
        vm.prank(trader);
        wr.transferFrom(trader, buyer, tokenId);
    }

    function test_PartialRedemption() public {
        uint256 tokenId = _issue("WR-1");
        vm.prank(trader);
        wr.requestRedemption(tokenId, 20_000, bytes32(0));
        vm.prank(operator);
        wr.confirmWarehouseRelease(tokenId);
        vm.prank(reviewer);
        wr.approveStatusRequest(tokenId);
        assertEq(wr.getReceipt(tokenId).quantity, 20_000);
        assertEq(wr.ownerOf(tokenId), trader);
    }

    function test_PartialRedemptionMustReduceQuantity() public {
        uint256 tokenId = _issue("WR-1");
        vm.expectRevert(RWA721Base.InvalidRequest.selector);
        vm.prank(trader);
        wr.requestRedemption(tokenId, 50_000, bytes32(0));
    }

    function test_VoidBurnsAndClearsLien() public {
        uint256 tokenId = _issue("WR-1");
        _pledge(tokenId);
        vm.prank(operator);
        wr.requestWarehouseChange(tokenId, WarehouseReceipt.RequestKind.Void, 0, keccak256("fire damage"));
        vm.prank(reviewer);
        wr.approveStatusRequest(tokenId);
        vm.expectRevert();
        wr.ownerOf(tokenId);
        assertEq(wr.getLien(tokenId).lienholder, address(0));
    }

    function test_ExtendExpiry() public {
        uint256 tokenId = _issue("WR-1");
        uint64 newExpiry = uint64(block.timestamp + 365 days);
        vm.prank(operator);
        wr.requestWarehouseChange(tokenId, WarehouseReceipt.RequestKind.ExtendExpiry, newExpiry, bytes32(0));
        vm.prank(reviewer);
        wr.approveStatusRequest(tokenId);
        assertEq(wr.getReceipt(tokenId).expiryDate, newExpiry);
    }

    function test_OperatorCannotRequestRedeemKind() public {
        uint256 tokenId = _issue("WR-1");
        vm.expectRevert(RWA721Base.InvalidRequest.selector);
        vm.prank(operator);
        wr.requestWarehouseChange(tokenId, WarehouseReceipt.RequestKind.Redeem, 0, bytes32(0));
    }

    function test_ReviewerCannotApproveOwnHoldersRequest() public {
        uint256 tokenId = _issue("WR-1");
        bytes32 role = wr.LISTING_REVIEWER_ROLE();
        vm.prank(superAdmin);
        wr.grantRole(role, trader);
        vm.prank(trader);
        wr.requestRedemption(tokenId, 0, bytes32(0));
        vm.prank(operator);
        wr.confirmWarehouseRelease(tokenId);
        vm.expectRevert(RWA721Base.ReviewerConflict.selector);
        vm.prank(trader);
        wr.approveStatusRequest(tokenId);
    }

    function test_RejectStatusRequest() public {
        uint256 tokenId = _issue("WR-1");
        vm.prank(trader);
        wr.requestRedemption(tokenId, 0, bytes32(0));
        vm.prank(reviewer);
        wr.rejectStatusRequest(tokenId, keccak256("no release docs"));
        assertEq(uint8(wr.getStatusRequest(tokenId).kind), 0);
        assertEq(wr.ownerOf(tokenId), trader);
    }

    // ------------------------------------------------------------------ pause

    function test_PauseBlocksTransfersAndApprovals() public {
        uint256 tokenId = _issue("WR-1");
        uint256 sid = _submit("WR-2");
        vm.prank(pauser);
        wr.pause();

        vm.expectRevert(Pausable.EnforcedPause.selector);
        vm.prank(trader);
        wr.transferFrom(trader, buyer, tokenId);

        vm.expectRevert(Pausable.EnforcedPause.selector);
        vm.prank(reviewer);
        wr.approveSubmission(sid);
    }

    function test_PauserCannotUnpause() public {
        vm.startPrank(pauser);
        wr.pause();
        vm.expectRevert();
        wr.unpause();
        vm.stopPrank();
        vm.prank(superAdmin);
        wr.unpause();
        assertFalse(wr.paused());
    }

    // ------------------------------------------------------------------ registries

    function test_KycReviewerCannotGrantPlatformTier() public {
        vm.expectRevert(IdentityRegistry.InvalidTier.selector);
        vm.prank(kycReviewer);
        ids.setIdentity(stranger, IIdentityRegistry.Tier.Platform, uint64(block.timestamp + 1 days), bytes32(0));
    }

    function test_KycExpiryLapses() public {
        vm.prank(kycReviewer);
        ids.setIdentity(stranger, IIdentityRegistry.Tier.Individual, uint64(block.timestamp + 1 days), bytes32(0));
        assertTrue(ids.isVerified(stranger));
        vm.warp(block.timestamp + 2 days);
        assertFalse(ids.isVerified(stranger));
    }

    function test_ReverifyDoesNotLiftFreeze() public {
        vm.startPrank(kycReviewer);
        ids.setFrozen(trader, true);
        ids.setIdentity(trader, IIdentityRegistry.Tier.Individual, uint64(block.timestamp + YEAR), bytes32(0));
        vm.stopPrank();
        assertFalse(ids.isVerified(trader));
    }

    function test_WarehouseOperatorMustBeVerifiedBusiness() public {
        vm.expectRevert(WarehouseRegistry.OperatorNotVerifiedEntity.selector);
        vm.prank(registrar);
        whs.registerWarehouse(trader, keccak256("LIC-X"), ""); // individual tier
    }

    function test_LicenceCannotBackTwoWarehouses() public {
        vm.expectRevert(WarehouseRegistry.LicenceAlreadyRegistered.selector);
        vm.prank(registrar);
        whs.registerWarehouse(operator, keccak256("LIC-001"), "");
    }

    function test_OperatorKybLapseBlocksSubmission() public {
        vm.prank(kycReviewer);
        ids.setFrozen(operator, true);
        WarehouseReceipt.ReceiptTerms memory t = _terms("WR-1");
        vm.expectRevert(WarehouseReceipt.NotActiveWarehouseOperator.selector);
        vm.prank(operator);
        wr.submitReceipt(t, trader);
    }
}
