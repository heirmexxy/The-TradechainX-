// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControlDefaultAdminRules} from
    "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";
import {IIdentityRegistry} from "./interfaces/IIdentityRegistry.sol";

/// @title WarehouseRegistry
/// @notice List of facilities the Warehouse Registrar has confirmed as legitimate, licensed
///         warehouses (PRD §4.4). Only an active warehouse's operator can submit receipts.
contract WarehouseRegistry is AccessControlDefaultAdminRules {
    bytes32 public constant WAREHOUSE_REGISTRAR_ROLE = keccak256("WAREHOUSE_REGISTRAR_ROLE");

    struct Warehouse {
        address operator;      // KYB-verified business wallet allowed to submit receipts
        bytes32 licenceRef;    // hash of licence / certification reference
        bool active;
        string metadataURI;    // off-chain facility profile (location, capacity, photos)
    }

    IIdentityRegistry public immutable identityRegistry;

    uint256 public warehouseCount;
    mapping(uint256 => Warehouse) private _warehouses;
    mapping(bytes32 => bool) public licenceRegistered; // a licence cannot back two warehouse entries

    event WarehouseRegistered(uint256 indexed warehouseId, address indexed operator, bytes32 licenceRef, string metadataURI);
    event WarehouseStatusChanged(uint256 indexed warehouseId, bool active, bytes32 reasonRef);
    event WarehouseOperatorChanged(uint256 indexed warehouseId, address indexed previousOperator, address indexed newOperator);
    event WarehouseMetadataUpdated(uint256 indexed warehouseId, string metadataURI);

    error ZeroAddress();
    error OperatorNotVerifiedEntity();
    error LicenceAlreadyRegistered();
    error UnknownWarehouse();
    error NoChange();

    constructor(address superAdmin, uint48 adminTransferDelay, IIdentityRegistry identityRegistry_)
        AccessControlDefaultAdminRules(adminTransferDelay, superAdmin)
    {
        if (address(identityRegistry_) == address(0)) revert ZeroAddress();
        identityRegistry = identityRegistry_;
    }

    function registerWarehouse(address operator, bytes32 licenceRef, string calldata metadataURI)
        external
        onlyRole(WAREHOUSE_REGISTRAR_ROLE)
        returns (uint256 warehouseId)
    {
        if (operator == address(0)) revert ZeroAddress();
        if (!identityRegistry.isVerifiedEntity(operator)) revert OperatorNotVerifiedEntity();
        if (licenceRegistered[licenceRef]) revert LicenceAlreadyRegistered();

        licenceRegistered[licenceRef] = true;
        warehouseId = ++warehouseCount;
        _warehouses[warehouseId] = Warehouse(operator, licenceRef, true, metadataURI);
        emit WarehouseRegistered(warehouseId, operator, licenceRef, metadataURI);
    }

    /// @notice Suspend (e.g. licence lapsed, inspection failed) or reinstate a warehouse.
    ///         Suspension blocks new receipts and approvals; existing receipts stay valid.
    function setWarehouseActive(uint256 warehouseId, bool active, bytes32 reasonRef)
        external
        onlyRole(WAREHOUSE_REGISTRAR_ROLE)
    {
        Warehouse storage w = _get(warehouseId);
        if (w.active == active) revert NoChange();
        w.active = active;
        emit WarehouseStatusChanged(warehouseId, active, reasonRef);
    }

    function setOperator(uint256 warehouseId, address newOperator) external onlyRole(WAREHOUSE_REGISTRAR_ROLE) {
        if (newOperator == address(0)) revert ZeroAddress();
        if (!identityRegistry.isVerifiedEntity(newOperator)) revert OperatorNotVerifiedEntity();
        Warehouse storage w = _get(warehouseId);
        emit WarehouseOperatorChanged(warehouseId, w.operator, newOperator);
        w.operator = newOperator;
    }

    function setMetadataURI(uint256 warehouseId, string calldata metadataURI) external onlyRole(WAREHOUSE_REGISTRAR_ROLE) {
        _get(warehouseId).metadataURI = metadataURI;
        emit WarehouseMetadataUpdated(warehouseId, metadataURI);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function getWarehouse(uint256 warehouseId) external view returns (Warehouse memory) {
        return _get(warehouseId);
    }

    function operatorOf(uint256 warehouseId) external view returns (address) {
        return _get(warehouseId).operator;
    }

    function isActive(uint256 warehouseId) public view returns (bool) {
        return _warehouses[warehouseId].active;
    }

    /// @notice True if `account` is the current operator of an active warehouse whose
    ///         operator still passes KYB (lapsed/frozen KYB blocks the warehouse too).
    function isActiveOperator(uint256 warehouseId, address account) external view returns (bool) {
        Warehouse storage w = _warehouses[warehouseId];
        return w.active && w.operator == account && identityRegistry.isVerifiedEntity(account);
    }

    function _get(uint256 warehouseId) private view returns (Warehouse storage w) {
        w = _warehouses[warehouseId];
        if (w.operator == address(0)) revert UnknownWarehouse();
    }
}
