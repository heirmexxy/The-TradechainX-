// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {AccessControlDefaultAdminRules} from
    "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IIdentityRegistry} from "../interfaces/IIdentityRegistry.sol";
import {ITradableAsset} from "../interfaces/ITradableAsset.sol";

/// @title RWA721Base
/// @notice Shared rules for whole (non-fractional) real-world-asset tokens: warehouse receipts and LPOs.
///
///         - Roles (PRD §4.4): Super Admin = DEFAULT_ADMIN_ROLE (multisig, 2-step transfer with delay),
///           LISTING_REVIEWER_ROLE, PAUSER_ROLE.
///         - Only KYC-verified wallets can hold or receive tokens.
///         - One lien at a time; a liened token cannot move except by lien enforcement (anti double-pledging).
///         - Tokens with a pending status change, or past expiry, cannot move — except out of a TradeChainX
///           platform contract (e.g. the marketplace returning an unsold asset). Platform contracts check
///           `isTradable` before selling, so the exemption can't be used to sell a locked asset.
///         - Pause stops transfers and all state-changing user actions. Only the Super Admin can unpause.
///
///         Child contracts define how tokens are created (always through a reviewer approval) and which
///         status changes exist. They report expiry and pending-request state through two hooks.
abstract contract RWA721Base is ERC721, AccessControlDefaultAdminRules, Pausable, ReentrancyGuard, ITradableAsset {
    bytes32 public constant LISTING_REVIEWER_ROLE = keccak256("LISTING_REVIEWER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    struct Lien {
        address lienholder;   // financier (KYB-verified entity)
        uint64 maturity;      // lienholder may enforce after this if not released
        bytes32 agreementRef; // hash of the off-chain financing agreement
    }

    IIdentityRegistry public immutable identityRegistry;

    uint256 public nextTokenId; // last minted id; ids start at 1

    mapping(uint256 => Lien) private _liens;
    bool private _enforcingLien;

    event LienGranted(uint256 indexed tokenId, address indexed lienholder, uint64 maturity, bytes32 agreementRef);
    event LienReleased(uint256 indexed tokenId, address indexed lienholder, address releasedBy);
    event LienEnforced(uint256 indexed tokenId, address indexed lienholder, address indexed previousHolder);

    error ZeroAddress();
    error HolderNotVerified();
    error ReviewerConflict();
    error NotHolder();
    error NotLienholder();
    error AlreadyLiened();
    error NotLiened();
    error LienNotMatured();
    error LienholderNotVerifiedEntity();
    error InvalidMaturity();
    error InvalidRequest();
    error RequestPending();
    error ReceiptExpired();
    error TransferBlocked(uint256 tokenId);
    error UnknownToken();

    constructor(
        string memory name_,
        string memory symbol_,
        address superAdmin,
        uint48 adminTransferDelay,
        IIdentityRegistry identityRegistry_
    ) ERC721(name_, symbol_) AccessControlDefaultAdminRules(adminTransferDelay, superAdmin) {
        if (address(identityRegistry_) == address(0)) revert ZeroAddress();
        identityRegistry = identityRegistry_;
    }

    // ---------------------------------------------------------------------
    // Hooks for child contracts
    // ---------------------------------------------------------------------

    /// @dev Timestamp after which the token can no longer move or be pledged.
    function _expiryOf(uint256 tokenId) internal view virtual returns (uint64);

    /// @dev True while a status change (redemption, settlement, void, …) awaits review.
    function _hasPendingRequest(uint256 tokenId) internal view virtual returns (bool);

    // ---------------------------------------------------------------------
    // Liens (anti double-pledging)
    // ---------------------------------------------------------------------

    /// @notice Holder pledges the token to a verified financier. While liened, the token cannot be
    ///         transferred, pledged again, or redeemed/settled.
    function grantLien(uint256 tokenId, address lienholder, uint64 maturity, bytes32 agreementRef)
        external
        whenNotPaused
    {
        if (ownerOf(tokenId) != msg.sender) revert NotHolder();
        if (_liens[tokenId].lienholder != address(0)) revert AlreadyLiened();
        if (_hasPendingRequest(tokenId)) revert RequestPending();
        if (lienholder == address(0)) revert ZeroAddress();
        if (lienholder == msg.sender) revert InvalidRequest();
        if (!identityRegistry.isVerifiedEntity(lienholder)) revert LienholderNotVerifiedEntity();
        uint64 expiry = _expiryOf(tokenId);
        if (expiry <= block.timestamp) revert ReceiptExpired();
        if (maturity <= block.timestamp || maturity > expiry) revert InvalidMaturity();

        _liens[tokenId] = Lien(lienholder, maturity, agreementRef);
        emit LienGranted(tokenId, lienholder, maturity, agreementRef);
    }

    /// @notice Lienholder releases the lien (loan repaid / facility closed).
    function releaseLien(uint256 tokenId) external {
        Lien memory l = _liens[tokenId];
        if (l.lienholder == address(0)) revert NotLiened();
        if (l.lienholder != msg.sender) revert NotLienholder();
        delete _liens[tokenId];
        emit LienReleased(tokenId, l.lienholder, msg.sender);
    }

    /// @notice Super Admin dispute resolution: release a lien the lienholder refuses to release.
    function adminReleaseLien(uint256 tokenId) external onlyRole(DEFAULT_ADMIN_ROLE) {
        Lien memory l = _liens[tokenId];
        if (l.lienholder == address(0)) revert NotLiened();
        delete _liens[tokenId];
        emit LienReleased(tokenId, l.lienholder, msg.sender);
    }

    /// @notice After maturity, an unreleased lien can be enforced: the token moves to the lienholder.
    function enforceLien(uint256 tokenId) external whenNotPaused nonReentrant {
        Lien memory l = _liens[tokenId];
        if (l.lienholder == address(0)) revert NotLiened();
        if (l.lienholder != msg.sender) revert NotLienholder();
        if (block.timestamp < l.maturity) revert LienNotMatured();
        if (!identityRegistry.isVerifiedEntity(msg.sender)) revert LienholderNotVerifiedEntity();

        address previousHolder = ownerOf(tokenId);
        delete _liens[tokenId];
        _enforcingLien = true;
        _transfer(previousHolder, msg.sender, tokenId);
        _enforcingLien = false;
        emit LienEnforced(tokenId, msg.sender, previousHolder);
    }

    function _hasLien(uint256 tokenId) internal view returns (bool) {
        return _liens[tokenId].lienholder != address(0);
    }

    function _clearLien(uint256 tokenId) internal {
        delete _liens[tokenId];
    }

    // ---------------------------------------------------------------------
    // Emergency controls
    // ---------------------------------------------------------------------

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    /// @notice Unpausing needs the Super Admin, so a compromised pauser key can't flip it back.
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    // ---------------------------------------------------------------------
    // Transfer rules
    // ---------------------------------------------------------------------

    function _update(address to, uint256 tokenId, address auth) internal virtual override returns (address) {
        address from = _ownerOf(tokenId);
        if (from != address(0) && to != address(0)) {
            if (paused()) revert EnforcedPause();
            if (!_enforcingLien) {
                if (_liens[tokenId].lienholder != address(0)) revert TransferBlocked(tokenId);
                bool fromPlatform = identityRegistry.tierOf(from) == IIdentityRegistry.Tier.Platform
                    && identityRegistry.isVerified(from);
                if (!fromPlatform) {
                    if (_hasPendingRequest(tokenId)) revert TransferBlocked(tokenId);
                    if (_expiryOf(tokenId) <= block.timestamp) revert TransferBlocked(tokenId);
                    if (!identityRegistry.isVerified(from)) revert HolderNotVerified();
                }
            }
            if (!identityRegistry.isVerified(to)) revert HolderNotVerified();
        }
        return super._update(to, tokenId, auth);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function getLien(uint256 tokenId) external view returns (Lien memory) {
        return _liens[tokenId];
    }

    /// @inheritdoc ITradableAsset
    function isTradable(uint256 tokenId) public view returns (bool) {
        address owner = _ownerOf(tokenId);
        if (owner == address(0) || paused()) return false;
        return _liens[tokenId].lienholder == address(0) && !_hasPendingRequest(tokenId)
            && _expiryOf(tokenId) > block.timestamp && identityRegistry.isVerified(owner);
    }

    /// @notice Kept for existing callers; same as `isTradable`.
    function isTransferable(uint256 tokenId) external view returns (bool) {
        return isTradable(tokenId);
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        virtual
        override(ERC721, AccessControlDefaultAdminRules)
        returns (bool)
    {
        return interfaceId == type(ITradableAsset).interfaceId || super.supportsInterface(interfaceId);
    }

    function _requireMinted(uint256 tokenId) internal view {
        if (_ownerOf(tokenId) == address(0)) revert UnknownToken();
    }
}
