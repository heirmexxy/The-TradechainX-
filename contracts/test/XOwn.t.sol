// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {PlatformTestBase} from "./helpers/PlatformTestBase.sol";
import {XOwnFactory} from "../src/xown/XOwnFactory.sol";
import {XOwnVault} from "../src/xown/XOwnVault.sol";
import {XOwnEquipment} from "../src/xown/XOwnEquipment.sol";
import {IIdentityRegistry} from "../src/interfaces/IIdentityRegistry.sol";

contract XOwnTest is PlatformTestBase {
    XOwnFactory factory;
    address manager = makeAddr("assetManager");
    address operatorSpv = makeAddr("operatorSpv");

    function setUp() public {
        _baseSetUp();
        vm.prank(kycReviewer);
        ids.setIdentity(operatorSpv, IIdentityRegistry.Tier.Business, uint64(block.timestamp + YEAR), bytes32("spv"));
        factory = new XOwnFactory(superAdmin, 2 days, ids, usdc);
        vm.startPrank(superAdmin);
        factory.grantRole(factory.ASSET_MANAGER_ROLE(), manager);
        factory.grantRole(factory.LISTING_REVIEWER_ROLE(), reviewer);
        factory.grantRole(factory.PAUSER_ROLE(), pauser);
        vm.stopPrank();

        usdc.mint(investor, _usdc(100_000));
        usdc.mint(investor2, _usdc(100_000));
        usdc.mint(trader, _usdc(100_000));
    }

    function _terms(string memory serial) internal view returns (XOwnFactory.OfferingTerms memory) {
        return XOwnFactory.OfferingTerms({
            name: "XOwn Tractor Iseyin",
            symbol: "XO-TR1",
            operator: operatorSpv,
            maxShares: 100,
            pricePerShare: _usdc(250), // 25,000 USDC tractor
            subscriptionDeadline: uint64(block.timestamp + 30 days),
            equipment: XOwnEquipment.Equipment({
                assetType: bytes32("TRACTOR"),
                serialHash: keccak256(bytes(serial)),
                documentHash: keccak256("invoice+insurance"),
                metadataURI: "https://api.tradechainx.com/metadata/xown/1"
            })
        });
    }

    function _offering() internal returns (XOwnVault v) {
        vm.prank(manager);
        uint256 pid = factory.propose(_terms("SN-1"));
        vm.prank(reviewer);
        v = XOwnVault(factory.approve(pid));
    }

    function _subscribe(XOwnVault v, address who, uint256 shares) internal {
        vm.startPrank(who);
        usdc.approve(address(v), type(uint256).max);
        v.subscribe(shares);
        vm.stopPrank();
    }

    function _fill(XOwnVault v) internal {
        _subscribe(v, investor, 60);
        _subscribe(v, investor2, 40);
    }

    // ---------------------------------------------------------------- gate

    function test_ProposeThenApproveDeploysVaultWithEquipment() public {
        XOwnVault v = _offering();
        assertEq(factory.equipment().ownerOf(v.equipmentId()), address(v));
        assertEq(uint8(v.state()), uint8(XOwnVault.State.Fundraising));
        assertEq(factory.vaultCount(), 1);
    }

    function test_ProposerCannotApprove() public {
        bytes32 r = factory.LISTING_REVIEWER_ROLE();
        vm.prank(superAdmin);
        factory.grantRole(r, manager);
        vm.prank(manager);
        uint256 pid = factory.propose(_terms("SN-1"));
        vm.expectRevert(XOwnFactory.ReviewerConflict.selector);
        vm.prank(manager);
        factory.approve(pid);
    }

    function test_OperatorMustBeVerifiedBusiness() public {
        XOwnFactory.OfferingTerms memory t = _terms("SN-1");
        t.operator = trader; // individual
        vm.expectRevert(XOwnFactory.OperatorNotVerifiedEntity.selector);
        vm.prank(manager);
        factory.propose(t);
    }

    function test_SameMachineCannotBeOfferedTwice() public {
        _offering();
        XOwnFactory.OfferingTerms memory t = _terms("SN-1");
        vm.expectRevert(XOwnFactory.InvalidTerms.selector);
        vm.prank(manager);
        factory.propose(t);
    }

    function test_EquipmentNFTNonTransferable() public {
        XOwnVault v = _offering();
        XOwnEquipment eq = factory.equipment();
        uint256 eqId = v.equipmentId();
        vm.expectRevert(XOwnEquipment.NonTransferable.selector);
        vm.prank(address(v));
        eq.transferFrom(address(v), investor, eqId);
    }

    // ---------------------------------------------------------------- fundraising

    function test_FundsReleasedToOperatorOnlyWhenFull() public {
        XOwnVault v = _offering();
        _subscribe(v, investor, 60);
        assertEq(usdc.balanceOf(operatorSpv), 0);
        assertEq(usdc.balanceOf(address(v)), _usdc(15_000));
        _subscribe(v, investor2, 40);
        assertEq(usdc.balanceOf(operatorSpv), _usdc(25_000));
        assertEq(uint8(v.state()), uint8(XOwnVault.State.Active));
    }

    function test_CannotOversubscribe() public {
        XOwnVault v = _offering();
        _subscribe(v, investor, 60);
        vm.startPrank(investor2);
        usdc.approve(address(v), type(uint256).max);
        vm.expectRevert(XOwnVault.InvalidAmount.selector);
        v.subscribe(41);
        vm.stopPrank();
    }

    function test_UnverifiedCannotSubscribe() public {
        XOwnVault v = _offering();
        usdc.mint(stranger, _usdc(1_000));
        vm.startPrank(stranger);
        usdc.approve(address(v), type(uint256).max);
        vm.expectRevert(XOwnVault.NotVerified.selector);
        v.subscribe(1);
        vm.stopPrank();
    }

    function test_FailedOfferingRefundsInFull() public {
        XOwnVault v = _offering();
        _subscribe(v, investor, 60);
        vm.expectRevert(XOwnVault.DeadlineNotPassed.selector);
        v.markFailed();
        vm.warp(block.timestamp + 31 days);
        v.markFailed();
        vm.prank(investor);
        v.refund();
        assertEq(usdc.balanceOf(investor), _usdc(100_000));
        assertEq(v.totalSupply(), 0);
    }

    // ---------------------------------------------------------------- yield

    function test_YieldRequiresRealDepositAndSplitsProRata() public {
        XOwnVault v = _offering();
        _fill(v);
        usdc.mint(operatorSpv, _usdc(1_000));
        vm.startPrank(operatorSpv);
        usdc.approve(address(v), type(uint256).max);
        v.depositYield(_usdc(1_000));
        vm.stopPrank();

        assertEq(v.claimableYield(investor), _usdc(600));
        assertEq(v.claimableYield(investor2), _usdc(400));
        vm.prank(investor);
        v.claimYield();
        assertEq(usdc.balanceOf(investor), _usdc(100_000) - _usdc(15_000) + _usdc(600));
    }

    /// Regression for the original contract's double-claim bug.
    function test_MovingSharesCannotDoubleClaim() public {
        XOwnVault v = _offering();
        _fill(v);
        usdc.mint(operatorSpv, _usdc(1_000));
        vm.startPrank(operatorSpv);
        usdc.approve(address(v), type(uint256).max);
        v.depositYield(_usdc(1_000));
        vm.stopPrank();

        vm.startPrank(investor);
        v.claimYield(); // 600
        v.transfer(trader, 60);
        vm.stopPrank();

        assertEq(v.claimableYield(trader), 0);
        vm.expectRevert(XOwnVault.NothingToClaim.selector);
        vm.prank(trader);
        v.claimYield();

        vm.prank(investor2);
        v.claimYield(); // 400
        assertEq(usdc.balanceOf(address(v)), 0); // exactly what was deposited, nothing more
    }

    function test_UnclaimedYieldStaysWithSellerAfterTransfer() public {
        XOwnVault v = _offering();
        _fill(v);
        usdc.mint(operatorSpv, _usdc(1_000));
        vm.startPrank(operatorSpv);
        usdc.approve(address(v), type(uint256).max);
        v.depositYield(_usdc(1_000));
        vm.stopPrank();
        vm.prank(investor);
        v.transfer(trader, 60); // before claiming
        assertEq(v.claimableYield(investor), _usdc(600));
        assertEq(v.claimableYield(trader), 0);
    }

    function test_SharesTransferOnlyToVerified() public {
        XOwnVault v = _offering();
        _fill(v);
        vm.expectRevert(XOwnVault.NotVerified.selector);
        vm.prank(investor);
        v.transfer(stranger, 1);
    }

    // ---------------------------------------------------------------- dissolution

    function _dissolve(XOwnVault v, uint256 proceeds) internal {
        usdc.mint(operatorSpv, proceeds);
        vm.startPrank(operatorSpv);
        usdc.approve(address(v), type(uint256).max);
        v.depositProceeds(proceeds);
        vm.stopPrank();
        vm.prank(reviewer);
        v.dissolve();
    }

    function test_DissolveAndRedeemProRata() public {
        XOwnVault v = _offering();
        _fill(v);
        uint256 eqId = v.equipmentId();
        XOwnEquipment eq = factory.equipment();
        _dissolve(v, _usdc(20_000));
        vm.expectRevert();
        eq.ownerOf(eqId); // burned

        vm.prank(investor);
        v.redeem();
        vm.prank(investor2);
        v.redeem();
        assertEq(usdc.balanceOf(investor), _usdc(100_000) - _usdc(15_000) + _usdc(12_000));
        assertEq(usdc.balanceOf(investor2), _usdc(100_000) - _usdc(10_000) + _usdc(8_000));
        assertEq(usdc.balanceOf(address(v)), 0);
    }

    function test_OnlyReviewerDissolvesAndNeedsProceeds() public {
        XOwnVault v = _offering();
        _fill(v);
        vm.expectRevert(XOwnVault.NotReviewer.selector);
        vm.prank(operatorSpv);
        v.dissolve();
        vm.expectRevert(XOwnVault.NoProceeds.selector);
        vm.prank(reviewer);
        v.dissolve();
    }

    function test_RedeemIncludesUnclaimedYield() public {
        XOwnVault v = _offering();
        _fill(v);
        usdc.mint(operatorSpv, _usdc(1_000));
        vm.startPrank(operatorSpv);
        usdc.approve(address(v), type(uint256).max);
        v.depositYield(_usdc(1_000));
        vm.stopPrank();
        _dissolve(v, _usdc(20_000));
        vm.prank(investor2);
        v.redeem();
        assertEq(usdc.balanceOf(investor2), _usdc(100_000) - _usdc(10_000) + _usdc(8_000) + _usdc(400));
    }

    function test_FactoryPauseStopsVaults() public {
        XOwnVault v = _offering();
        vm.prank(pauser);
        factory.pause();
        vm.startPrank(investor);
        usdc.approve(address(v), type(uint256).max);
        vm.expectRevert(XOwnVault.Paused.selector);
        v.subscribe(1);
        vm.stopPrank();
    }

    function testFuzz_YieldConservation(uint64 dep1, uint64 dep2, uint8 moved) public {
        dep1 = uint64(bound(dep1, 1e6, 1e12));
        dep2 = uint64(bound(dep2, 1e6, 1e12));
        moved = uint8(bound(moved, 0, 60));
        XOwnVault v = _offering();
        _fill(v);
        usdc.mint(operatorSpv, uint256(dep1) + dep2);
        vm.startPrank(operatorSpv);
        usdc.approve(address(v), type(uint256).max);
        v.depositYield(dep1);
        vm.stopPrank();
        vm.prank(investor);
        v.transfer(trader, moved);
        vm.prank(operatorSpv);
        v.depositYield(dep2);

        uint256 owed = v.claimableYield(investor) + v.claimableYield(investor2) + v.claimableYield(trader);
        assertLe(owed, uint256(dep1) + dep2); // never over-promised
        assertGe(owed + 6, uint256(dep1) + dep2); // dust bounded: at most a couple of units per holder

        // Everyone can actually withdraw what they're owed.
        address[3] memory holders = [investor, investor2, trader];
        for (uint256 i = 0; i < 3; i++) {
            if (v.claimableYield(holders[i]) > 0) {
                vm.prank(holders[i]);
                v.claimYield();
            }
        }
    }
}
