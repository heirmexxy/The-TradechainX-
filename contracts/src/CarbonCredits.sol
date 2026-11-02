// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import {ERC1155Supply} from "@openzeppelin/contracts/token/ERC1155/extensions/ERC1155Supply.sol";
import {AccessControlDefaultAdminRules} from
    "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IIdentityRegistry} from "./interfaces/IIdentityRegistry.sol";
import {ITradableAsset} from "./interfaces/ITradableAsset.sol";

/// @title CarbonCredits
/// @notice Each token id is one batch of verified carbon credits from an external registry
///         (e.g. Verra, Gold Standard): one unit = one tonne CO2e. Credits within a batch are
///         interchangeable.
///
///           Originator submits batch ─► Listing Reviewer approves ─► credits minted to originator
///           Holder retires credits ─► burned permanently, retirement recorded on-chain
///
///         A registry batch can only be tokenised once. If the registry cancels or disputes a batch,
///         the reviewer suspends it: no transfers or retirements until it's cleared.
contract CarbonCredits is ERC1155, ERC1155Supply, AccessControlDefaultAdminRules, Pausable, ReentrancyGuard, ITradableAsset {
    bytes32 public constant LISTING_REVIEWER_ROLE = keccak256("LISTING_REVIEWER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    struct BatchTerms {
        bytes32 registry;            // e.g. bytes32("VERRA")
        bytes32 registryBatchIdHash; // keccak256 of the registry's serial range / batch id
        bytes32 projectIdHash;       // keccak256 of the registry project id
        bytes32 methodology;         // e.g. bytes32("VM0042")
        uint16 vintage;              // year of the reductions
        uint256 quantity;            // tonnes CO2e
        bytes32 documentHash;        // hash of registry statement + verification report
        string metadataURI;
    }

    enum SubmissionStatus { None, Pending, NeedsInfo, Approved, Rejected, Withdrawn }

    struct Submission {
        BatchTerms terms;
        address submitter;
        SubmissionStatus status;
        uint256 batchId;
    }

    IIdentityRegistry public immutable identityRegistry;

    uint256 public submissionCount;
    uint256 public nextBatchId;
    uint256 public retirementCount;

    mapping(uint256 => Submission) private _submissions;
    mapping(uint256 => BatchTerms) private _batches;
    mapping(uint256 => address) public originatorOf;
    mapping(uint256 => uint256) public retiredOf;    // batchId => tonnes retired
    mapping(uint256 => bool) public suspended;
    mapping(bytes32 => bool) public batchKeyUsed;

    event BatchSubmitted(uint256 indexed submissionId, address indexed submitter, bytes32 registry, bytes32 registryBatchIdHash, uint256 quantity);
    event SubmissionInfoRequested(uint256 indexed submissionId, address indexed reviewer, bytes32 reasonRef);
    event SubmissionResubmitted(uint256 indexed submissionId, bytes32 documentHash);
    event SubmissionRejected(uint256 indexed submissionId, address indexed reviewer, bytes32 reasonRef);
    event SubmissionWithdrawn(uint256 indexed submissionId);
    event BatchIssued(uint256 indexed batchId, uint256 indexed submissionId, address indexed originator, uint256 quantity, address reviewer);
    event CreditsRetired(uint256 indexed retirementId, uint256 indexed batchId, address indexed holder, uint256 amount, bytes32 beneficiaryRef, bytes32 reasonRef);
    event BatchSuspended(uint256 indexed batchId, bool suspended, address indexed reviewer, bytes32 reasonRef);

    error ZeroAddress();
    error NotVerifiedEntity();
    error HolderNotVerified();
    error InvalidTerms();
    error DuplicateBatch();
    error InvalidSubmissionState();
    error NotSubmitter();
    error ReviewerConflict();
    error BatchIsSuspended(uint256 batchId);
    error UnknownBatch();
    error InvalidAmount();
    error NoChange();

    constructor(address superAdmin, uint48 adminTransferDelay, IIdentityRegistry identityRegistry_)
        ERC1155("")
        AccessControlDefaultAdminRules(adminTransferDelay, superAdmin)
    {
        if (address(identityRegistry_) == address(0)) revert ZeroAddress();
        identityRegistry = identityRegistry_;
    }

    // =====================================================================
    // Submission & review
    // =====================================================================

    function submitBatch(BatchTerms calldata terms) external whenNotPaused returns (uint256 submissionId) {
        if (!identityRegistry.isVerifiedEntity(msg.sender)) revert NotVerifiedEntity();
        _validate(terms);
        bytes32 key = batchKey(terms.registry, terms.registryBatchIdHash);
        if (batchKeyUsed[key]) revert DuplicateBatch();
        batchKeyUsed[key] = true;

        submissionId = ++submissionCount;
        Submission storage s = _submissions[submissionId];
        s.terms = terms;
        s.submitter = msg.sender;
        s.status = SubmissionStatus.Pending;
        emit BatchSubmitted(submissionId, msg.sender, terms.registry, terms.registryBatchIdHash, terms.quantity);
    }

    function requestInfo(uint256 submissionId, bytes32 reasonRef) external onlyRole(LISTING_REVIEWER_ROLE) {
        Submission storage s = _submissions[submissionId];
        if (s.status != SubmissionStatus.Pending) revert InvalidSubmissionState();
        s.status = SubmissionStatus.NeedsInfo;
        emit SubmissionInfoRequested(submissionId, msg.sender, reasonRef);
    }

    function resubmit(uint256 submissionId, BatchTerms calldata terms) external whenNotPaused {
        Submission storage s = _submissions[submissionId];
        if (s.status != SubmissionStatus.NeedsInfo) revert InvalidSubmissionState();
        if (s.submitter != msg.sender) revert NotSubmitter();
        if (terms.registry != s.terms.registry || terms.registryBatchIdHash != s.terms.registryBatchIdHash) {
            revert InvalidTerms();
        }
        _validate(terms);
        s.terms = terms;
        s.status = SubmissionStatus.Pending;
        emit SubmissionResubmitted(submissionId, terms.documentHash);
    }

    /// @notice Approve and mint the batch to its originator. The ONLY path that creates credits.
    function approveSubmission(uint256 submissionId)
        external
        onlyRole(LISTING_REVIEWER_ROLE)
        whenNotPaused
        nonReentrant
        returns (uint256 batchId)
    {
        Submission storage s = _submissions[submissionId];
        if (s.status != SubmissionStatus.Pending) revert InvalidSubmissionState();
        if (msg.sender == s.submitter) revert ReviewerConflict();
        if (!identityRegistry.isVerifiedEntity(s.submitter)) revert NotVerifiedEntity();

        batchId = ++nextBatchId;
        s.status = SubmissionStatus.Approved;
        s.batchId = batchId;
        _batches[batchId] = s.terms;
        originatorOf[batchId] = s.submitter;
        address to = s.submitter;
        uint256 qty = s.terms.quantity;

        emit BatchIssued(batchId, submissionId, to, qty, msg.sender);
        _mint(to, batchId, qty, "");
    }

    function rejectSubmission(uint256 submissionId, bytes32 reasonRef) external onlyRole(LISTING_REVIEWER_ROLE) {
        Submission storage s = _submissions[submissionId];
        if (s.status != SubmissionStatus.Pending && s.status != SubmissionStatus.NeedsInfo) {
            revert InvalidSubmissionState();
        }
        s.status = SubmissionStatus.Rejected;
        batchKeyUsed[batchKey(s.terms.registry, s.terms.registryBatchIdHash)] = false;
        emit SubmissionRejected(submissionId, msg.sender, reasonRef);
    }

    function withdrawSubmission(uint256 submissionId) external {
        Submission storage s = _submissions[submissionId];
        if (s.status != SubmissionStatus.Pending && s.status != SubmissionStatus.NeedsInfo) {
            revert InvalidSubmissionState();
        }
        if (s.submitter != msg.sender) revert NotSubmitter();
        s.status = SubmissionStatus.Withdrawn;
        batchKeyUsed[batchKey(s.terms.registry, s.terms.registryBatchIdHash)] = false;
        emit SubmissionWithdrawn(submissionId);
    }

    // =====================================================================
    // Retirement & suspension
    // =====================================================================

    /// @notice Permanently retire credits to offset emissions on behalf of `beneficiaryRef`.
    function retire(uint256 batchId, uint256 amount, bytes32 beneficiaryRef, bytes32 reasonRef)
        external
        whenNotPaused
        returns (uint256 retirementId)
    {
        if (amount == 0) revert InvalidAmount();
        if (suspended[batchId]) revert BatchIsSuspended(batchId);
        if (!identityRegistry.isVerified(msg.sender)) revert HolderNotVerified();
        retiredOf[batchId] += amount;
        retirementId = ++retirementCount;
        _burn(msg.sender, batchId, amount); // reverts on insufficient balance
        emit CreditsRetired(retirementId, batchId, msg.sender, amount, beneficiaryRef, reasonRef);
    }

    /// @notice Freeze a batch the registry has cancelled or put under review (or lift the freeze).
    function setSuspended(uint256 batchId, bool value, bytes32 reasonRef) external onlyRole(LISTING_REVIEWER_ROLE) {
        if (originatorOf[batchId] == address(0)) revert UnknownBatch();
        if (suspended[batchId] == value) revert NoChange();
        suspended[batchId] = value;
        emit BatchSuspended(batchId, value, msg.sender, reasonRef);
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    // =====================================================================
    // Transfer rules
    // =====================================================================

    function _update(address from, address to, uint256[] memory ids, uint256[] memory values)
        internal
        override(ERC1155, ERC1155Supply)
    {
        if (from != address(0) && to != address(0)) {
            if (paused()) revert EnforcedPause();
            for (uint256 i = 0; i < ids.length; ++i) {
                if (suspended[ids[i]]) revert BatchIsSuspended(ids[i]);
            }
            if (!identityRegistry.isVerified(from)) revert HolderNotVerified();
            if (!identityRegistry.isVerified(to)) revert HolderNotVerified();
        }
        super._update(from, to, ids, values);
    }

    // =====================================================================
    // Views
    // =====================================================================

    function batchKey(bytes32 registry, bytes32 registryBatchIdHash) public pure returns (bytes32) {
        return keccak256(abi.encode(registry, registryBatchIdHash));
    }

    function getSubmission(uint256 submissionId) external view returns (Submission memory) {
        return _submissions[submissionId];
    }

    function getBatch(uint256 batchId) external view returns (BatchTerms memory) {
        if (originatorOf[batchId] == address(0)) revert UnknownBatch();
        return _batches[batchId];
    }

    /// @inheritdoc ITradableAsset
    function isTradable(uint256 batchId) external view returns (bool) {
        return originatorOf[batchId] != address(0) && !suspended[batchId] && !paused() && totalSupply(batchId) > 0;
    }

    function uri(uint256 batchId) public view override returns (string memory) {
        return _batches[batchId].metadataURI;
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC1155, AccessControlDefaultAdminRules)
        returns (bool)
    {
        return interfaceId == type(ITradableAsset).interfaceId || super.supportsInterface(interfaceId);
    }

    function _validate(BatchTerms calldata t) private view {
        if (
            t.quantity == 0 || t.registry == bytes32(0) || t.registryBatchIdHash == bytes32(0)
                || t.projectIdHash == bytes32(0) || t.documentHash == bytes32(0) || t.vintage < 2000
                || t.vintage > _currentYear()
        ) revert InvalidTerms();
    }

    function _currentYear() private view returns (uint16) {
        return uint16(1970 + block.timestamp / 365.2425 days);
    }
}
