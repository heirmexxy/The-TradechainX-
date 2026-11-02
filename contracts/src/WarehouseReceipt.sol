// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {RWA721Base} from "./base/RWA721Base.sol";
import {IIdentityRegistry} from "./interfaces/IIdentityRegistry.sol";
import {WarehouseRegistry} from "./WarehouseRegistry.sol";

/// @title WarehouseReceipt
/// @notice Each token is one warehouse receipt: a claim on a specific lot of a commodity held in a
///         licensed warehouse. Implements the PRD §4.3 gate on-chain:
///
///           submit (warehouse operator) ─► review (Listing Reviewer) ─► mint to holder
///
///         Nothing can be minted without a Listing Reviewer approving a pending submission, and the
///         reviewer can never be the submitter or the warehouse operator (separation of duties).
///         Every later status change — redemption, partial redemption, voiding, expiry extension —
///         goes back through the same reviewer gate (PRD §4.3 step 6).
///
///         Anti-fraud properties (liens, KYC transfers, pause) come from RWA721Base. Added here:
///           - A receipt number can only ever be issued once per warehouse (duplicate issuance).
///           - Goods cannot be redeemed while the receipt is pledged.
contract WarehouseReceipt is RWA721Base {
    /// @notice What the warehouse attests to. Quantities are in the commodity's base unit (e.g. kg).
    struct ReceiptTerms {
        uint256 warehouseId;
        bytes32 receiptNumberHash; // keccak256 of the normalised paper receipt number
        bytes32 commodity;         // e.g. bytes32("MAIZE")
        bytes32 grade;             // e.g. bytes32("GRADE_1")
        uint256 quantity;
        uint64 depositDate;
        uint64 expiryDate;         // end of storage term; receipt can't move or be pledged after this
        bytes32 documentHash;      // hash of the supporting document bundle (scan, inspection report)
        string metadataURI;        // metadata for the asset page
    }

    enum SubmissionStatus { None, Pending, NeedsInfo, Approved, Rejected, Withdrawn }

    struct Submission {
        ReceiptTerms terms;
        address holder;     // depositor who will receive the token
        address submitter;  // warehouse operator at submission time
        SubmissionStatus status;
        uint256 tokenId;    // set on approval
    }

    enum RequestKind { None, Redeem, PartialRedeem, Void, ExtendExpiry }

    struct StatusRequest {
        RequestKind kind;
        address requester;
        bool warehouseConfirmed; // holder-initiated requests need the warehouse to confirm release
        uint256 newQuantity;     // PartialRedeem: remaining quantity after release
        uint64 newExpiry;        // ExtendExpiry
        bytes32 evidenceRef;
    }

    WarehouseRegistry public immutable warehouseRegistry;

    uint256 public submissionCount;

    mapping(uint256 => Submission) private _submissions;
    mapping(uint256 => ReceiptTerms) private _receipts;   // tokenId => live terms
    mapping(uint256 => uint256) public submissionOfToken; // tokenId => submissionId
    mapping(uint256 => StatusRequest) private _requests;  // tokenId => pending request

    /// @notice keccak256(warehouseId, receiptNumberHash) => reserved/issued.
    ///         Reserved at submission, released only if rejected/withdrawn, never released after minting.
    mapping(bytes32 => bool) public receiptKeyUsed;

    event ReceiptSubmitted(uint256 indexed submissionId, uint256 indexed warehouseId, address indexed holder, bytes32 receiptNumberHash, address submitter);
    event SubmissionInfoRequested(uint256 indexed submissionId, address indexed reviewer, bytes32 reasonRef);
    event SubmissionResubmitted(uint256 indexed submissionId, bytes32 documentHash);
    event SubmissionRejected(uint256 indexed submissionId, address indexed reviewer, bytes32 reasonRef);
    event SubmissionWithdrawn(uint256 indexed submissionId);
    event ReceiptIssued(uint256 indexed tokenId, uint256 indexed submissionId, address indexed holder, address reviewer);

    event StatusChangeRequested(uint256 indexed tokenId, RequestKind kind, address indexed requester, bytes32 evidenceRef);
    event WarehouseReleaseConfirmed(uint256 indexed tokenId, address indexed operator);
    event StatusChangeCancelled(uint256 indexed tokenId, address indexed by);
    event StatusChangeRejected(uint256 indexed tokenId, address indexed reviewer, bytes32 reasonRef);
    event ReceiptRedeemed(uint256 indexed tokenId, address indexed holder, address reviewer);
    event ReceiptPartiallyRedeemed(uint256 indexed tokenId, uint256 previousQuantity, uint256 newQuantity, address reviewer);
    event ReceiptVoided(uint256 indexed tokenId, address indexed lastHolder, bool hadLien, address reviewer);
    event ReceiptExpiryExtended(uint256 indexed tokenId, uint64 previousExpiry, uint64 newExpiry, address reviewer);

    error NotActiveWarehouseOperator();
    error InvalidTerms();
    error DuplicateReceipt();
    error InvalidSubmissionState();
    error NotSubmitter();
    error WarehouseInactive();
    error NoPendingRequest();
    error NotAuthorisedRequester();
    error WarehouseConfirmationRequired();

    constructor(
        address superAdmin,
        uint48 adminTransferDelay,
        IIdentityRegistry identityRegistry_,
        WarehouseRegistry warehouseRegistry_
    ) RWA721Base("TradeChainX Warehouse Receipt", "TCX-WR", superAdmin, adminTransferDelay, identityRegistry_) {
        if (address(warehouseRegistry_) == address(0)) revert ZeroAddress();
        warehouseRegistry = warehouseRegistry_;
    }

    // =====================================================================
    // 1. Submission & review (PRD §4.3 steps 1–4)
    // =====================================================================

    /// @notice Warehouse operator submits a receipt for review. Nothing is minted here.
    function submitReceipt(ReceiptTerms calldata terms, address holder)
        external
        whenNotPaused
        returns (uint256 submissionId)
    {
        if (!warehouseRegistry.isActiveOperator(terms.warehouseId, msg.sender)) revert NotActiveWarehouseOperator();
        if (holder == address(0)) revert ZeroAddress();
        if (!identityRegistry.isVerified(holder)) revert HolderNotVerified();
        _validateTerms(terms);

        bytes32 key = receiptKey(terms.warehouseId, terms.receiptNumberHash);
        if (receiptKeyUsed[key]) revert DuplicateReceipt();
        receiptKeyUsed[key] = true;

        submissionId = ++submissionCount;
        Submission storage s = _submissions[submissionId];
        s.terms = terms;
        s.holder = holder;
        s.submitter = msg.sender;
        s.status = SubmissionStatus.Pending;

        emit ReceiptSubmitted(submissionId, terms.warehouseId, holder, terms.receiptNumberHash, msg.sender);
    }

    /// @notice Reviewer asks the warehouse for more information (PRD "Needs Info").
    function requestInfo(uint256 submissionId, bytes32 reasonRef) external onlyRole(LISTING_REVIEWER_ROLE) {
        Submission storage s = _submissions[submissionId];
        if (s.status != SubmissionStatus.Pending) revert InvalidSubmissionState();
        s.status = SubmissionStatus.NeedsInfo;
        emit SubmissionInfoRequested(submissionId, msg.sender, reasonRef);
    }

    /// @notice Submitter corrects a submission. Warehouse and receipt number are fixed — a different
    ///         receipt number is a different receipt and needs a fresh submission.
    function resubmit(uint256 submissionId, ReceiptTerms calldata terms, address holder) external whenNotPaused {
        Submission storage s = _submissions[submissionId];
        if (s.status != SubmissionStatus.NeedsInfo) revert InvalidSubmissionState();
        if (s.submitter != msg.sender) revert NotSubmitter();
        if (!warehouseRegistry.isActiveOperator(terms.warehouseId, msg.sender)) revert NotActiveWarehouseOperator();
        if (terms.warehouseId != s.terms.warehouseId || terms.receiptNumberHash != s.terms.receiptNumberHash) {
            revert InvalidTerms();
        }
        if (holder == address(0)) revert ZeroAddress();
        if (!identityRegistry.isVerified(holder)) revert HolderNotVerified();
        _validateTerms(terms);

        s.terms = terms;
        s.holder = holder;
        s.status = SubmissionStatus.Pending;
        emit SubmissionResubmitted(submissionId, terms.documentHash);
    }

    /// @notice Approve and mint. The ONLY path that creates a receipt token.
    function approveSubmission(uint256 submissionId)
        external
        onlyRole(LISTING_REVIEWER_ROLE)
        whenNotPaused
        nonReentrant
        returns (uint256 tokenId)
    {
        Submission storage s = _submissions[submissionId];
        if (s.status != SubmissionStatus.Pending) revert InvalidSubmissionState();

        uint256 warehouseId = s.terms.warehouseId;
        // Separation of duties: the approver can't be the submitter or the current warehouse operator.
        if (msg.sender == s.submitter || msg.sender == warehouseRegistry.operatorOf(warehouseId)) {
            revert ReviewerConflict();
        }
        // Re-check everything that may have changed while the submission waited in the queue.
        if (!warehouseRegistry.isActive(warehouseId)) revert WarehouseInactive();
        if (!identityRegistry.isVerified(s.holder)) revert HolderNotVerified();
        if (s.terms.expiryDate <= block.timestamp) revert ReceiptExpired();

        tokenId = ++nextTokenId;
        s.status = SubmissionStatus.Approved;
        s.tokenId = tokenId;
        _receipts[tokenId] = s.terms;
        submissionOfToken[tokenId] = submissionId;
        address holder = s.holder;

        emit ReceiptIssued(tokenId, submissionId, holder, msg.sender);
        _safeMint(holder, tokenId);
    }

    function rejectSubmission(uint256 submissionId, bytes32 reasonRef) external onlyRole(LISTING_REVIEWER_ROLE) {
        Submission storage s = _submissions[submissionId];
        if (s.status != SubmissionStatus.Pending && s.status != SubmissionStatus.NeedsInfo) {
            revert InvalidSubmissionState();
        }
        s.status = SubmissionStatus.Rejected;
        receiptKeyUsed[receiptKey(s.terms.warehouseId, s.terms.receiptNumberHash)] = false;
        emit SubmissionRejected(submissionId, msg.sender, reasonRef);
    }

    function withdrawSubmission(uint256 submissionId) external {
        Submission storage s = _submissions[submissionId];
        if (s.status != SubmissionStatus.Pending && s.status != SubmissionStatus.NeedsInfo) {
            revert InvalidSubmissionState();
        }
        if (s.submitter != msg.sender) revert NotSubmitter();
        s.status = SubmissionStatus.Withdrawn;
        receiptKeyUsed[receiptKey(s.terms.warehouseId, s.terms.receiptNumberHash)] = false;
        emit SubmissionWithdrawn(submissionId);
    }

    // =====================================================================
    // 2. Status changes (PRD §4.3 step 6 — re-submitted and re-approved)
    // =====================================================================

    /// @notice Holder asks to take the goods out (full) or part of them (partial).
    function requestRedemption(uint256 tokenId, uint256 remainingQuantity, bytes32 evidenceRef) external whenNotPaused {
        if (ownerOf(tokenId) != msg.sender) revert NotHolder();
        if (_hasLien(tokenId)) revert AlreadyLiened();
        if (_requests[tokenId].kind != RequestKind.None) revert RequestPending();

        RequestKind kind;
        if (remainingQuantity == 0) {
            kind = RequestKind.Redeem;
        } else {
            if (remainingQuantity >= _receipts[tokenId].quantity) revert InvalidRequest();
            kind = RequestKind.PartialRedeem;
        }
        _requests[tokenId] = StatusRequest(kind, msg.sender, false, remainingQuantity, 0, evidenceRef);
        emit StatusChangeRequested(tokenId, kind, msg.sender, evidenceRef);
    }

    /// @notice Warehouse operator asks to void the receipt (goods lost/damaged/fraud) or extend its term.
    function requestWarehouseChange(uint256 tokenId, RequestKind kind, uint64 newExpiry, bytes32 evidenceRef)
        external
        whenNotPaused
    {
        _requireMinted(tokenId);
        ReceiptTerms storage r = _receipts[tokenId];
        if (!warehouseRegistry.isActiveOperator(r.warehouseId, msg.sender)) revert NotActiveWarehouseOperator();
        if (_requests[tokenId].kind != RequestKind.None) revert RequestPending();

        if (kind == RequestKind.Void) {
            newExpiry = 0;
        } else if (kind == RequestKind.ExtendExpiry) {
            if (newExpiry <= r.expiryDate) revert InvalidRequest();
        } else {
            revert InvalidRequest();
        }
        _requests[tokenId] = StatusRequest(kind, msg.sender, true, 0, newExpiry, evidenceRef);
        emit StatusChangeRequested(tokenId, kind, msg.sender, evidenceRef);
    }

    /// @notice Warehouse confirms it has released (or will release) the goods for a holder redemption.
    function confirmWarehouseRelease(uint256 tokenId) external whenNotPaused {
        StatusRequest storage q = _requests[tokenId];
        if (q.kind != RequestKind.Redeem && q.kind != RequestKind.PartialRedeem) revert NoPendingRequest();
        if (!warehouseRegistry.isActiveOperator(_receipts[tokenId].warehouseId, msg.sender)) {
            revert NotActiveWarehouseOperator();
        }
        q.warehouseConfirmed = true;
        emit WarehouseReleaseConfirmed(tokenId, msg.sender);
    }

    function cancelStatusRequest(uint256 tokenId) external {
        StatusRequest storage q = _requests[tokenId];
        if (q.kind == RequestKind.None) revert NoPendingRequest();
        if (q.requester != msg.sender) revert NotAuthorisedRequester();
        delete _requests[tokenId];
        emit StatusChangeCancelled(tokenId, msg.sender);
    }

    function rejectStatusRequest(uint256 tokenId, bytes32 reasonRef) external onlyRole(LISTING_REVIEWER_ROLE) {
        if (_requests[tokenId].kind == RequestKind.None) revert NoPendingRequest();
        delete _requests[tokenId];
        emit StatusChangeRejected(tokenId, msg.sender, reasonRef);
    }

    /// @notice Reviewer approves the pending status change and it takes effect.
    function approveStatusRequest(uint256 tokenId) external onlyRole(LISTING_REVIEWER_ROLE) whenNotPaused nonReentrant {
        StatusRequest memory q = _requests[tokenId];
        if (q.kind == RequestKind.None) revert NoPendingRequest();
        ReceiptTerms storage r = _receipts[tokenId];
        address holder = ownerOf(tokenId);
        if (msg.sender == q.requester || msg.sender == holder || msg.sender == warehouseRegistry.operatorOf(r.warehouseId)) {
            revert ReviewerConflict();
        }
        delete _requests[tokenId];

        if (q.kind == RequestKind.Redeem) {
            if (!q.warehouseConfirmed) revert WarehouseConfirmationRequired();
            if (_hasLien(tokenId)) revert AlreadyLiened(); // defensive
            delete _receipts[tokenId];
            _burn(tokenId);
            emit ReceiptRedeemed(tokenId, holder, msg.sender);
        } else if (q.kind == RequestKind.PartialRedeem) {
            if (!q.warehouseConfirmed) revert WarehouseConfirmationRequired();
            if (_hasLien(tokenId)) revert AlreadyLiened(); // defensive
            if (q.newQuantity >= r.quantity) revert InvalidRequest(); // defensive
            uint256 previous = r.quantity;
            r.quantity = q.newQuantity;
            emit ReceiptPartiallyRedeemed(tokenId, previous, q.newQuantity, msg.sender);
        } else if (q.kind == RequestKind.Void) {
            bool hadLien = _hasLien(tokenId);
            _clearLien(tokenId);
            delete _receipts[tokenId];
            _burn(tokenId);
            emit ReceiptVoided(tokenId, holder, hadLien, msg.sender);
        } else {
            uint64 previous = r.expiryDate;
            r.expiryDate = q.newExpiry;
            emit ReceiptExpiryExtended(tokenId, previous, q.newExpiry, msg.sender);
        }
    }

    // =====================================================================
    // Hooks & views
    // =====================================================================

    function _expiryOf(uint256 tokenId) internal view override returns (uint64) {
        return _receipts[tokenId].expiryDate;
    }

    function _hasPendingRequest(uint256 tokenId) internal view override returns (bool) {
        return _requests[tokenId].kind != RequestKind.None;
    }

    function receiptKey(uint256 warehouseId, bytes32 receiptNumberHash) public pure returns (bytes32) {
        return keccak256(abi.encode(warehouseId, receiptNumberHash));
    }

    function getSubmission(uint256 submissionId) external view returns (Submission memory) {
        return _submissions[submissionId];
    }

    function getReceipt(uint256 tokenId) external view returns (ReceiptTerms memory) {
        _requireMinted(tokenId);
        return _receipts[tokenId];
    }

    function getStatusRequest(uint256 tokenId) external view returns (StatusRequest memory) {
        return _requests[tokenId];
    }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireMinted(tokenId);
        return _receipts[tokenId].metadataURI;
    }

    function _validateTerms(ReceiptTerms calldata t) private view {
        if (
            t.quantity == 0 || t.receiptNumberHash == bytes32(0) || t.commodity == bytes32(0)
                || t.documentHash == bytes32(0) || t.depositDate > block.timestamp || t.expiryDate <= block.timestamp
                || t.expiryDate <= t.depositDate
        ) revert InvalidTerms();
    }
}
