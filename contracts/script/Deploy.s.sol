// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IdentityRegistry} from "../src/IdentityRegistry.sol";
import {WarehouseRegistry} from "../src/WarehouseRegistry.sol";
import {WarehouseReceipt} from "../src/WarehouseReceipt.sol";
import {LPOToken} from "../src/LPOToken.sol";
import {CarbonCredits} from "../src/CarbonCredits.sol";
import {Marketplace} from "../src/Marketplace.sol";
import {XOwnFactory} from "../src/xown/XOwnFactory.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";

/// @notice Deploys the full TradeChainX contract suite.
///
/// Environment (all optional except where noted):
///   USDC               Settlement token. Leave unset on local/testnet to deploy MockUSDC.
///   SUPER_ADMIN        Multisig that should end up as Super Admin. If it differs from the deployer,
///                      a two-step admin transfer is started; the multisig accepts after ADMIN_DELAY.
///   ADMIN_DELAY        Seconds before a new Super Admin can accept (default 2 days; 0 on local).
///   FEE_COLLECTOR      Where marketplace fees go (default: SUPER_ADMIN).
///   FEE_BPS            Marketplace fee in basis points (default 100 = 1%, max 500).
///   KYC_REVIEWER, LISTING_REVIEWER, WAREHOUSE_REGISTRAR, PAUSER, ASSET_MANAGER
///                      Addresses to receive each role (skipped if unset).
///
/// Writes deployments/<chainId>.json with every address and the deployment block.
contract Deploy is Script {
    struct Deployed {
        address usdc;
        address identityRegistry;
        address warehouseRegistry;
        address warehouseReceipt;
        address lpoToken;
        address carbonCredits;
        address marketplace;
        address xownFactory;
        address xownEquipment;
    }

    function run() external returns (Deployed memory d) {
        address deployer = msg.sender;
        address superAdmin = vm.envOr("SUPER_ADMIN", deployer);
        uint256 startBlock = block.number;

        vm.startBroadcast();
        d = _deploy(deployer, superAdmin);
        _wire(d);
        if (superAdmin != deployer) _handOver(d, superAdmin);
        vm.stopBroadcast();

        _write(d, startBlock);
    }

    function _deploy(address deployer, address superAdmin) private returns (Deployed memory d) {
        uint48 delay = uint48(vm.envOr("ADMIN_DELAY", uint256(2 days)));

        d.usdc = vm.envOr("USDC", address(0));
        if (d.usdc == address(0)) {
            require(
                block.chainid != 137 && block.chainid != 1 && block.chainid != 8453 && block.chainid != 42161,
                "Set USDC on mainnet"
            );
            d.usdc = address(new MockUSDC());
        }

        // Deployer is the initial admin so it can wire roles; control moves to SUPER_ADMIN at the end.
        IdentityRegistry ids = new IdentityRegistry(deployer, delay);
        d.identityRegistry = address(ids);
        WarehouseRegistry whs = new WarehouseRegistry(deployer, delay, ids);
        d.warehouseRegistry = address(whs);
        d.warehouseReceipt = address(new WarehouseReceipt(deployer, delay, ids, whs));
        d.lpoToken = address(new LPOToken(deployer, delay, ids, IERC20(d.usdc)));
        d.carbonCredits = address(new CarbonCredits(deployer, delay, ids));
        d.marketplace = address(
            new Marketplace(
                deployer,
                delay,
                IERC20(d.usdc),
                ids,
                vm.envOr("FEE_COLLECTOR", superAdmin),
                uint16(vm.envOr("FEE_BPS", uint256(100)))
            )
        );
        XOwnFactory xf = new XOwnFactory(deployer, delay, ids, IERC20(d.usdc));
        d.xownFactory = address(xf);
        d.xownEquipment = address(xf.equipment());
    }

    function _wire(Deployed memory d) private {
        IdentityRegistry(d.identityRegistry).registerPlatformContract(d.marketplace, keccak256("marketplace-v1"));
        Marketplace mkt = Marketplace(d.marketplace);
        mkt.setAssetKind(d.warehouseReceipt, Marketplace.AssetKind.ERC721);
        mkt.setAssetKind(d.lpoToken, Marketplace.AssetKind.ERC721);
        mkt.setAssetKind(d.carbonCredits, Marketplace.AssetKind.ERC1155);

        bytes32 reviewerRole = keccak256("LISTING_REVIEWER_ROLE");
        bytes32 pauserRole = keccak256("PAUSER_ROLE");

        _grant(d.identityRegistry, keccak256("KYC_REVIEWER_ROLE"), vm.envOr("KYC_REVIEWER", address(0)));
        _grant(d.warehouseRegistry, keccak256("WAREHOUSE_REGISTRAR_ROLE"), vm.envOr("WAREHOUSE_REGISTRAR", address(0)));
        _grant(d.xownFactory, keccak256("ASSET_MANAGER_ROLE"), vm.envOr("ASSET_MANAGER", address(0)));

        address reviewer = vm.envOr("LISTING_REVIEWER", address(0));
        address pauser = vm.envOr("PAUSER", address(0));
        address[4] memory reviewed = [d.warehouseReceipt, d.lpoToken, d.carbonCredits, d.xownFactory];
        for (uint256 i = 0; i < reviewed.length; i++) {
            _grant(reviewed[i], reviewerRole, reviewer);
            _grant(reviewed[i], pauserRole, pauser);
        }
        _grant(d.marketplace, pauserRole, pauser);
    }

    function _handOver(Deployed memory d, address superAdmin) private {
        address[7] memory all = [
            d.identityRegistry, d.warehouseRegistry, d.warehouseReceipt, d.lpoToken, d.carbonCredits, d.marketplace, d.xownFactory
        ];
        for (uint256 i = 0; i < all.length; i++) {
            AdminRules(all[i]).beginDefaultAdminTransfer(superAdmin);
        }
    }

    function _grant(address target, bytes32 role, address to) private {
        if (to != address(0)) AdminRules(target).grantRole(role, to);
    }

    function _write(Deployed memory d, uint256 startBlock) private {
        string memory k = "deployment";
        vm.serializeUint(k, "chainId", block.chainid);
        vm.serializeUint(k, "startBlock", startBlock);
        vm.serializeAddress(k, "usdc", d.usdc);
        vm.serializeAddress(k, "identityRegistry", d.identityRegistry);
        vm.serializeAddress(k, "warehouseRegistry", d.warehouseRegistry);
        vm.serializeAddress(k, "warehouseReceipt", d.warehouseReceipt);
        vm.serializeAddress(k, "lpoToken", d.lpoToken);
        vm.serializeAddress(k, "carbonCredits", d.carbonCredits);
        vm.serializeAddress(k, "marketplace", d.marketplace);
        vm.serializeAddress(k, "xownEquipment", d.xownEquipment);
        string memory json = vm.serializeAddress(k, "xownFactory", d.xownFactory);
        string memory path = string.concat("./deployments/", vm.toString(block.chainid), ".json");
        vm.writeJson(json, path);
        console2.log("Deployment written to", path);
    }
}

interface AdminRules {
    function grantRole(bytes32 role, address account) external;
    function beginDefaultAdminTransfer(address newAdmin) external;
}
