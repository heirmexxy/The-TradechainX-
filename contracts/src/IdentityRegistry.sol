// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControlDefaultAdminRules} from
    "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";
import {IIdentityRegistry} from "./interfaces/IIdentityRegistry.sol";

/// @title IdentityRegistry
/// @notice Records which wallets have passed KYC/KYB, at what tier, and until when.
/// @dev The KYC provider + manual review happen off-chain (PRD §4.2 step 4). A KYC Reviewer
///      then writes the outcome here. No personal data is stored — only tier, expiry, and an
///      opaque hash the backend can use to link back to its own records.
contract IdentityRegistry is IIdentityRegistry, AccessControlDefaultAdminRules {
    bytes32 public constant KYC_REVIEWER_ROLE = keccak256("KYC_REVIEWER_ROLE");

    struct Identity {
        Tier tier;
        uint64 validUntil; // verification lapses after this timestamp (periodic re-KYC)
        bool frozen;       // compliance hold (AML flag, dispute) without erasing the record
        bytes32 recordRef; // hash of the off-chain case/record id — never PII
    }

    mapping(address => Identity) private _identities;

    event IdentitySet(address indexed account, Tier tier, uint64 validUntil, bytes32 recordRef, address indexed reviewer);
    event IdentityRevoked(address indexed account, address indexed reviewer);
    event IdentityFrozen(address indexed account, bool frozen, address indexed reviewer);

    error ZeroAddress();
    error InvalidTier();
    error InvalidExpiry();
    error UnknownIdentity();

    /// @param superAdmin Multisig that controls role assignment (PRD §4.4 Super Admin).
    /// @param adminTransferDelay Delay before a new super admin can take over (e.g. 2 days).
    constructor(address superAdmin, uint48 adminTransferDelay)
        AccessControlDefaultAdminRules(adminTransferDelay, superAdmin)
    {}

    // ---------------------------------------------------------------------
    // KYC Reviewer actions
    // ---------------------------------------------------------------------

    function setIdentity(address account, Tier tier, uint64 validUntil, bytes32 recordRef)
        external
        onlyRole(KYC_REVIEWER_ROLE)
    {
        if (account == address(0)) revert ZeroAddress();
        if (tier == Tier.None) revert InvalidTier();
        // Platform tier is for protocol contracts and is only grantable by the super admin.
        if (tier == Tier.Platform) revert InvalidTier();
        if (validUntil <= block.timestamp) revert InvalidExpiry();

        Identity storage id = _identities[account];
        id.tier = tier;
        id.validUntil = validUntil;
        id.recordRef = recordRef;
        // `frozen` is deliberately preserved: re-verifying must not silently lift a compliance hold.
        emit IdentitySet(account, tier, validUntil, recordRef, msg.sender);
    }

    function revokeIdentity(address account) external onlyRole(KYC_REVIEWER_ROLE) {
        if (_identities[account].tier == Tier.None) revert UnknownIdentity();
        delete _identities[account];
        emit IdentityRevoked(account, msg.sender);
    }

    function setFrozen(address account, bool frozen) external onlyRole(KYC_REVIEWER_ROLE) {
        if (_identities[account].tier == Tier.None) revert UnknownIdentity();
        _identities[account].frozen = frozen;
        emit IdentityFrozen(account, frozen, msg.sender);
    }

    // ---------------------------------------------------------------------
    // Super Admin actions
    // ---------------------------------------------------------------------

    /// @notice Whitelist a TradeChainX protocol contract (escrow, marketplace) so it can hold receipts.
    function registerPlatformContract(address account, bytes32 recordRef) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (account == address(0)) revert ZeroAddress();
        _identities[account] = Identity({tier: Tier.Platform, validUntil: type(uint64).max, frozen: false, recordRef: recordRef});
        emit IdentitySet(account, Tier.Platform, type(uint64).max, recordRef, msg.sender);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function tierOf(address account) external view returns (Tier) {
        return _identities[account].tier;
    }

    function identityOf(address account) external view returns (Identity memory) {
        return _identities[account];
    }

    function isVerified(address account) public view returns (bool) {
        Identity storage id = _identities[account];
        return id.tier != Tier.None && !id.frozen && block.timestamp <= id.validUntil;
    }

    function isVerifiedEntity(address account) external view returns (bool) {
        Tier t = _identities[account].tier;
        return (t == Tier.Business || t == Tier.Institutional) && isVerified(account);
    }
}
