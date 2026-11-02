// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {PlatformTestBase} from "./helpers/PlatformTestBase.sol";
import {IIdentityRegistry} from "../src/interfaces/IIdentityRegistry.sol";
import {WarehouseRegistry} from "../src/WarehouseRegistry.sol";
import {WarehouseReceipt} from "../src/WarehouseReceipt.sol";
import {LPOToken} from "../src/LPOToken.sol";
import {CarbonCredits} from "../src/CarbonCredits.sol";
import {Marketplace} from "../src/Marketplace.sol";
import {XOwnFactory} from "../src/xown/XOwnFactory.sol";
import {XOwnVault} from "../src/xown/XOwnVault.sol";
import {XOwnEquipment} from "../src/xown/XOwnEquipment.sol";

/// One long journey through every product line, wired the way the deploy script wires production.
/// If a change breaks how the contracts fit together, this is the test that fails.
contract PlatformJourneyTest is PlatformTestBase {
    WarehouseRegistry whs;
    WarehouseReceipt wr;
    LPOToken lpo;
    CarbonCredits cc;
    Marketplace mkt;
    XOwnFactory xf;

    address registrar = makeAddr("registrar");
    address manager = makeAddr("assetManager");
    address treasury = makeAddr("treasury");
    address warehouse = makeAddr("warehouseOperator");
    address spv = makeAddr("tractorSpv");
    address offtaker = makeAddr("offtakerTreasury");

    function setUp() public {
        _baseSetUp();
        whs = new WarehouseRegistry(superAdmin, 2 days, ids);
        wr = new WarehouseReceipt(superAdmin, 2 days, ids, whs);
        lpo = new LPOToken(superAdmin, 2 days, ids, usdc);
        cc = new CarbonCredits(superAdmin, 2 days, ids);
        mkt = new Marketplace(superAdmin, 2 days, usdc, ids, treasury, 100);
        xf = new XOwnFactory(superAdmin, 2 days, ids, usdc);

        vm.startPrank(superAdmin);
        ids.registerPlatformContract(address(mkt), keccak256("marketplace-v1"));
        mkt.setAssetKind(address(wr), Marketplace.AssetKind.ERC721);
        mkt.setAssetKind(address(lpo), Marketplace.AssetKind.ERC721);
        mkt.setAssetKind(address(cc), Marketplace.AssetKind.ERC1155);
        whs.grantRole(whs.WAREHOUSE_REGISTRAR_ROLE(), registrar);
        wr.grantRole(wr.LISTING_REVIEWER_ROLE(), reviewer);
        lpo.grantRole(lpo.LISTING_REVIEWER_ROLE(), reviewer);
        cc.grantRole(cc.LISTING_REVIEWER_ROLE(), reviewer);
        xf.grantRole(xf.LISTING_REVIEWER_ROLE(), reviewer);
        xf.grantRole(xf.ASSET_MANAGER_ROLE(), manager);
        vm.stopPrank();

        vm.startPrank(kycReviewer);
        ids.setIdentity(warehouse, IIdentityRegistry.Tier.Business, uint64(block.timestamp + YEAR), bytes32("wh"));
        ids.setIdentity(spv, IIdentityRegistry.Tier.Business, uint64(block.timestamp + YEAR), bytes32("spv"));
        vm.stopPrank();

        address[4] memory funded = [investor, investor2, lender, offtaker];
        for (uint256 i = 0; i < funded.length; i++) usdc.mint(funded[i], _usdc(1_000_000));
    }

    function test_FullPlatformJourney() public {
        // ---------------- Warehouse receipt: issue → pledge → release → sell → redeem
        vm.prank(registrar);
        uint256 whId = whs.registerWarehouse(warehouse, keccak256("LIC-OYO-001"), "ipfs://wh");

        WarehouseReceipt.ReceiptTerms memory t = WarehouseReceipt.ReceiptTerms({
            warehouseId: whId,
            receiptNumberHash: keccak256("ISY-2026-0042"),
            commodity: bytes32("MAIZE"),
            grade: bytes32("GRADE_1"),
            quantity: 60_000,
            depositDate: uint64(block.timestamp - 1 days),
            expiryDate: uint64(block.timestamp + 180 days),
            documentHash: keccak256("scan"),
            metadataURI: "https://api/metadata/wr/1"
        });
        vm.prank(warehouse);
        uint256 sid = wr.submitReceipt(t, trader);
        vm.prank(reviewer);
        uint256 receipt = wr.approveSubmission(sid);

        vm.prank(trader);
        wr.grantLien(receipt, lender, uint64(block.timestamp + 60 days), keccak256("facility-1"));
        vm.prank(lender);
        wr.releaseLien(receipt);

        vm.startPrank(trader);
        wr.approve(address(mkt), receipt);
        uint256 l1 = mkt.list(address(wr), receipt, 1, _usdc(18_000));
        vm.stopPrank();
        vm.startPrank(investor);
        usdc.approve(address(mkt), type(uint256).max);
        mkt.buy(l1, 1, _usdc(18_000));
        vm.stopPrank();
        assertEq(wr.ownerOf(receipt), investor);
        assertEq(usdc.balanceOf(trader), _usdc(17_820));

        vm.prank(investor);
        wr.requestRedemption(receipt, 0, keccak256("collect"));
        vm.prank(warehouse);
        wr.confirmWarehouseRelease(receipt);
        vm.prank(reviewer);
        wr.approveStatusRequest(receipt);
        assertEq(wr.balanceOf(investor), 0);

        // ---------------- LPO: issue → discount sale → buyer settles to new holder
        LPOToken.LPOTerms memory lt = LPOToken.LPOTerms({
            lpoNumberHash: keccak256("PO-7781"),
            buyerRefHash: keccak256("RC-554433"),
            description: bytes32("SOY_30T"),
            faceValue: _usdc(30_000),
            issueDate: uint64(block.timestamp),
            dueDate: uint64(block.timestamp + 45 days),
            documentHash: keccak256("po"),
            metadataURI: "https://api/metadata/lpo/1"
        });
        vm.prank(sme);
        uint256 lsid = lpo.submitLPO(lt);
        vm.prank(reviewer);
        uint256 order = lpo.approveSubmission(lsid);
        vm.startPrank(sme);
        lpo.approve(address(mkt), order);
        uint256 l2 = mkt.list(address(lpo), order, 1, _usdc(28_800));
        vm.stopPrank();
        vm.startPrank(investor2);
        usdc.approve(address(mkt), type(uint256).max);
        mkt.buy(l2, 1, _usdc(28_800));
        vm.stopPrank();
        vm.startPrank(offtaker);
        usdc.approve(address(lpo), type(uint256).max);
        lpo.settle(order);
        vm.stopPrank();
        assertEq(usdc.balanceOf(investor2), _usdc(1_000_000) - _usdc(28_800) + _usdc(30_000));

        // ---------------- Carbon: issue → partial sale → buyer retires
        CarbonCredits.BatchTerms memory ct = CarbonCredits.BatchTerms({
            registry: bytes32("VERRA"),
            registryBatchIdHash: keccak256("VCS-1234-2025-001-500"),
            projectIdHash: keccak256("VCS-1234"),
            methodology: bytes32("VM0042"),
            vintage: 2025,
            quantity: 500,
            documentHash: keccak256("statement"),
            metadataURI: "https://api/metadata/carbon/1"
        });
        vm.prank(originator);
        uint256 csid = cc.submitBatch(ct);
        vm.prank(reviewer);
        uint256 batch = cc.approveSubmission(csid);
        vm.startPrank(originator);
        cc.setApprovalForAll(address(mkt), true);
        uint256 l3 = mkt.list(address(cc), batch, 200, _usdc(15));
        vm.stopPrank();
        vm.prank(investor);
        mkt.buy(l3, 50, _usdc(750));
        vm.prank(investor);
        cc.retire(batch, 50, keccak256("Investor 2026 travel"), bytes32("offset"));
        assertEq(cc.retiredOf(batch), 50);
        assertEq(cc.totalSupply(batch) + cc.retiredOf(batch), 500);

        // ---------------- XOwn: propose → approve → fill → yield → dissolve → redeem
        XOwnFactory.OfferingTerms memory ot = XOwnFactory.OfferingTerms({
            name: "XOwn Tractor Iseyin 01",
            symbol: "XO-ISY01",
            operator: spv,
            maxShares: 200,
            pricePerShare: _usdc(100),
            subscriptionDeadline: uint64(block.timestamp + 21 days),
            equipment: XOwnEquipment.Equipment({
                assetType: bytes32("TRACTOR"),
                serialHash: keccak256("MF-375-000123"),
                documentHash: keccak256("invoice"),
                metadataURI: "https://api/metadata/xown/1"
            })
        });
        vm.prank(manager);
        uint256 pid = xf.propose(ot);
        vm.prank(reviewer);
        XOwnVault v = XOwnVault(xf.approve(pid));

        vm.startPrank(investor);
        usdc.approve(address(v), type(uint256).max);
        v.subscribe(150);
        vm.stopPrank();
        vm.startPrank(investor2);
        usdc.approve(address(v), type(uint256).max);
        v.subscribe(50);
        vm.stopPrank();
        assertEq(usdc.balanceOf(spv), _usdc(20_000));

        usdc.mint(spv, _usdc(3_000));
        vm.startPrank(spv);
        usdc.approve(address(v), type(uint256).max);
        v.depositYield(_usdc(2_000));
        v.depositProceeds(_usdc(15_000)); // spv had 20k raise + 3k minted − 2k yield
        vm.stopPrank();
        vm.prank(reviewer);
        v.dissolve();

        uint256 before = usdc.balanceOf(investor2);
        vm.prank(investor2);
        v.redeem();
        // 50/200 of 15,000 proceeds + 50/200 of 2,000 yield
        assertEq(usdc.balanceOf(investor2) - before, _usdc(3_750) + _usdc(500));

        // ---------------- Nothing is ever left sitting in the marketplace
        assertEq(usdc.balanceOf(address(mkt)), 0);
    }
}
