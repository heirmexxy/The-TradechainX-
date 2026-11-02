// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC1155} from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import {ERC1155Holder} from "@openzeppelin/contracts/token/ERC1155/utils/ERC1155Holder.sol";
import {AccessControlDefaultAdminRules} from
    "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IIdentityRegistry} from "./interfaces/IIdentityRegistry.sol";
import {ITradableAsset} from "./interfaces/ITradableAsset.sol";

/// @title Marketplace
/// @notice Fixed-price secondary market for TradeChainX assets, settled in USDC.
///
///         - Listing moves the asset into the marketplace, so it can't be sold twice, pledged, or
///           moved while listed. Cancelling returns it to the seller.
///         - A purchase is atomic delivery-versus-payment: USDC goes from buyer to seller (minus the
///           platform fee) and the asset goes to the buyer in the same transaction. The contract never
///           holds USDC, so there is no escrow balance for anyone — including admins — to withdraw.
///         - The fee is fixed per listing at the rate in force when it was listed, capped at 5%.
///         - The asset contract must say the asset is tradable (not expired, suspended, under a pending
///           status change, or paused) at the moment of sale.
contract Marketplace is AccessControlDefaultAdminRules, Pausable, ReentrancyGuard, ERC1155Holder {
    using SafeERC20 for IERC20;

    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    uint16 public constant MAX_FEE_BPS = 500;

    enum AssetKind { None, ERC721, ERC1155 }

    struct Listing {
        address seller;
        address asset;
        uint256 tokenId;
        uint256 remaining;    // units still for sale (always 1 for ERC-721)
        uint256 pricePerUnit; // USDC base units
        uint16 feeBps;        // snapshot at listing time
        bool active;
    }

    IERC20 public immutable settlementToken;
    IIdentityRegistry public immutable identityRegistry;

    uint16 public feeBps;
    address public feeCollector;
    uint256 public listingCount;

    mapping(address => AssetKind) public assetKind;
    mapping(uint256 => Listing) private _listings;

    event AssetAllowed(address indexed asset, AssetKind kind);
    event FeeUpdated(uint16 feeBps, address feeCollector);
    event Listed(uint256 indexed listingId, address indexed seller, address indexed asset, uint256 tokenId, uint256 amount, uint256 pricePerUnit, uint16 feeBps);
    event PriceUpdated(uint256 indexed listingId, uint256 pricePerUnit);
    event ListingCancelled(uint256 indexed listingId, address indexed by, uint256 returned);
    event Sold(uint256 indexed listingId, address indexed buyer, address indexed seller, uint256 amount, uint256 totalPrice, uint256 fee);

    error ZeroAddress();
    error AssetNotAllowed();
    error NotVerified();
    error NotTradable();
    error InvalidAmount();
    error InvalidPrice();
    error NotSeller();
    error ListingInactive();
    error PriceAboveLimit();
    error FeeTooHigh();
    error SelfPurchase();

    constructor(
        address superAdmin,
        uint48 adminTransferDelay,
        IERC20 settlementToken_,
        IIdentityRegistry identityRegistry_,
        address feeCollector_,
        uint16 feeBps_
    ) AccessControlDefaultAdminRules(adminTransferDelay, superAdmin) {
        if (address(settlementToken_) == address(0) || address(identityRegistry_) == address(0) || feeCollector_ == address(0)) {
            revert ZeroAddress();
        }
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh();
        settlementToken = settlementToken_;
        identityRegistry = identityRegistry_;
        feeCollector = feeCollector_;
        feeBps = feeBps_;
    }

    // =====================================================================
    // Admin (Super Admin multisig)
    // =====================================================================

    function setAssetKind(address asset, AssetKind kind) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (asset == address(0)) revert ZeroAddress();
        assetKind[asset] = kind;
        emit AssetAllowed(asset, kind);
    }

    function setFee(uint16 feeBps_, address feeCollector_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh();
        if (feeCollector_ == address(0)) revert ZeroAddress();
        feeBps = feeBps_;
        feeCollector = feeCollector_;
        emit FeeUpdated(feeBps_, feeCollector_);
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    // =====================================================================
    // Sellers
    // =====================================================================

    function list(address asset, uint256 tokenId, uint256 amount, uint256 pricePerUnit)
        external
        whenNotPaused
        nonReentrant
        returns (uint256 listingId)
    {
        AssetKind kind = assetKind[asset];
        if (kind == AssetKind.None) revert AssetNotAllowed();
        if (!identityRegistry.isVerified(msg.sender)) revert NotVerified();
        if (pricePerUnit == 0) revert InvalidPrice();
        if (amount == 0 || (kind == AssetKind.ERC721 && amount != 1)) revert InvalidAmount();
        if (!ITradableAsset(asset).isTradable(tokenId)) revert NotTradable();

        listingId = ++listingCount;
        _listings[listingId] = Listing(msg.sender, asset, tokenId, amount, pricePerUnit, feeBps, true);
        emit Listed(listingId, msg.sender, asset, tokenId, amount, pricePerUnit, feeBps);

        if (kind == AssetKind.ERC721) {
            IERC721(asset).transferFrom(msg.sender, address(this), tokenId);
        } else {
            IERC1155(asset).safeTransferFrom(msg.sender, address(this), tokenId, amount, "");
        }
    }

    function updatePrice(uint256 listingId, uint256 pricePerUnit) external whenNotPaused {
        Listing storage l = _listings[listingId];
        if (!l.active) revert ListingInactive();
        if (l.seller != msg.sender) revert NotSeller();
        if (pricePerUnit == 0) revert InvalidPrice();
        l.pricePerUnit = pricePerUnit;
        emit PriceUpdated(listingId, pricePerUnit);
    }

    /// @notice Seller (or the Super Admin, for compliance) closes a listing. The asset always goes back
    ///         to the seller. Works while the marketplace is paused so sellers can always exit. If the
    ///         asset was voided/burned while listed, the listing is simply closed.
    function cancel(uint256 listingId) external nonReentrant {
        Listing storage l = _listings[listingId];
        if (!l.active) revert ListingInactive();
        if (l.seller != msg.sender && !hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) revert NotSeller();

        uint256 amount = l.remaining;
        l.active = false;
        l.remaining = 0;

        uint256 returned;
        if (assetKind[l.asset] == AssetKind.ERC1155) {
            uint256 held = IERC1155(l.asset).balanceOf(address(this), l.tokenId);
            returned = amount < held ? amount : held;
            if (returned > 0) IERC1155(l.asset).safeTransferFrom(address(this), l.seller, l.tokenId, returned, "");
        } else if (_holds721(l.asset, l.tokenId)) {
            returned = 1;
            IERC721(l.asset).transferFrom(address(this), l.seller, l.tokenId);
        }
        emit ListingCancelled(listingId, msg.sender, returned);
    }

    // =====================================================================
    // Buyers
    // =====================================================================

    /// @param maxTotalPrice Protects the buyer if the seller changes the price before the purchase lands.
    function buy(uint256 listingId, uint256 amount, uint256 maxTotalPrice) external whenNotPaused nonReentrant {
        Listing storage l = _listings[listingId];
        if (!l.active) revert ListingInactive();
        if (msg.sender == l.seller) revert SelfPurchase();
        if (amount == 0 || amount > l.remaining) revert InvalidAmount();
        if (!identityRegistry.isVerified(msg.sender)) revert NotVerified();
        if (!ITradableAsset(l.asset).isTradable(l.tokenId)) revert NotTradable();

        uint256 total = l.pricePerUnit * amount;
        if (total > maxTotalPrice) revert PriceAboveLimit();
        uint256 fee = (total * l.feeBps) / 10_000;

        l.remaining -= amount;
        if (l.remaining == 0) l.active = false;
        address seller = l.seller;
        emit Sold(listingId, msg.sender, seller, amount, total, fee);

        settlementToken.safeTransferFrom(msg.sender, seller, total - fee);
        if (fee > 0) settlementToken.safeTransferFrom(msg.sender, feeCollector, fee);

        if (assetKind[l.asset] == AssetKind.ERC721) {
            IERC721(l.asset).transferFrom(address(this), msg.sender, l.tokenId);
        } else {
            IERC1155(l.asset).safeTransferFrom(address(this), msg.sender, l.tokenId, amount, "");
        }
    }

    // =====================================================================
    // Views
    // =====================================================================

    function getListing(uint256 listingId) external view returns (Listing memory) {
        return _listings[listingId];
    }

    function quote(uint256 listingId, uint256 amount) external view returns (uint256 total, uint256 fee) {
        Listing storage l = _listings[listingId];
        total = l.pricePerUnit * amount;
        fee = (total * l.feeBps) / 10_000;
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(AccessControlDefaultAdminRules, ERC1155Holder)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }

    function _holds721(address asset, uint256 tokenId) private view returns (bool) {
        try IERC721(asset).ownerOf(tokenId) returns (address owner) {
            return owner == address(this);
        } catch {
            return false;
        }
    }
}
