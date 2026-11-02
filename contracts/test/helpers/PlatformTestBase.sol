// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {IdentityRegistry} from "../../src/IdentityRegistry.sol";
import {IIdentityRegistry} from "../../src/interfaces/IIdentityRegistry.sol";
import {MockUSDC} from "../../src/mocks/MockUSDC.sol";

/// Shared setup: identity registry, USDC, and a cast of verified participants.
abstract contract PlatformTestBase is Test {
    IdentityRegistry ids;
    MockUSDC usdc;

    address superAdmin = makeAddr("superAdmin");
    address kycReviewer = makeAddr("kycReviewer");
    address reviewer = makeAddr("reviewer");
    address pauser = makeAddr("pauser");

    address sme = makeAddr("sme");               // Business
    address originator = makeAddr("originator"); // Business (carbon)
    address trader = makeAddr("trader");         // Individual
    address investor = makeAddr("investor");     // Individual
    address investor2 = makeAddr("investor2");   // Individual
    address lender = makeAddr("lender");         // Institutional
    address stranger = makeAddr("stranger");     // not verified

    uint64 constant YEAR = 365 days;

    function _baseSetUp() internal {
        vm.warp(1_780_000_000);
        ids = new IdentityRegistry(superAdmin, 2 days);
        usdc = new MockUSDC();

        bytes32 kycRole = ids.KYC_REVIEWER_ROLE();
        vm.prank(superAdmin);
        ids.grantRole(kycRole, kycReviewer);

        uint64 until = uint64(block.timestamp + 2 * YEAR);
        vm.startPrank(kycReviewer);
        ids.setIdentity(sme, IIdentityRegistry.Tier.Business, until, bytes32("sme"));
        ids.setIdentity(originator, IIdentityRegistry.Tier.Business, until, bytes32("orig"));
        ids.setIdentity(trader, IIdentityRegistry.Tier.Individual, until, bytes32("trader"));
        ids.setIdentity(investor, IIdentityRegistry.Tier.Individual, until, bytes32("inv"));
        ids.setIdentity(investor2, IIdentityRegistry.Tier.Individual, until, bytes32("inv2"));
        ids.setIdentity(lender, IIdentityRegistry.Tier.Institutional, until, bytes32("lender"));
        vm.stopPrank();
    }

    function _registerPlatform(address c) internal {
        vm.prank(superAdmin);
        ids.registerPlatformContract(c, keccak256(abi.encode(c)));
    }

    function _usdc(uint256 whole) internal pure returns (uint256) {
        return whole * 1e6;
    }
}
