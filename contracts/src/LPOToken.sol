// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {RWA721Base} from "./base/RWA721Base.sol";
import {IIdentityRegistry} from "./interfaces/IIdentityRegistry.sol";

/// @title LPOToken
/// @notice Each token is one confirmed Local Purchase Order: a buyer's commitment to pay a supplier
///         (the SME) a face value by a due date. The SME can sell or pledge the token to get working
///         capital now; whoever holds it at settlement gets paid.
///
///           SME submits ─► Listing Reviewer approves ─► token minted to the SME
///           Payer deposits face value in USDC ─► paid straight to the holder, token retired
///
///         Other status changes (settled off-chain, cancelled, due date extended) go back through the
///         reviewer gate (PRD §4.3 step 6).
contract LPOToken is RWA721Base {
    using SafeERC20 for IERC20;

    struct LPOTerms {
        bytes32 lpoNumberHash;   // keccak256 of the normalised LPO number
        bytes32 buyerRefHash;    // keccak256 of the buyer's registration number (identifies the obligor)
        bytes32 description;     // e.g. bytes32("MAIZE_50T")
        uint256 faceValue;       // amount the buyer will pay, in settlement-token units (USDC: 6 decimals)
        uint64 issueDate;
        uint64 dueDate;          // payment due; token can't move or be pledged after this unless extended
        bytes32 documentHash;    // hash of LPO scan + buyer confirmation
        string metadataURI;
    }

    enum SubmissionStatus { None, Pending, NeedsInfo, Approved, Rejected, Withdrawn }

    struct Submission {
        LPOTerms terms;
        address submitter; // the supplier SME; receives the token
        SubmissionStatus status;
        uint256 tokenId;
    }

    enum RequestKind { None, SettledOffChain, Cancel, ExtendDueDate }

    struct StatusRequest {
        RequestKind kind;
        address requester;
        uint64 newDueDate;
        bytes32 evidenceRef;
    }

    IERC20 public immutable settlementToken;

    uint256 public submissionCount;
    mapping(uint256 => Submission) private _submissions;
    mapping(uint256 => LPOTerms) private _lpos;
    mapping(uint256 => address) public originatorOf; // tokenId => supplier SME
    mapping(uint256 => uint256) public submissionOfToken;
    mapping(uint256 => StatusRequest) private _requests;
    mapping(bytes32 => bool) public lpoKeyUsed;

    event LPOSubmitted(uint256 indexed submissionId, address indexed submitter, bytes32 lpoNumberHash, bytes32 buyerRefHash, uint256 faceValue);
    event SubmissionInfoRequested(uint256 indexed submissionId, address indexed reviewer, bytes32 reasonRef);
    event SubmissionResubmitted(uint256 indexed submissionId, bytes32 documentHash);
    event SubmissionRejected(uint256 indexed submissionId, address indexed reviewer, bytes32 reasonRef);
    event SubmissionWithdrawn(uint256 indexed submissionId);
    event LPOIssued(uint256 indexed tokenId, uint256 indexed submissionId, address indexed holder, address reviewer);

    event LPOSettled(uint256 indexed tokenId, address indexed payer, address indexed holder, uint256 amount);
    event StatusChangeRequested(uint256 indexed tokenId, RequestKind kind, address indexed requester, bytes32 evidenceRef);
    event StatusChangeCancelled(uint256 indexed tokenId, address indexed by);
    event StatusChangeRejected(uint256 indexed tokenId, address indexed reviewer, bytes32 reasonRef);
    event LPOSettledOffChain(uint256 indexed tokenId, address indexed holder, address reviewer);
    event LPOCancelled(uint256 indexed tokenId, address indexed lastHolder, bool hadLien, address reviewer);
    event LPODueDateExtended(uint256 indexed tokenId, uint64 previousDueDate, uint64 newDueDate, address reviewer);

    error NotVerifiedEntity();
    error InvalidTerms();
    error DuplicateLPO();
    error InvalidSubmissionState();
    error NotSubmitter();
    error NoPendingRequest();
    error NotAuthorisedRequester();
    error HeldByPlatform();

    constructor(address superAdmin, uint48 adminTransferDelay, IIdentityRegistry identityRegistry_, IERC20 settlementToken_)
        RWA721Base("TradeChainX LPO", "TCX-LPO", superAdmin, adminTransferDelay, identityRegistry_)
    {
        if (address(settlementToken_) == address(0)) revert ZeroAddress();
        settlementToken = settlementToken_;
    }

    // =====================================================================
    // 1. Submission & review
    // =====================================================================

    function submitLPO(LPOTerms calldata terms) external whenNotPaused returns (uint256 submissionId) {
        if (!identityRegistry.isVerifiedEntity(msg.sender)) revert NotVerifiedEntity();
        _validateTerms(terms);

        bytes32 key = lpoKey(terms.buyerRefHash, terms.lpoNumberHash);
        if (lpoKeyUsed[key]) revert DuplicateLPO();
        lpoKeyUsed[key] = true;

        submissionId = ++submissionCount;
        Submission storage s = _submissions[submissionId];
        s.terms = terms;
        s.submitter = msg.sender;
        s.status = SubmissionStatus.Pending;
        emit LPOSubmitted(submissionId, msg.sender, terms.lpoNumberHash, terms.buyerRefHash, terms.faceValue);
    }

    function requestInfo(uint256 submissionId, bytes32 reasonRef) external onlyRole(LISTING_REVIEWER_ROLE) {
        Submission storage s = _submissions[submissionId];
        if (s.status != SubmissionStatus.Pending) revert InvalidSubmissionState();
        s.status = SubmissionStatus.NeedsInfo;
        emit SubmissionInfoRequested(submissionId, msg.sender, reasonRef);
    }

    /// @notice Buyer reference and LPO number are fixed; everything else can be corrected.
    function resubmit(uint256 submissionId, LPOTerms calldata terms) external whenNotPaused {
        Submission storage s = _submissions[submissionId];
        if (s.status != SubmissionStatus.NeedsInfo) revert InvalidSubmissionState();
        if (s.submitter != msg.sender) revert NotSubmitter();
        if (terms.lpoNumberHash != s.terms.lpoNumberHash || terms.buyerRefHash != s.terms.buyerRefHash) {
            revert InvalidTerms();
        }
        _validateTerms(terms);
        s.terms = terms;
        s.status = SubmissionStatus.Pending;
        emit SubmissionResubmitted(submissionId, terms.documentHash);
    }

    /// @notice Approve and mint to the supplier. The ONLY path that creates an LPO token.
    function approveSubmission(uint256 submissionId)
        external
        onlyRole(LISTING_REVIEWER_ROLE)
        whenNotPaused
        nonReentrant
        returns (uint256 tokenId)
    {
        Submission storage s = _submissions[submissionId];
        if (s.status != SubmissionStatus.Pending) revert InvalidSubmissionState();
        if (msg.sender == s.submitter) revert ReviewerConflict();
        if (!identityRegistry.isVerifiedEntity(s.submitter)) revert NotVerifiedEntity();
        if (s.terms.dueDate <= block.timestamp) revert ReceiptExpired();

        tokenId = ++nextTokenId;
        s.status = SubmissionStatus.Approved;
        s.tokenId = tokenId;
        _lpos[tokenId] = s.terms;
        originatorOf[tokenId] = s.submitter;
        submissionOfToken[tokenId] = submissionId;
        address holder = s.submitter;

        emit LPOIssued(tokenId, submissionId, holder, msg.sender);
        _safeMint(holder, tokenId);
    }

    function rejectSubmission(uint256 submissionId, bytes32 reasonRef) external onlyRole(LISTING_REVIEWER_ROLE) {
        Submission storage s = _submissions[submissionId];
        if (s.status != SubmissionStatus.Pending && s.status != SubmissionStatus.NeedsInfo) {
            revert InvalidSubmissionState();
        }
        s.status = SubmissionStatus.Rejected;
        lpoKeyUsed[lpoKey(s.terms.buyerRefHash, s.terms.lpoNumberHash)] = false;
        emit SubmissionRejected(submissionId, msg.sender, reasonRef);
    }

    function withdrawSubmission(uint256 submissionId) external {
        Submission storage s = _submissions[submissionId];
        if (s.status != SubmissionStatus.Pending && s.status != SubmissionStatus.NeedsInfo) {
            revert InvalidSubmissionState();
        }
        if (s.submitter != msg.sender) revert NotSubmitter();
        s.status = SubmissionStatus.Withdrawn;
        lpoKeyUsed[lpoKey(s.terms.buyerRefHash, s.terms.lpoNumberHash)] = false;
        emit SubmissionWithdrawn(submissionId);
    }

    // =====================================================================
    // 2. Settlement
    // =====================================================================

    /// @notice Pay the LPO: the payer (buyer, SME, or anyone) transfers the face value, which goes
    ///         straight to the current holder, and the token is retired. Blocked while pledged (the
    ///         lender releases the lien once repaid) and while held by a platform contract (the seller
    ///         cancels the listing first), so funds can never land somewhere they'd be stuck.
    function settle(uint256 tokenId) external whenNotPaused nonReentrant {
        address holder = ownerOf(tokenId);
        if (_hasLien(tokenId)) revert AlreadyLiened();
        if (_hasPendingRequest(tokenId)) revert RequestPending();
        if (identityRegistry.tierOf(holder) == IIdentityRegistry.Tier.Platform) revert HeldByPlatform();

        uint256 amount = _lpos[tokenId].faceValue;
        delete _lpos[tokenId];
        _burn(tokenId);
        emit LPOSettled(tokenId, msg.sender, holder, amount);

        settlementToken.safeTransferFrom(msg.sender, holder, amount);
    }

    // =====================================================================
    // 3. Status changes through the reviewer gate
    // =====================================================================

    /// @notice Holder reports the buyer paid outside the platform.
    function requestOffChainSettlement(uint256 tokenId, bytes32 evidenceRef) external whenNotPaused {
        if (ownerOf(tokenId) != msg.sender) revert NotHolder();
        if (_hasLien(tokenId)) revert AlreadyLiened();
        if (_requests[tokenId].kind != RequestKind.None) revert RequestPending();
        _requests[tokenId] = StatusRequest(RequestKind.SettledOffChain, msg.sender, 0, evidenceRef);
        emit StatusChangeRequested(tokenId, RequestKind.SettledOffChain, msg.sender, evidenceRef);
    }

    /// @notice Supplier reports the order was cancelled, or agreed a new due date with the buyer.
    function requestOriginatorChange(uint256 tokenId, RequestKind kind, uint64 newDueDate, bytes32 evidenceRef)
        external
        whenNotPaused
    {
        _requireMinted(tokenId);
        if (originatorOf[tokenId] != msg.sender) revert NotAuthorisedRequester();
        if (_requests[tokenId].kind != RequestKind.None) revert RequestPending();
        if (kind == RequestKind.Cancel) {
            newDueDate = 0;
        } else if (kind == RequestKind.ExtendDueDate) {
            if (newDueDate <= _lpos[tokenId].dueDate) revert InvalidRequest();
        } else {
            revert InvalidRequest();
        }
        _requests[tokenId] = StatusRequest(kind, msg.sender, newDueDate, evidenceRef);
        emit StatusChangeRequested(tokenId, kind, msg.sender, evidenceRef);
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

    function approveStatusRequest(uint256 tokenId) external onlyRole(LISTING_REVIEWER_ROLE) whenNotPaused nonReentrant {
        StatusRequest memory q = _requests[tokenId];
        if (q.kind == RequestKind.None) revert NoPendingRequest();
        address holder = ownerOf(tokenId);
        if (msg.sender == q.requester || msg.sender == holder || msg.sender == originatorOf[tokenId]) {
            revert ReviewerConflict();
        }
        delete _requests[tokenId];

        if (q.kind == RequestKind.SettledOffChain) {
            if (_hasLien(tokenId)) revert AlreadyLiened(); // defensive
            delete _lpos[tokenId];
            _burn(tokenId);
            emit LPOSettledOffChain(tokenId, holder, msg.sender);
        } else if (q.kind == RequestKind.Cancel) {
            bool hadLien = _hasLien(tokenId);
            _clearLien(tokenId);
            delete _lpos[tokenId];
            _burn(tokenId);
            emit LPOCancelled(tokenId, holder, hadLien, msg.sender);
        } else {
            LPOTerms storage t = _lpos[tokenId];
            uint64 previous = t.dueDate;
            t.dueDate = q.newDueDate;
            emit LPODueDateExtended(tokenId, previous, q.newDueDate, msg.sender);
        }
    }

    // =====================================================================
    // Hooks & views
    // =====================================================================

    function _expiryOf(uint256 tokenId) internal view override returns (uint64) {
        return _lpos[tokenId].dueDate;
    }

    function _hasPendingRequest(uint256 tokenId) internal view override returns (bool) {
        return _requests[tokenId].kind != RequestKind.None;
    }

    function lpoKey(bytes32 buyerRefHash, bytes32 lpoNumberHash) public pure returns (bytes32) {
        return keccak256(abi.encode(buyerRefHash, lpoNumberHash));
    }

    function getSubmission(uint256 submissionId) external view returns (Submission memory) {
        return _submissions[submissionId];
    }

    function getLPO(uint256 tokenId) external view returns (LPOTerms memory) {
        _requireMinted(tokenId);
        return _lpos[tokenId];
    }

    function getStatusRequest(uint256 tokenId) external view returns (StatusRequest memory) {
        return _requests[tokenId];
    }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireMinted(tokenId);
        return _lpos[tokenId].metadataURI;
    }

    function _validateTerms(LPOTerms calldata t) private view {
        if (
            t.faceValue == 0 || t.lpoNumberHash == bytes32(0) || t.buyerRefHash == bytes32(0)
                || t.documentHash == bytes32(0) || t.issueDate > block.timestamp || t.dueDate <= block.timestamp
                || t.dueDate <= t.issueDate
        ) revert InvalidTerms();
    }
}
