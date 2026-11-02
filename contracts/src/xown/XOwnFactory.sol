// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AccessControlDefaultAdminRules} from
    "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IIdentityRegistry} from "../interfaces/IIdentityRegistry.sol";
import {XOwnEquipment} from "./XOwnEquipment.sol";
import {XOwnVault} from "./XOwnVault.sol";

/// @title XOwnFactory
/// @notice Creates XOwn offerings through the same two-person gate as every other asset:
///         an Asset Manager proposes, a different Listing Reviewer approves, and only then is the
///         vault deployed and the equipment NFT minted into it.
///         The factory's pause switch pauses every vault.
contract XOwnFactory is AccessControlDefaultAdminRules, Pausable {
    bytes32 public constant ASSET_MANAGER_ROLE = keccak256("ASSET_MANAGER_ROLE");
    bytes32 public constant LISTING_REVIEWER_ROLE = keccak256("LISTING_REVIEWER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    struct OfferingTerms {
        string name;               // e.g. "XOwn Tractor #12 Iseyin"
        string symbol;             // e.g. "XO-TR12"
        address operator;          // SPV that receives funds, runs the machine, pays yield
        uint256 maxShares;
        uint256 pricePerShare;     // USDC base units
        uint64 subscriptionDeadline;
        XOwnEquipment.Equipment equipment;
    }

    enum ProposalStatus { None, Pending, Approved, Rejected }

    struct Proposal {
        OfferingTerms terms;
        address proposer;
        ProposalStatus status;
        address vault;
    }

    IIdentityRegistry public immutable identityRegistry;
    IERC20 public immutable settlementToken;
    XOwnEquipment public immutable equipment;

    uint256 public proposalCount;
    mapping(uint256 => Proposal) private _proposals;
    address[] public vaults;

    event OfferingProposed(uint256 indexed proposalId, address indexed proposer, address indexed operator, uint256 maxShares, uint256 pricePerShare);
    event OfferingRejected(uint256 indexed proposalId, address indexed reviewer, bytes32 reasonRef);
    event OfferingCreated(uint256 indexed proposalId, address indexed vault, uint256 indexed equipmentId, address reviewer);

    error ZeroAddress();
    error InvalidTerms();
    error InvalidState();
    error ReviewerConflict();
    error OperatorNotVerifiedEntity();

    constructor(address superAdmin, uint48 adminTransferDelay, IIdentityRegistry identityRegistry_, IERC20 settlementToken_)
        AccessControlDefaultAdminRules(adminTransferDelay, superAdmin)
    {
        if (address(identityRegistry_) == address(0) || address(settlementToken_) == address(0)) revert ZeroAddress();
        identityRegistry = identityRegistry_;
        settlementToken = settlementToken_;
        equipment = new XOwnEquipment();
    }

    function propose(OfferingTerms calldata t) external onlyRole(ASSET_MANAGER_ROLE) whenNotPaused returns (uint256 id) {
        if (t.operator == address(0)) revert ZeroAddress();
        if (!identityRegistry.isVerifiedEntity(t.operator)) revert OperatorNotVerifiedEntity();
        if (
            t.maxShares == 0 || t.pricePerShare == 0 || t.subscriptionDeadline <= block.timestamp
                || t.equipment.serialHash == bytes32(0) || t.equipment.documentHash == bytes32(0)
                || bytes(t.name).length == 0 || bytes(t.symbol).length == 0
        ) revert InvalidTerms();
        if (equipment.serialUsed(t.equipment.serialHash)) revert InvalidTerms();

        id = ++proposalCount;
        Proposal storage p = _proposals[id];
        p.terms = t;
        p.proposer = msg.sender;
        p.status = ProposalStatus.Pending;
        emit OfferingProposed(id, msg.sender, t.operator, t.maxShares, t.pricePerShare);
    }

    function approve(uint256 id) external onlyRole(LISTING_REVIEWER_ROLE) whenNotPaused returns (address vault) {
        Proposal storage p = _proposals[id];
        if (p.status != ProposalStatus.Pending) revert InvalidState();
        if (msg.sender == p.proposer || msg.sender == p.terms.operator) revert ReviewerConflict();
        if (p.terms.subscriptionDeadline <= block.timestamp) revert InvalidTerms();
        if (!identityRegistry.isVerifiedEntity(p.terms.operator)) revert OperatorNotVerifiedEntity();

        OfferingTerms storage t = p.terms;
        XOwnVault v = new XOwnVault(
            t.name, t.symbol, identityRegistry, settlementToken, equipment, t.operator, t.maxShares, t.pricePerShare, t.subscriptionDeadline
        );
        vault = address(v);
        uint256 equipmentId = equipment.mint(vault, t.equipment);
        v.setEquipmentId(equipmentId);

        p.status = ProposalStatus.Approved;
        p.vault = vault;
        vaults.push(vault);
        emit OfferingCreated(id, vault, equipmentId, msg.sender);
    }

    function reject(uint256 id, bytes32 reasonRef) external onlyRole(LISTING_REVIEWER_ROLE) {
        Proposal storage p = _proposals[id];
        if (p.status != ProposalStatus.Pending) revert InvalidState();
        p.status = ProposalStatus.Rejected;
        emit OfferingRejected(id, msg.sender, reasonRef);
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    function getProposal(uint256 id) external view returns (Proposal memory) {
        return _proposals[id];
    }

    function vaultCount() external view returns (uint256) {
        return vaults.length;
    }
}
