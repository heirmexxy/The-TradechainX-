// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {PlatformTestBase} from "./helpers/PlatformTestBase.sol";
import {CarbonCredits} from "../src/CarbonCredits.sol";
import {IERC1155Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";

contract CarbonCreditsTest is PlatformTestBase {
    CarbonCredits cc;

    function setUp() public {
        _baseSetUp();
        cc = new CarbonCredits(superAdmin, 2 days, ids);
        bytes32 r = cc.LISTING_REVIEWER_ROLE();
        bytes32 p = cc.PAUSER_ROLE();
        vm.startPrank(superAdmin);
        cc.grantRole(r, reviewer);
        cc.grantRole(p, pauser);
        vm.stopPrank();
    }

    function _terms(string memory batchRef) internal pure returns (CarbonCredits.BatchTerms memory) {
        return CarbonCredits.BatchTerms({
            registry: bytes32("VERRA"),
            registryBatchIdHash: keccak256(bytes(batchRef)),
            projectIdHash: keccak256("VCS-1234"),
            methodology: bytes32("VM0042"),
            vintage: 2025,
            quantity: 10_000,
            documentHash: keccak256("registry statement"),
            metadataURI: "https://api.tradechainx.com/metadata/carbon/1"
        });
    }

    function _issue(string memory batchRef) internal returns (uint256 batchId) {
        vm.prank(originator);
        uint256 sid = cc.submitBatch(_terms(batchRef));
        vm.prank(reviewer);
        batchId = cc.approveSubmission(sid);
    }

    function test_ApproveMintsBatch() public {
        uint256 id = _issue("B-1");
        assertEq(cc.balanceOf(originator, id), 10_000);
        assertEq(cc.totalSupply(id), 10_000);
        assertTrue(cc.isTradable(id));
    }

    function test_SubmitDoesNotMint() public {
        vm.prank(originator);
        cc.submitBatch(_terms("B-1"));
        assertEq(cc.nextBatchId(), 0);
    }

    function test_DuplicateRegistryBatchBlocked() public {
        _issue("B-1");
        CarbonCredits.BatchTerms memory t = _terms("B-1");
        vm.expectRevert(CarbonCredits.DuplicateBatch.selector);
        vm.prank(originator);
        cc.submitBatch(t);
    }

    function test_IndividualsCannotOriginate() public {
        CarbonCredits.BatchTerms memory t = _terms("B-1");
        vm.expectRevert(CarbonCredits.NotVerifiedEntity.selector);
        vm.prank(trader);
        cc.submitBatch(t);
    }

    function test_OriginatorCannotApproveOwnBatch() public {
        bytes32 r = cc.LISTING_REVIEWER_ROLE();
        vm.prank(superAdmin);
        cc.grantRole(r, originator);
        vm.prank(originator);
        uint256 sid = cc.submitBatch(_terms("B-1"));
        vm.expectRevert(CarbonCredits.ReviewerConflict.selector);
        vm.prank(originator);
        cc.approveSubmission(sid);
    }

    function test_FutureVintageRejected() public {
        CarbonCredits.BatchTerms memory t = _terms("B-1");
        t.vintage = 2099;
        vm.expectRevert(CarbonCredits.InvalidTerms.selector);
        vm.prank(originator);
        cc.submitBatch(t);
    }

    function test_RetireBurnsAndRecords() public {
        uint256 id = _issue("B-1");
        vm.prank(originator);
        cc.safeTransferFrom(originator, trader, id, 500, "");
        vm.prank(trader);
        uint256 rid = cc.retire(id, 200, keccak256("Acme Ltd 2026 footprint"), bytes32("offset"));
        assertEq(rid, 1);
        assertEq(cc.retiredOf(id), 200);
        assertEq(cc.balanceOf(trader, id), 300);
        assertEq(cc.totalSupply(id), 9_800);
    }

    function test_CannotRetireMoreThanHeld() public {
        uint256 id = _issue("B-1");
        vm.expectRevert(abi.encodeWithSelector(IERC1155Errors.ERC1155InsufficientBalance.selector, trader, 0, 1, id));
        vm.prank(trader);
        cc.retire(id, 1, bytes32(0), bytes32(0));
    }

    function test_SuspendedBatchFrozen() public {
        uint256 id = _issue("B-1");
        vm.prank(reviewer);
        cc.setSuspended(id, true, bytes32("registry cancellation"));
        assertFalse(cc.isTradable(id));

        vm.expectRevert(abi.encodeWithSelector(CarbonCredits.BatchIsSuspended.selector, id));
        vm.prank(originator);
        cc.safeTransferFrom(originator, trader, id, 1, "");

        vm.expectRevert(abi.encodeWithSelector(CarbonCredits.BatchIsSuspended.selector, id));
        vm.prank(originator);
        cc.retire(id, 1, bytes32(0), bytes32(0));

        vm.prank(reviewer);
        cc.setSuspended(id, false, bytes32("cleared"));
        vm.prank(originator);
        cc.safeTransferFrom(originator, trader, id, 1, "");
    }

    function test_TransferToUnverifiedBlocked() public {
        uint256 id = _issue("B-1");
        vm.expectRevert(CarbonCredits.HolderNotVerified.selector);
        vm.prank(originator);
        cc.safeTransferFrom(originator, stranger, id, 1, "");
    }

    function test_PauseBlocksTransfersOnlyAdminUnpauses() public {
        uint256 id = _issue("B-1");
        vm.prank(pauser);
        cc.pause();
        vm.expectRevert();
        vm.prank(originator);
        cc.safeTransferFrom(originator, trader, id, 1, "");
        vm.expectRevert();
        vm.prank(pauser);
        cc.unpause();
        vm.prank(superAdmin);
        cc.unpause();
    }

    function testFuzz_RetiredPlusSupplyEqualsIssued(uint96 moved, uint96 retired) public {
        uint256 id = _issue("B-1");
        moved = uint96(bound(moved, 0, 10_000));
        retired = uint96(bound(retired, 1, 10_000));
        vm.prank(originator);
        cc.safeTransferFrom(originator, trader, id, moved, "");
        uint256 fromTrader = retired > moved ? moved : retired;
        if (fromTrader > 0) {
            vm.prank(trader);
            cc.retire(id, fromTrader, bytes32(0), bytes32(0));
        }
        assertEq(cc.totalSupply(id) + cc.retiredOf(id), 10_000);
    }
}
