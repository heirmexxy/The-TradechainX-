// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IIdentityRegistry} from "../interfaces/IIdentityRegistry.sol";
import {XOwnEquipment} from "./XOwnEquipment.sol";

interface IXOwnFactory {
    function LISTING_REVIEWER_ROLE() external view returns (bytes32);
    function PAUSER_ROLE() external view returns (bytes32);
    function paused() external view returns (bool);
}

/// @title XOwnVault
/// @notice Fractional ownership of one productive machine. Holds the machine's equipment NFT and issues
///         whole-number shares (ERC-20, 0 decimals) to KYC-verified investors.
///
///         Lifecycle:
///           Fundraising ─(fully subscribed)─► Active ─(proceeds deposited + reviewer approves)─► Dissolved
///                └──────(deadline passes unfilled)──► Failed (investors refunded in full)
///
///         - Raised USDC goes to the operator (the SPV that buys and runs the machine) only once the
///           offering is fully subscribed. Until then it sits here and is refundable.
///         - Yield exists only when the operator deposits real USDC. It's tracked per share, so moving
///           shares between wallets can't create extra claims.
///         - On dissolution, each share redeems for its pro-rata cut of the deposited sale proceeds.
///         - Nobody, including admins, can withdraw funds from the vault except through these paths.
contract XOwnVault is ERC20, ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum State { Fundraising, Active, Failed, Dissolved }

    uint256 private constant ACC = 1e18;

    IXOwnFactory public immutable factory;
    IIdentityRegistry public immutable identityRegistry;
    IERC20 public immutable settlementToken;
    XOwnEquipment public immutable equipment;
    address public immutable operator;
    uint256 public immutable maxShares;
    uint256 public immutable pricePerShare;
    uint64 public immutable subscriptionDeadline;

    uint256 public equipmentId;
    State public state;

    uint256 public accYieldPerShare;  // scaled by 1e18
    uint256 public totalYieldDeposited;
    mapping(address => uint256) public yieldDebt;
    mapping(address => uint256) public pendingYield;

    uint256 public dissolutionProceeds;
    uint256 public sharesAtDissolution;

    event Subscribed(address indexed investor, uint256 shares, uint256 paid);
    event FullySubscribed(uint256 raised, address indexed operator);
    event OfferingFailed();
    event Refunded(address indexed investor, uint256 shares, uint256 amount);
    event YieldDeposited(address indexed from, uint256 amount, uint256 accYieldPerShare);
    event YieldClaimed(address indexed investor, uint256 amount);
    event ProceedsDeposited(address indexed from, uint256 amount);
    event Dissolved(uint256 proceeds, address indexed reviewer);
    event Redeemed(address indexed investor, uint256 shares, uint256 amount);

    error OnlyFactory();
    error WrongState();
    error NotVerified();
    error InvalidAmount();
    error DeadlinePassed();
    error DeadlineNotPassed();
    error NotReviewer();
    error ReviewerConflict();
    error NoShares();
    error NothingToClaim();
    error Paused();
    error NoProceeds();

    constructor(
        string memory name_,
        string memory symbol_,
        IIdentityRegistry identityRegistry_,
        IERC20 settlementToken_,
        XOwnEquipment equipment_,
        address operator_,
        uint256 maxShares_,
        uint256 pricePerShare_,
        uint64 subscriptionDeadline_
    ) ERC20(name_, symbol_) {
        factory = IXOwnFactory(msg.sender);
        identityRegistry = identityRegistry_;
        settlementToken = settlementToken_;
        equipment = equipment_;
        operator = operator_;
        maxShares = maxShares_;
        pricePerShare = pricePerShare_;
        subscriptionDeadline = subscriptionDeadline_;
    }

    /// @dev Called once by the factory right after it mints the equipment NFT into this vault.
    function setEquipmentId(uint256 id) external {
        if (msg.sender != address(factory) || equipmentId != 0) revert OnlyFactory();
        equipmentId = id;
    }

    function decimals() public pure override returns (uint8) {
        return 0;
    }

    modifier whenNotPaused() {
        if (factory.paused()) revert Paused();
        _;
    }

    // =====================================================================
    // Fundraising
    // =====================================================================

    function subscribe(uint256 shares) external whenNotPaused nonReentrant {
        if (state != State.Fundraising) revert WrongState();
        if (block.timestamp > subscriptionDeadline) revert DeadlinePassed();
        if (shares == 0 || totalSupply() + shares > maxShares) revert InvalidAmount();
        if (!identityRegistry.isVerified(msg.sender)) revert NotVerified();

        uint256 cost = shares * pricePerShare;
        settlementToken.safeTransferFrom(msg.sender, address(this), cost);
        _mint(msg.sender, shares);
        emit Subscribed(msg.sender, shares, cost);

        if (totalSupply() == maxShares) {
            state = State.Active;
            uint256 raised = maxShares * pricePerShare;
            emit FullySubscribed(raised, operator);
            settlementToken.safeTransfer(operator, raised);
        }
    }

    /// @notice Anyone can close an offering that missed its deadline, opening refunds.
    function markFailed() external {
        if (state != State.Fundraising) revert WrongState();
        if (block.timestamp <= subscriptionDeadline) revert DeadlineNotPassed();
        state = State.Failed;
        emit OfferingFailed();
    }

    function refund() external nonReentrant {
        if (state != State.Failed) revert WrongState();
        uint256 shares = balanceOf(msg.sender);
        if (shares == 0) revert NoShares();
        uint256 amount = shares * pricePerShare;
        _burn(msg.sender, shares);
        emit Refunded(msg.sender, shares, amount);
        settlementToken.safeTransfer(msg.sender, amount);
    }

    // =====================================================================
    // Yield
    // =====================================================================

    /// @notice Operator (or anyone) pays machine income into the vault for shareholders.
    function depositYield(uint256 amount) external whenNotPaused nonReentrant {
        if (state != State.Active) revert WrongState();
        if (amount == 0) revert InvalidAmount();
        settlementToken.safeTransferFrom(msg.sender, address(this), amount);
        accYieldPerShare += (amount * ACC) / totalSupply();
        totalYieldDeposited += amount;
        emit YieldDeposited(msg.sender, amount, accYieldPerShare);
    }

    function claimableYield(address account) public view returns (uint256) {
        uint256 accrued = (balanceOf(account) * accYieldPerShare) / ACC;
        uint256 debt = yieldDebt[account];
        return pendingYield[account] + (accrued > debt ? accrued - debt : 0);
    }

    function claimYield() external nonReentrant {
        _settle(msg.sender);
        uint256 amount = pendingYield[msg.sender];
        if (amount == 0) revert NothingToClaim();
        pendingYield[msg.sender] = 0;
        emit YieldClaimed(msg.sender, amount);
        settlementToken.safeTransfer(msg.sender, amount);
    }

    // =====================================================================
    // Dissolution
    // =====================================================================

    /// @notice Operator deposits the machine's sale / insurance proceeds ahead of dissolution.
    function depositProceeds(uint256 amount) external nonReentrant {
        if (state != State.Active) revert WrongState();
        if (amount == 0) revert InvalidAmount();
        settlementToken.safeTransferFrom(msg.sender, address(this), amount);
        dissolutionProceeds += amount;
        emit ProceedsDeposited(msg.sender, amount);
    }

    /// @notice A Listing Reviewer (not the operator) confirms the machine was sold and closes the vault.
    function dissolve() external nonReentrant {
        if (!IAccessControl(address(factory)).hasRole(factory.LISTING_REVIEWER_ROLE(), msg.sender)) revert NotReviewer();
        if (msg.sender == operator) revert ReviewerConflict();
        if (state != State.Active) revert WrongState();
        if (dissolutionProceeds == 0) revert NoProceeds();
        state = State.Dissolved;
        sharesAtDissolution = totalSupply();
        emit Dissolved(dissolutionProceeds, msg.sender);
        equipment.burn(equipmentId);
    }

    /// @notice After dissolution: burn all your shares for your cut of the proceeds plus unclaimed yield.
    function redeem() external nonReentrant {
        if (state != State.Dissolved) revert WrongState();
        uint256 shares = balanceOf(msg.sender);
        if (shares == 0) revert NoShares();
        _settle(msg.sender);
        uint256 yield_ = pendingYield[msg.sender];
        pendingYield[msg.sender] = 0;
        uint256 payout = (dissolutionProceeds * shares) / sharesAtDissolution;
        _burn(msg.sender, shares);
        emit Redeemed(msg.sender, shares, payout);
        if (yield_ > 0) emit YieldClaimed(msg.sender, yield_);
        settlementToken.safeTransfer(msg.sender, payout + yield_);
    }

    // =====================================================================
    // Transfer rules & yield bookkeeping
    // =====================================================================

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            if (factory.paused()) revert Paused();
            if (state == State.Dissolved || state == State.Failed) revert WrongState();
            if (!identityRegistry.isVerified(from) || !identityRegistry.isVerified(to)) revert NotVerified();
        }
        if (from != address(0)) _settle(from);
        if (to != address(0)) _settle(to);
        super._update(from, to, value);
        if (from != address(0)) yieldDebt[from] = _debtFor(balanceOf(from));
        if (to != address(0)) yieldDebt[to] = _debtFor(balanceOf(to));
    }

    /// @dev Credits yield accrued since the account's last checkpoint. Checkpoints round UP and
    ///      accruals round DOWN, so the sum owed to all holders can never exceed what was deposited
    ///      (rounding dust stays in the vault instead of being over-promised).
    function _settle(address account) private {
        uint256 accrued = (balanceOf(account) * accYieldPerShare) / ACC;
        uint256 debt = yieldDebt[account];
        if (accrued > debt) pendingYield[account] += accrued - debt;
        yieldDebt[account] = _debtFor(balanceOf(account));
    }

    function _debtFor(uint256 shares) private view returns (uint256) {
        return Math.mulDiv(shares, accYieldPerShare, ACC, Math.Rounding.Ceil);
    }
}
