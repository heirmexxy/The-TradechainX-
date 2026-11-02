// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {PlatformTestBase} from "./helpers/PlatformTestBase.sol";
import {Marketplace} from "../src/Marketplace.sol";
import {WarehouseRegistry} from "../src/WarehouseRegistry.sol";
import {WarehouseReceipt} from "../src/WarehouseReceipt.sol";
import {LPOToken} from "../src/LPOToken.sol";
import {CarbonCredits} from "../src/CarbonCredits.sol";
import {RWA721Base} from "../src/base/RWA721Base.sol";
import {IIdentityRegistry} from "../src/interfaces/IIdentityRegistry.sol";

contract MarketplaceTest is PlatformTestBase {
    Marketplace mkt;
    WarehouseRegistry whs;
    WarehouseReceipt wr;
    LPOToken lpo;
    CarbonCredits cc;

    address operator = makeAddr("warehouseOperator");
    address registrar = makeAddr("registrar");
    address treasury = makeAddr("treasury");
    uint256 whId;

    function setUp() public {
        _baseSetUp();
        whs = new WarehouseRegistry(superAdmin, 2 days, ids);
        wr = new WarehouseReceipt(superAdmin, 2 days, ids, whs);
        lpo = new LPOToken(superAdmin, 2 days, ids, usdc);
        cc = new CarbonCredits(superAdmin, 2 days, ids);
        mkt = new Marketplace(superAdmin, 2 days, usdc, ids, treasury, 100); // 1%
        _registerPlatform(address(mkt));

        vm.startPrank(superAdmin);
        whs.grantRole(whs.WAREHOUSE_REGISTRAR_ROLE(), registrar);
        wr.grantRole(wr.LISTING_REVIEWER_ROLE(), reviewer);
        lpo.grantRole(lpo.LISTING_REVIEWER_ROLE(), reviewer);
        cc.grantRole(cc.LISTING_REVIEWER_ROLE(), reviewer);
        mkt.grantRole(mkt.PAUSER_ROLE(), pauser);
        mkt.setAssetKind(address(wr), Marketplace.AssetKind.ERC721);
        mkt.setAssetKind(address(lpo), Marketplace.AssetKind.ERC721);
        mkt.setAssetKind(address(cc), Marketplace.AssetKind.ERC1155);
        vm.stopPrank();

        vm.prank(kycReviewer);
        ids.setIdentity(operator, IIdentityRegistry.Tier.Business, uint64(block.timestamp + YEAR), bytes32("op"));
        vm.prank(registrar);
        whId = whs.registerWarehouse(operator, keccak256("LIC-1"), "");

        usdc.mint(investor, _usdc(1_000_000));
        usdc.mint(investor2, _usdc(1_000_000));
        vm.prank(investor);
        usdc.approve(address(mkt), type(uint256).max);
        vm.prank(investor2);
        usdc.approve(address(mkt), type(uint256).max);
    }

    // ------------------------------------------------------------------ helpers

    function _receipt() internal returns (uint256 id) {
        WarehouseReceipt.ReceiptTerms memory t = WarehouseReceipt.ReceiptTerms({
            warehouseId: whId,
            receiptNumberHash: keccak256(abi.encode("WR", wr.submissionCount())),
            commodity: bytes32("MAIZE"),
            grade: bytes32("G1"),
            quantity: 50_000,
            depositDate: uint64(block.timestamp - 1 days),
            expiryDate: uint64(block.timestamp + 180 days),
            documentHash: keccak256("d"),
            metadataURI: ""
        });
        vm.prank(operator);
        uint256 sid = wr.submitReceipt(t, trader);
        vm.prank(reviewer);
        id = wr.approveSubmission(sid);
    }

    function _listReceipt(uint256 id, uint256 price) internal returns (uint256 listingId) {
        vm.startPrank(trader);
        wr.approve(address(mkt), id);
        listingId = mkt.list(address(wr), id, 1, price);
        vm.stopPrank();
    }

    function _carbon() internal returns (uint256 batchId) {
        CarbonCredits.BatchTerms memory t = CarbonCredits.BatchTerms({
            registry: bytes32("VERRA"),
            registryBatchIdHash: keccak256(abi.encode("B", cc.submissionCount())),
            projectIdHash: keccak256("P"),
            methodology: bytes32("VM0042"),
            vintage: 2025,
            quantity: 1_000,
            documentHash: keccak256("d"),
            metadataURI: ""
        });
        vm.prank(originator);
        uint256 sid = cc.submitBatch(t);
        vm.prank(reviewer);
        batchId = cc.approveSubmission(sid);
    }

    // ------------------------------------------------------------------ listing

    function test_ListingEscrowsTheAsset() public {
        uint256 id = _receipt();
        uint256 lid = _listReceipt(id, _usdc(10_000));
        assertEq(wr.ownerOf(id), address(mkt));
        Marketplace.Listing memory l = mkt.getListing(lid);
        assertEq(l.seller, trader);
        assertTrue(l.active);
        assertEq(l.feeBps, 100);
    }

    function test_CannotListDisallowedAsset() public {
        vm.expectRevert(Marketplace.AssetNotAllowed.selector);
        vm.prank(trader);
        mkt.list(address(0xdead), 1, 1, 1);
    }

    function test_CannotListPledgedReceipt() public {
        uint256 id = _receipt();
        vm.prank(trader);
        wr.grantLien(id, lender, uint64(block.timestamp + 30 days), bytes32("loan"));
        vm.startPrank(trader);
        wr.approve(address(mkt), id);
        vm.expectRevert(Marketplace.NotTradable.selector);
        mkt.list(address(wr), id, 1, _usdc(1));
        vm.stopPrank();
    }

    function test_ListedReceiptCannotBePledged() public {
        uint256 id = _receipt();
        _listReceipt(id, _usdc(1));
        vm.expectRevert(RWA721Base.NotHolder.selector);
        vm.prank(trader);
        wr.grantLien(id, lender, uint64(block.timestamp + 30 days), bytes32("loan"));
    }

    function test_UnverifiedCannotList() public {
        vm.expectRevert(Marketplace.NotVerified.selector);
        vm.prank(stranger);
        mkt.list(address(wr), 1, 1, 1);
    }

    // ------------------------------------------------------------------ buying

    function test_BuyIsAtomicDvPWithFee() public {
        uint256 id = _receipt();
        uint256 lid = _listReceipt(id, _usdc(10_000));
        vm.prank(investor);
        mkt.buy(lid, 1, _usdc(10_000));

        assertEq(wr.ownerOf(id), investor);
        assertEq(usdc.balanceOf(trader), _usdc(9_900));
        assertEq(usdc.balanceOf(treasury), _usdc(100));
        assertEq(usdc.balanceOf(address(mkt)), 0);
        assertFalse(mkt.getListing(lid).active);
    }

    function test_PriceChangeProtection() public {
        uint256 id = _receipt();
        uint256 lid = _listReceipt(id, _usdc(10_000));
        vm.prank(trader);
        mkt.updatePrice(lid, _usdc(20_000));
        vm.expectRevert(Marketplace.PriceAboveLimit.selector);
        vm.prank(investor);
        mkt.buy(lid, 1, _usdc(10_000));
    }

    function test_FeeSnapshotAtListing() public {
        uint256 id = _receipt();
        uint256 lid = _listReceipt(id, _usdc(10_000));
        vm.prank(superAdmin);
        mkt.setFee(500, treasury);
        vm.prank(investor);
        mkt.buy(lid, 1, _usdc(10_000));
        assertEq(usdc.balanceOf(treasury), _usdc(100)); // still 1%
    }

    function test_FeeCap() public {
        vm.expectRevert(Marketplace.FeeTooHigh.selector);
        vm.prank(superAdmin);
        mkt.setFee(501, treasury);
    }

    function test_UnverifiedBuyerBlocked() public {
        uint256 id = _receipt();
        uint256 lid = _listReceipt(id, _usdc(10));
        usdc.mint(stranger, _usdc(10));
        vm.startPrank(stranger);
        usdc.approve(address(mkt), type(uint256).max);
        vm.expectRevert(Marketplace.NotVerified.selector);
        mkt.buy(lid, 1, _usdc(10));
        vm.stopPrank();
    }

    function test_ExpiredReceiptCannotBeSoldButCanBeReturned() public {
        uint256 id = _receipt();
        uint256 lid = _listReceipt(id, _usdc(10));
        vm.warp(block.timestamp + 181 days);
        vm.expectRevert(Marketplace.NotTradable.selector);
        vm.prank(investor);
        mkt.buy(lid, 1, _usdc(10));
        vm.prank(trader);
        mkt.cancel(lid);
        assertEq(wr.ownerOf(id), trader);
    }

    function test_VoidedWhileListedClosesCleanly() public {
        uint256 id = _receipt();
        uint256 lid = _listReceipt(id, _usdc(10));
        vm.prank(operator);
        wr.requestWarehouseChange(id, WarehouseReceipt.RequestKind.Void, 0, bytes32("fire"));

        vm.expectRevert(Marketplace.NotTradable.selector);
        vm.prank(investor);
        mkt.buy(lid, 1, _usdc(10));

        vm.prank(reviewer);
        wr.approveStatusRequest(id);
        vm.prank(trader);
        mkt.cancel(lid);
        assertFalse(mkt.getListing(lid).active);
    }

    function test_SellerCannotBuyOwnListing() public {
        uint256 id = _receipt();
        uint256 lid = _listReceipt(id, _usdc(10));
        vm.expectRevert(Marketplace.SelfPurchase.selector);
        vm.prank(trader);
        mkt.buy(lid, 1, _usdc(10));
    }

    // ------------------------------------------------------------------ carbon partial fills

    function test_CarbonPartialFills() public {
        uint256 b = _carbon();
        vm.startPrank(originator);
        cc.setApprovalForAll(address(mkt), true);
        uint256 lid = mkt.list(address(cc), b, 600, _usdc(12));
        vm.stopPrank();

        vm.prank(investor);
        mkt.buy(lid, 100, _usdc(1_200));
        vm.prank(investor2);
        mkt.buy(lid, 200, _usdc(2_400));

        assertEq(cc.balanceOf(investor, b), 100);
        assertEq(cc.balanceOf(investor2, b), 200);
        assertEq(mkt.getListing(lid).remaining, 300);

        vm.prank(originator);
        mkt.cancel(lid);
        assertEq(cc.balanceOf(originator, b), 700);
    }

    function test_SuspendedCarbonCannotBeBought() public {
        uint256 b = _carbon();
        vm.startPrank(originator);
        cc.setApprovalForAll(address(mkt), true);
        uint256 lid = mkt.list(address(cc), b, 100, _usdc(12));
        vm.stopPrank();
        vm.prank(reviewer);
        cc.setSuspended(b, true, bytes32("registry review"));
        vm.expectRevert(Marketplace.NotTradable.selector);
        vm.prank(investor);
        mkt.buy(lid, 1, _usdc(12));
    }

    // ------------------------------------------------------------------ LPO financing

    function test_LPOBoughtAtDiscountThenSettledToBuyer() public {
        LPOToken.LPOTerms memory t = LPOToken.LPOTerms({
            lpoNumberHash: keccak256("LPO-9"),
            buyerRefHash: keccak256("RC-1"),
            description: bytes32("RICE"),
            faceValue: _usdc(10_000),
            issueDate: uint64(block.timestamp),
            dueDate: uint64(block.timestamp + 60 days),
            documentHash: keccak256("d"),
            metadataURI: ""
        });
        vm.prank(sme);
        uint256 sid = lpo.submitLPO(t);
        vm.prank(reviewer);
        uint256 id = lpo.approveSubmission(sid);

        vm.startPrank(sme);
        lpo.approve(address(mkt), id);
        uint256 lid = mkt.list(address(lpo), id, 1, _usdc(9_500)); // 5% discount
        vm.stopPrank();
        vm.prank(investor);
        mkt.buy(lid, 1, _usdc(9_500));
        assertEq(usdc.balanceOf(sme), _usdc(9_405)); // 9,500 − 1% fee

        address payer = makeAddr("offtaker");
        usdc.mint(payer, _usdc(10_000));
        vm.startPrank(payer);
        usdc.approve(address(lpo), type(uint256).max);
        lpo.settle(id);
        vm.stopPrank();
        assertEq(usdc.balanceOf(investor), _usdc(1_000_000) - _usdc(9_500) + _usdc(10_000));
    }

    // ------------------------------------------------------------------ admin & pause

    function test_AdminCancelReturnsToSellerNotAdmin() public {
        uint256 id = _receipt();
        uint256 lid = _listReceipt(id, _usdc(10));
        vm.prank(superAdmin);
        mkt.cancel(lid);
        assertEq(wr.ownerOf(id), trader);
    }

    function test_StrangerCannotCancel() public {
        uint256 id = _receipt();
        uint256 lid = _listReceipt(id, _usdc(10));
        vm.expectRevert(Marketplace.NotSeller.selector);
        vm.prank(investor);
        mkt.cancel(lid);
    }

    function test_PauseBlocksBuyingButSellersCanExit() public {
        uint256 id = _receipt();
        uint256 lid = _listReceipt(id, _usdc(10));
        vm.prank(pauser);
        mkt.pause();
        vm.expectRevert();
        vm.prank(investor);
        mkt.buy(lid, 1, _usdc(10));
        vm.prank(trader);
        mkt.cancel(lid);
        assertEq(wr.ownerOf(id), trader);
    }

    function testFuzz_FeeAndProceedsAddUp(uint64 price, uint16 bps) public {
        bps = uint16(bound(bps, 0, 500));
        price = uint64(bound(price, 1, type(uint64).max / 2));
        vm.prank(superAdmin);
        mkt.setFee(bps, treasury);
        uint256 id = _receipt();
        uint256 lid = _listReceipt(id, price);
        usdc.mint(investor, price);
        uint256 before = usdc.balanceOf(investor);
        vm.prank(investor);
        mkt.buy(lid, 1, price);
        assertEq(before - usdc.balanceOf(investor), price);
        assertEq(usdc.balanceOf(trader) + usdc.balanceOf(treasury), price);
        assertEq(usdc.balanceOf(address(mkt)), 0);
    }
}
