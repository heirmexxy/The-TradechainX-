// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import {ERC1155Supply} from "@openzeppelin/contracts/token/ERC1155/extensions/ERC1155Supply.sol";
import {AccessControlDefaultAdminRules} from
    "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IIdentityRegistry} from "./interfaces/IIdentityRegistry.sol";
import {ITradableAsset} from "./interfaces/ITradableAsset.sol";
import {WarehouseRegistry} from "./WarehouseRegistry.sol";

/// @title CommodityUnits
/// @notice Pooled, fungible claims on graded commodity stock held in approved warehouses
///         (Commodity Units spec v0.1, PRD v3 §4 and §6).
///
///         One ERC-1155 token id = one commodity class (e.g. "Soybean Grade 1"). One base unit is
///         ONE GRAM, so 1 kg = 1000 units and holdings are divisible to 0.001 kg.
///         Units of a class are interchangeable across lots; the market has one price per class.
///
///         Issuance is the only way units come into existence, and it is gated three ways:
///
///           warehouse operator submits lot ─► stock auditor attests quantity and monitoring
///                                          ─► listing reviewer approves ─► units minted to issuer
///
///         Three different people are required (submitter, attester, approver). Units minted are
///         the attested weight minus the class shrinkage buffer, so units outstanding can never
///         exceed the buffered weight of live stock:  totalSupply <= backedGrams * (1 - buffer).
///
///         Units leave circulation only through a two-person-approved lot sale to a processor
///         (`proposeSale` -> `approveSale` -> `retireForSale`). Holding fees are collected in kind
///         (units move to the class fee collector) with a hard cap per holder per 30-day period.
///
///         If stock is reported short, or monitoring stops reporting, the class halts automatically:
///         no ordinary transfers until the class is back within its backing and a class manager
///         resumes it. Minting, fee collection and retirement are not ordinary transfers and still work.
///
///         Which holders' units are retired in a sale (pro rata or opt-in) is decided off-chain by
///         the settlement engine (PRD v3 §7.6); this contract enforces the amounts, the caps and the
///         audit trail, not the allocation policy.
contract CommodityUnits is ERC1155, ERC1155Supply, AccessControlDefaultAdminRules, Pausable, ReentrancyGuard, ITradableAsset {
    bytes32 public constant CLASS_MANAGER_ROLE = keccak256("CLASS_MANAGER_ROLE");
    bytes32 public constant STOCK_AUDITOR_ROLE = keccak256("STOCK_AUDITOR_ROLE");
    bytes32 public constant LISTING_REVIEWER_ROLE = keccak256("LISTING_REVIEWER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 public constant RETIREMENT_OPERATOR_ROLE = keccak256("RETIREMENT_OPERATOR_ROLE");
    bytes32 public constant FEE_OPERATOR_ROLE = keccak256("FEE_OPERATOR_ROLE");

    uint256 public constant UNITS_PER_KG = 1000;
    uint16 public constant BPS = 10_000;
    uint16 public constant MAX_SHRINKAGE_BPS = 2_000; // buffer can't exceed 20%
    uint16 public constant MAX_FEE_BPS_CAP = 500;     // a single holding-fee charge can't exceed 5% of a balance
    uint64 public constant FEE_PERIOD = 30 days;

    struct Class {
        bytes32 commodity;     // e.g. bytes32("SOYBEAN")
        bytes32 grade;         // e.g. bytes32("GRADE_1")
        uint16 shrinkageBps;   // held back from issuance for moisture loss
        uint16 maxFeeBps;      // max holding fee per period, as a share of a holder's balance
        address issuer;        // receives newly issued units (the market-maker / issuing treasury)
        address feeCollector;  // receives holding fees in kind
        bool active;           // inactive classes accept no new lots
        bool halted;           // no ordinary transfers while true
        uint256 backedGrams;   // remaining attested weight of live lots
        uint256 unmonitoredLots; // live lots whose monitoring is not reporting
        string metadataURI;
    }

    struct LotTerms {
        uint256 classId;
        uint256 warehouseId;
        bytes32 lotRefHash;     // keccak256 of the warehouse's lot / intake reference
        uint256 grossGrams;     // weight claimed by the operator
        uint64 intakeDate;
        bytes32 documentHash;   // intake record, grading report, photos
        bytes32 receiptRef;     // link to the underlying warehouse receipt (0 if none)
    }

    enum LotStatus { None, Pending, Attested, Live, Rejected, Withdrawn, Depleted }

    struct Lot {
        LotTerms terms;
        address submitter;
        address attester;
        LotStatus status;
        uint256 attestedGrams;
        uint256 remainingGrams; // attested weight still in the warehouse
        uint256 issuedLive;     // units issued for this lot that are not yet retired
        bool monitoringOk;      // live sensor feed (moisture, temperature, humidity) is reporting
        bytes32 attestationRef;
    }

    enum SaleStatus { None, Proposed, Approved, Completed, Cancelled }

    struct Sale {
        uint256 lotId;
        uint256 grams;          // stock sold to the processor
        uint256 unitsToRetire;  // units that must be retired for this stock to leave the pool
        uint256 retired;
        bytes32 saleRef;        // hash of the processor sale record
        address proposer;
        SaleStatus status;
    }

    IIdentityRegistry public immutable identityRegistry;
    WarehouseRegistry public immutable warehouseRegistry;

    uint256 public classCount;
    uint256 public lotCount;
    uint256 public saleCount;

    mapping(uint256 => Class) private _classes;
    mapping(uint256 => Lot) private _lots;
    mapping(uint256 => Sale) private _sales;
    mapping(uint256 => uint256) public openSaleOfLot;                 // lotId => saleId (0 if none)
    mapping(bytes32 => bool) public classKeyUsed;                     // (commodity, grade)
    mapping(bytes32 => bool) public lotKeyUsed;                       // (warehouseId, lotRefHash)
    mapping(uint256 => mapping(address => uint64)) public lastFeePeriod; // classId => holder => period index

    /// @dev True only inside fee collection. Ordinary identity/halt checks are skipped for that move.
    bool private _bypassChecks;

    event ClassCreated(uint256 indexed classId, bytes32 commodity, bytes32 grade, uint16 shrinkageBps, address issuer, address feeCollector);
    event ClassActiveChanged(uint256 indexed classId, bool active);
    event ClassHalted(uint256 indexed classId, bytes32 reasonRef, address indexed by);
    event ClassResumed(uint256 indexed classId, address indexed by);

    event LotSubmitted(uint256 indexed lotId, uint256 indexed classId, uint256 indexed warehouseId, bytes32 lotRefHash, uint256 grossGrams, address submitter);
    event LotAttested(uint256 indexed lotId, uint256 attestedGrams, bool monitoringOk, bytes32 attestationRef, address indexed auditor);
    event LotApproved(uint256 indexed lotId, uint256 indexed classId, uint256 unitsIssued, address issuer, address indexed reviewer);
    event LotRejected(uint256 indexed lotId, address indexed reviewer, bytes32 reasonRef);
    event LotWithdrawn(uint256 indexed lotId);
    event MonitoringChanged(uint256 indexed lotId, bool monitoringOk, address indexed auditor);
    event ShortfallReported(uint256 indexed lotId, uint256 previousGrams, uint256 newGrams, bytes32 evidenceRef, address indexed auditor);

    event SaleProposed(uint256 indexed saleId, uint256 indexed lotId, uint256 grams, uint256 unitsToRetire, bytes32 saleRef, address indexed proposer);
    event SaleApproved(uint256 indexed saleId, address indexed reviewer);
    event SaleCancelled(uint256 indexed saleId, address indexed by);
    event UnitsRetired(uint256 indexed saleId, uint256 indexed classId, address indexed holder, uint256 amount);
    event SaleCompleted(uint256 indexed saleId, uint256 indexed lotId, uint256 grams, uint256 unitsRetired);

    event UnbackedUnitsRetired(uint256 indexed lotId, uint256 indexed classId, address indexed holder, uint256 amount, bytes32 evidenceRef);
    event HoldingFeeCharged(uint256 indexed classId, address indexed holder, uint256 amount, uint64 period);

    error ZeroAddress();
    error NotVerifiedEntity();
    error HolderNotVerified();
    error IssuerNotVerified();
    error InvalidTerms();
    error InvalidAmount();
    error UnknownClass();
    error UnknownLot();
    error UnknownSale();
    error ClassInactive();
    error ClassIsHalted(uint256 classId);
    error DuplicateClass();
    error DuplicateLot();
    error NotActiveWarehouseOperator();
    error WarehouseInactive();
    error InvalidLotState();
    error InvalidSaleState();
    error NotSubmitter();
    error ReviewerConflict();
    error MonitoringNotReporting();
    error OpenSaleExists();
    error ExceedsRetirementTarget();
    error LengthMismatch();
    error FeeAlreadyChargedThisPeriod(address holder);
    error FeeExceedsCap(address holder);
    error BackingShortfall();
    error NoChange();

    constructor(
        address superAdmin,
        uint48 adminTransferDelay,
        IIdentityRegistry identityRegistry_,
        WarehouseRegistry warehouseRegistry_
    ) ERC1155("") AccessControlDefaultAdminRules(adminTransferDelay, superAdmin) {
        if (address(identityRegistry_) == address(0) || address(warehouseRegistry_) == address(0)) revert ZeroAddress();
        identityRegistry = identityRegistry_;
        warehouseRegistry = warehouseRegistry_;
    }

    // =====================================================================
    // Classes
    // =====================================================================

    /// @notice Define a new commodity class. Adding a commodity needs no new code — only a class.
    function createClass(
        bytes32 commodity,
        bytes32 grade,
        uint16 shrinkageBps,
        uint16 maxFeeBps,
        address issuer,
        address feeCollector,
        string calldata metadataURI
    ) external onlyRole(CLASS_MANAGER_ROLE) returns (uint256 classId) {
        if (commodity == bytes32(0) || grade == bytes32(0)) revert InvalidTerms();
        if (shrinkageBps > MAX_SHRINKAGE_BPS || maxFeeBps > MAX_FEE_BPS_CAP) revert InvalidTerms();
        if (issuer == address(0) || feeCollector == address(0)) revert ZeroAddress();
        if (!identityRegistry.isVerifiedEntity(issuer)) revert IssuerNotVerified();
        if (!identityRegistry.isVerified(feeCollector)) revert HolderNotVerified();

        bytes32 key = keccak256(abi.encode(commodity, grade));
        if (classKeyUsed[key]) revert DuplicateClass();
        classKeyUsed[key] = true;

        classId = ++classCount;
        Class storage c = _classes[classId];
        c.commodity = commodity;
        c.grade = grade;
        c.shrinkageBps = shrinkageBps;
        c.maxFeeBps = maxFeeBps;
        c.issuer = issuer;
        c.feeCollector = feeCollector;
        c.active = true;
        c.metadataURI = metadataURI;
        emit ClassCreated(classId, commodity, grade, shrinkageBps, issuer, feeCollector);
    }

    function setClassActive(uint256 classId, bool active) external onlyRole(CLASS_MANAGER_ROLE) {
        Class storage c = _class(classId);
        if (c.active == active) revert NoChange();
        c.active = active;
        emit ClassActiveChanged(classId, active);
    }

    /// @notice Stop ordinary transfers of a class (incident, audit finding).
    function haltClass(uint256 classId, bytes32 reasonRef) external onlyRole(PAUSER_ROLE) {
        _class(classId);
        _halt(classId, reasonRef);
    }

    /// @notice Resume only when the class is back within its backing and every live lot is reporting.
    function resumeClass(uint256 classId) external onlyRole(CLASS_MANAGER_ROLE) {
        Class storage c = _class(classId);
        if (!c.halted) revert NoChange();
        if (totalSupply(classId) > issuableGrams(classId)) revert BackingShortfall();
        if (c.unmonitoredLots != 0) revert MonitoringNotReporting();
        c.halted = false;
        emit ClassResumed(classId, msg.sender);
    }

    // =====================================================================
    // Lots: submit -> attest -> approve (the only path that creates units)
    // =====================================================================

    function submitLot(LotTerms calldata terms) external whenNotPaused returns (uint256 lotId) {
        Class storage c = _class(terms.classId);
        if (!c.active) revert ClassInactive();
        if (!warehouseRegistry.isActiveOperator(terms.warehouseId, msg.sender)) revert NotActiveWarehouseOperator();
        if (
            terms.grossGrams == 0 || terms.lotRefHash == bytes32(0) || terms.documentHash == bytes32(0)
                || terms.intakeDate == 0 || terms.intakeDate > block.timestamp
        ) revert InvalidTerms();

        bytes32 key = keccak256(abi.encode(terms.warehouseId, terms.lotRefHash));
        if (lotKeyUsed[key]) revert DuplicateLot();
        lotKeyUsed[key] = true;

        lotId = ++lotCount;
        Lot storage l = _lots[lotId];
        l.terms = terms;
        l.submitter = msg.sender;
        l.status = LotStatus.Pending;
        emit LotSubmitted(lotId, terms.classId, terms.warehouseId, terms.lotRefHash, terms.grossGrams, msg.sender);
    }

    /// @notice Stock auditor confirms the weight and that live monitoring is reporting.
    function attestLot(uint256 lotId, uint256 attestedGrams, bool monitoringOk, bytes32 attestationRef)
        external
        onlyRole(STOCK_AUDITOR_ROLE)
    {
        Lot storage l = _lot(lotId);
        if (l.status != LotStatus.Pending) revert InvalidLotState();
        if (msg.sender == l.submitter || msg.sender == warehouseRegistry.operatorOf(l.terms.warehouseId)) {
            revert ReviewerConflict();
        }
        if (attestedGrams == 0 || attestedGrams > l.terms.grossGrams || attestationRef == bytes32(0)) {
            revert InvalidTerms();
        }
        l.status = LotStatus.Attested;
        l.attester = msg.sender;
        l.attestedGrams = attestedGrams;
        l.monitoringOk = monitoringOk;
        l.attestationRef = attestationRef;
        emit LotAttested(lotId, attestedGrams, monitoringOk, attestationRef, msg.sender);
    }

    /// @notice Approve an attested lot and mint units to the class issuer.
    ///         Units issued = attested weight minus the class shrinkage buffer.
    function approveLot(uint256 lotId)
        external
        onlyRole(LISTING_REVIEWER_ROLE)
        whenNotPaused
        nonReentrant
        returns (uint256 issued)
    {
        Lot storage l = _lot(lotId);
        if (l.status != LotStatus.Attested) revert InvalidLotState();
        uint256 warehouseId = l.terms.warehouseId;
        if (
            msg.sender == l.submitter || msg.sender == l.attester
                || msg.sender == warehouseRegistry.operatorOf(warehouseId)
        ) revert ReviewerConflict();
        if (!warehouseRegistry.isActive(warehouseId)) revert WarehouseInactive();
        if (!l.monitoringOk) revert MonitoringNotReporting();

        uint256 classId = l.terms.classId;
        Class storage c = _classes[classId];
        if (!c.active) revert ClassInactive();
        if (!identityRegistry.isVerifiedEntity(c.issuer)) revert IssuerNotVerified();

        issued = Math.mulDiv(l.attestedGrams, BPS - c.shrinkageBps, BPS);
        if (issued == 0) revert InvalidAmount();

        l.status = LotStatus.Live;
        l.remainingGrams = l.attestedGrams;
        l.issuedLive = issued;
        c.backedGrams += l.attestedGrams;

        emit LotApproved(lotId, classId, issued, c.issuer, msg.sender);
        _mint(c.issuer, classId, issued, "");
    }

    function rejectLot(uint256 lotId, bytes32 reasonRef) external onlyRole(LISTING_REVIEWER_ROLE) {
        Lot storage l = _lot(lotId);
        if (l.status != LotStatus.Pending && l.status != LotStatus.Attested) revert InvalidLotState();
        l.status = LotStatus.Rejected;
        // The lot key stays used: a rejected intake reference cannot be recycled for a different lot.
        emit LotRejected(lotId, msg.sender, reasonRef);
    }

    function withdrawLot(uint256 lotId) external {
        Lot storage l = _lot(lotId);
        if (l.submitter != msg.sender) revert NotSubmitter();
        if (l.status != LotStatus.Pending && l.status != LotStatus.Attested) revert InvalidLotState();
        l.status = LotStatus.Withdrawn;
        emit LotWithdrawn(lotId);
    }

    // =====================================================================
    // Stock monitoring and shortfalls
    // =====================================================================

    /// @notice Record that a live lot's sensor feed stopped (or resumed). Stopping halts the class.
    function setMonitoring(uint256 lotId, bool ok) external onlyRole(STOCK_AUDITOR_ROLE) {
        Lot storage l = _lot(lotId);
        if (l.status != LotStatus.Live) revert InvalidLotState();
        if (l.monitoringOk == ok) revert NoChange();
        l.monitoringOk = ok;
        Class storage c = _classes[l.terms.classId];
        if (ok) {
            c.unmonitoredLots -= 1;
        } else {
            c.unmonitoredLots += 1;
            _halt(l.terms.classId, keccak256("MONITORING_LOST"));
        }
        emit MonitoringChanged(lotId, ok, msg.sender);
    }

    /// @notice Record that audited stock is lower than attested (spoilage, loss, theft).
    ///         The class halts if units outstanding now exceed the buffered stock.
    function reportShortfall(uint256 lotId, uint256 newRemainingGrams, bytes32 evidenceRef)
        external
        onlyRole(STOCK_AUDITOR_ROLE)
    {
        Lot storage l = _lot(lotId);
        if (l.status != LotStatus.Live) revert InvalidLotState();
        if (newRemainingGrams >= l.remainingGrams || evidenceRef == bytes32(0)) revert InvalidTerms();
        if (openSaleOfLot[lotId] != 0) revert OpenSaleExists();

        uint256 previous = l.remainingGrams;
        Class storage c = _classes[l.terms.classId];
        c.backedGrams -= (previous - newRemainingGrams);
        l.remainingGrams = newRemainingGrams;
        emit ShortfallReported(lotId, previous, newRemainingGrams, evidenceRef, msg.sender);

        if (totalSupply(l.terms.classId) > issuableGrams(l.terms.classId)) {
            _halt(l.terms.classId, keccak256("SHORTFALL"));
        }
    }

    // =====================================================================
    // Processor sale and retirement
    // =====================================================================

    /// @notice Propose selling `grams` of a lot to a processor. Fixes how many units must be retired.
    function proposeSale(uint256 lotId, uint256 grams, bytes32 saleRef)
        external
        onlyRole(CLASS_MANAGER_ROLE)
        returns (uint256 saleId)
    {
        Lot storage l = _lot(lotId);
        if (l.status != LotStatus.Live) revert InvalidLotState();
        if (grams == 0 || grams > l.remainingGrams || saleRef == bytes32(0)) revert InvalidAmount();
        if (openSaleOfLot[lotId] != 0) revert OpenSaleExists();

        // Proportional share of the lot's live units, rounded UP so the pool is never over-issued.
        uint256 units = grams == l.remainingGrams
            ? l.issuedLive
            : Math.mulDiv(l.issuedLive, grams, l.remainingGrams, Math.Rounding.Ceil);

        saleId = ++saleCount;
        _sales[saleId] = Sale({
            lotId: lotId,
            grams: grams,
            unitsToRetire: units,
            retired: 0,
            saleRef: saleRef,
            proposer: msg.sender,
            status: SaleStatus.Proposed
        });
        openSaleOfLot[lotId] = saleId;
        emit SaleProposed(saleId, lotId, grams, units, saleRef, msg.sender);
    }

    function approveSale(uint256 saleId) external onlyRole(LISTING_REVIEWER_ROLE) {
        Sale storage s = _sale(saleId);
        if (s.status != SaleStatus.Proposed) revert InvalidSaleState();
        if (msg.sender == s.proposer) revert ReviewerConflict();
        s.status = SaleStatus.Approved;
        emit SaleApproved(saleId, msg.sender);
    }

    /// @notice Cancel a sale before any unit has been retired for it.
    function cancelSale(uint256 saleId) external {
        if (!hasRole(CLASS_MANAGER_ROLE, msg.sender) && !hasRole(LISTING_REVIEWER_ROLE, msg.sender)) {
            revert AccessControlUnauthorizedAccount(msg.sender, CLASS_MANAGER_ROLE);
        }
        Sale storage s = _sale(saleId);
        if (s.status != SaleStatus.Proposed && s.status != SaleStatus.Approved) revert InvalidSaleState();
        if (s.retired != 0) revert InvalidSaleState();
        s.status = SaleStatus.Cancelled;
        openSaleOfLot[s.lotId] = 0;
        emit SaleCancelled(saleId, msg.sender);
    }

    /// @notice Burn units from holders for an approved sale. The allocation across holders is decided
    ///         off-chain; this enforces the total, and that each holder really has the units.
    ///         Can be called in several batches until `unitsToRetire` is reached.
    function retireForSale(uint256 saleId, address[] calldata holders, uint256[] calldata amounts)
        external
        onlyRole(RETIREMENT_OPERATOR_ROLE)
        nonReentrant
    {
        Sale storage s = _sale(saleId);
        if (s.status != SaleStatus.Approved) revert InvalidSaleState();
        if (holders.length != amounts.length || holders.length == 0) revert LengthMismatch();

        Lot storage l = _lots[s.lotId];
        uint256 classId = l.terms.classId;
        uint256 total;
        for (uint256 i = 0; i < holders.length; ++i) {
            if (amounts[i] == 0) revert InvalidAmount();
            total += amounts[i];
            _burn(holders[i], classId, amounts[i]);
            emit UnitsRetired(saleId, classId, holders[i], amounts[i]);
        }
        if (s.retired + total > s.unitsToRetire) revert ExceedsRetirementTarget();
        s.retired += total;

        if (s.retired == s.unitsToRetire) {
            s.status = SaleStatus.Completed;
            openSaleOfLot[s.lotId] = 0;
            l.issuedLive -= s.unitsToRetire;
            l.remainingGrams -= s.grams;
            _classes[classId].backedGrams -= s.grams;
            if (l.remainingGrams == 0) l.status = LotStatus.Depleted;
            emit SaleCompleted(saleId, s.lotId, s.grams, s.unitsToRetire);
        }
    }

    /// @notice After a reported shortfall, retire the units that stock no longer supports so the class can
    ///         resume. Strictly bounded: a lot can never lose more units than it is over-issued by, so this
    ///         cannot be used to burn backed units. Who bears the loss (holders, insurance, Kitovu) is
    ///         settled off-chain; this records and enforces the amounts.
    function retireUnbacked(uint256 lotId, address[] calldata holders, uint256[] calldata amounts, bytes32 evidenceRef)
        external
        onlyRole(RETIREMENT_OPERATOR_ROLE)
        nonReentrant
    {
        Lot storage l = _lot(lotId);
        if (l.status != LotStatus.Live) revert InvalidLotState();
        if (openSaleOfLot[lotId] != 0) revert OpenSaleExists();
        if (holders.length != amounts.length || holders.length == 0 || evidenceRef == bytes32(0)) {
            revert LengthMismatch();
        }

        uint256 classId = l.terms.classId;
        uint256 supported = Math.mulDiv(l.remainingGrams, BPS - _classes[classId].shrinkageBps, BPS);
        uint256 excess = l.issuedLive > supported ? l.issuedLive - supported : 0;

        uint256 total;
        for (uint256 i = 0; i < holders.length; ++i) {
            if (amounts[i] == 0) revert InvalidAmount();
            total += amounts[i];
            _burn(holders[i], classId, amounts[i]);
            emit UnbackedUnitsRetired(lotId, classId, holders[i], amounts[i], evidenceRef);
        }
        if (total > excess) revert ExceedsRetirementTarget();
        l.issuedLive -= total;
    }

    // =====================================================================
    // Holding fees (storage + insurance), collected in kind
    // =====================================================================

    /// @notice Move fee units from holders to the class fee collector. Each holder can be charged once
    ///         per 30-day period, and never more than the class `maxFeeBps` of their balance.
    function collectHoldingFee(uint256 classId, address[] calldata holders, uint256[] calldata amounts)
        external
        onlyRole(FEE_OPERATOR_ROLE)
        whenNotPaused
        nonReentrant
    {
        Class storage c = _class(classId);
        if (holders.length != amounts.length || holders.length == 0) revert LengthMismatch();

        uint64 period = uint64(block.timestamp / FEE_PERIOD);
        uint256[] memory ids = new uint256[](1);
        uint256[] memory vals = new uint256[](1);
        ids[0] = classId;

        _bypassChecks = true;
        for (uint256 i = 0; i < holders.length; ++i) {
            address h = holders[i];
            uint256 amt = amounts[i];
            if (amt == 0 || h == c.feeCollector) revert InvalidAmount();
            if (lastFeePeriod[classId][h] >= period) revert FeeAlreadyChargedThisPeriod(h);
            if (amt > Math.mulDiv(balanceOf(h, classId), c.maxFeeBps, BPS)) revert FeeExceedsCap(h);
            lastFeePeriod[classId][h] = period;
            vals[0] = amt;
            _update(h, c.feeCollector, ids, vals);
            emit HoldingFeeCharged(classId, h, amt, period);
        }
        _bypassChecks = false;
    }

    // =====================================================================
    // Global pause
    // =====================================================================

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
        // Ordinary transfers only. Minting, burning (retirement) and fee collection are separate paths.
        if (from != address(0) && to != address(0) && !_bypassChecks) {
            if (paused()) revert EnforcedPause();
            for (uint256 i = 0; i < ids.length; ++i) {
                if (_classes[ids[i]].halted) revert ClassIsHalted(ids[i]);
            }
            if (!identityRegistry.isVerified(from)) revert HolderNotVerified();
            if (!identityRegistry.isVerified(to)) revert HolderNotVerified();
        }
        super._update(from, to, ids, values);
    }

    // =====================================================================
    // Views
    // =====================================================================

    /// @notice Maximum units that live stock supports: remaining attested grams minus the buffer.
    function issuableGrams(uint256 classId) public view returns (uint256) {
        Class storage c = _class(classId);
        return Math.mulDiv(c.backedGrams, BPS - c.shrinkageBps, BPS);
    }

    /// @notice (backed stock in grams, issuable units, units outstanding, within backing?)
    function backing(uint256 classId)
        external
        view
        returns (uint256 backedGrams, uint256 issuable, uint256 outstanding, bool ok)
    {
        backedGrams = _class(classId).backedGrams;
        issuable = issuableGrams(classId);
        outstanding = totalSupply(classId);
        ok = outstanding <= issuable;
    }

    function getClass(uint256 classId) external view returns (Class memory) {
        return _class(classId);
    }

    function getLot(uint256 lotId) external view returns (Lot memory) {
        return _lot(lotId);
    }

    function getSale(uint256 saleId) external view returns (Sale memory) {
        return _sale(saleId);
    }

    /// @inheritdoc ITradableAsset
    function isTradable(uint256 classId) external view returns (bool) {
        Class storage c = _classes[classId];
        return c.issuer != address(0) && c.active && !c.halted && !paused() && totalSupply(classId) > 0;
    }

    function uri(uint256 classId) public view override returns (string memory) {
        return _classes[classId].metadataURI;
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC1155, AccessControlDefaultAdminRules)
        returns (bool)
    {
        return interfaceId == type(ITradableAsset).interfaceId || super.supportsInterface(interfaceId);
    }

    // =====================================================================
    // Internals
    // =====================================================================

    function _halt(uint256 classId, bytes32 reasonRef) private {
        Class storage c = _classes[classId];
        if (!c.halted) {
            c.halted = true;
            emit ClassHalted(classId, reasonRef, msg.sender);
        }
    }

    function _class(uint256 classId) private view returns (Class storage c) {
        c = _classes[classId];
        if (c.issuer == address(0)) revert UnknownClass();
    }

    function _lot(uint256 lotId) private view returns (Lot storage l) {
        l = _lots[lotId];
        if (l.status == LotStatus.None) revert UnknownLot();
    }

    function _sale(uint256 saleId) private view returns (Sale storage s) {
        s = _sales[saleId];
        if (s.status == SaleStatus.None) revert UnknownSale();
    }
}
