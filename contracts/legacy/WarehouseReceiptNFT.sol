// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/token/ERC721/extensions/ERC721EnumerableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC721/extensions/ERC721URIStorageUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/common/ERC2981Upgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract WarehouseReceiptNFT is Initializable, ERC721EnumerableUpgradeable, ERC721URIStorageUpgradeable, OwnableUpgradeable, UUPSUpgradeable, ERC2981Upgradeable {
    IERC20 public txcToken;
    uint256 private _tokenIdCounter;
    uint256 private _submissionCounter;

    enum Status { Pending, Approved, Rejected }

    struct ReceiptSubmission {
        address submitter;
        uint256 quantity;
        string uri;
        Status status;
        address verifiedBy;
        bool isUsed;
        uint256 basePrice;
    }

    struct AssetMetadata {
        uint256 issuedTime;
        uint256 expiryTime;
        uint256 basePrice;
    }

    mapping(uint256 => ReceiptSubmission) public submissions;
    mapping(uint256 => AssetMetadata) public assetMetadata;
    uint256[] private _pendingSubmissionIds;
    uint256[] private _approvedSubmissionIds;
    uint256[] private _rejectedSubmissionIds;
    address public approvedMarketplace;
    uint256 public expireTime;
    uint256 public mintingFees;

    event ReceiptSubmitted(uint256 indexed submissionId, address indexed submitter, uint256 quantity, string uri);
    event SubmissionApproved(uint256 indexed submissionId, address indexed submitter, address indexed verifiedBy);
    event SubmissionRejected(uint256 indexed submissionId, address indexed submitter);
    event ReceiptMinted(uint256 indexed tokenId, uint256 indexed submissionId, address indexed owner, string uri);
    event MintingFeeUpdated(uint256 previousFees, uint256 newFee);
    event MintingFeePaid(address indexed user, uint256 amount);

    function initialize(address admin) public initializer {
        __ERC721_init("Warehouse Receipt NFT", "WRNFT");
        __ERC721URIStorage_init();
        __ERC2981_init();
        __Ownable_init(admin);
        transferOwnership(admin);
        _tokenIdCounter = 0;
        _submissionCounter = 0;
        expireTime = 180 days;
    }

    modifier onlyAdminOrMarketplace() {
        require(
            msg.sender == owner() || msg.sender == approvedMarketplace,
            "Not admin or marketplace"
        );
        _;
   }

    function setTXCToken(address newToken) external onlyOwner {
        require(newToken != address(0), "Invalid token address");
        txcToken = IERC20(newToken);
    }

    function setApprovedMarketplace(address _marketplace) external onlyOwner {
        approvedMarketplace = _marketplace;
    }
    function setItemExpireTime(uint256 _expireTime) external onlyOwner {
        expireTime = _expireTime;
    }

    function setMintingFees(uint256 fee) external onlyOwner {
        emit MintingFeeUpdated(mintingFees, fee);
        mintingFees = fee;
    }

    function submitReceiptDetails(uint256 quantity, string memory uri, uint256 _basePrice) external {
        require(quantity > 0, "Quantity must be greater than 0");
        require(bytes(uri).length > 0, "URI cannot be empty");
        require(_basePrice > 0, "Base Price Must be greater then 0");

        _submissionCounter++;
        submissions[_submissionCounter] = ReceiptSubmission({
            submitter: msg.sender,
            quantity: quantity,
            uri: uri,
            status: Status.Pending,
            verifiedBy: address(0),
            isUsed: false,
            basePrice: _basePrice
        });

        _pendingSubmissionIds.push(_submissionCounter);

        emit ReceiptSubmitted(_submissionCounter, msg.sender, quantity, uri);
    }

    function processSubmission(uint256 submissionId, bool approve) external onlyOwner {
        ReceiptSubmission storage submission = submissions[submissionId];
        require(submission.submitter != address(0), "Submission does not exist");
        require(submission.status == Status.Pending, "Submission already processed");

        _removeFromPending(submissionId);

        if (approve) {
            submission.status = Status.Approved;
            submission.verifiedBy = msg.sender;
            _approvedSubmissionIds.push(submissionId);
            emit SubmissionApproved(submissionId, submission.submitter, msg.sender);
        } else {
            submission.status = Status.Rejected;
            _rejectedSubmissionIds.push(submissionId);
            emit SubmissionRejected(submissionId, submission.submitter);
        }
    }

    function mint(uint256 submissionId) external returns (uint256) {
        ReceiptSubmission storage submission = submissions[submissionId];
        require(submission.submitter == msg.sender, "Not submission owner");
        require(submission.status == Status.Approved, "Submission not approved");
        require(!submission.isUsed, "Submission already used");

        _tokenIdCounter++;
        uint256 newTokenId = _tokenIdCounter;
        submission.isUsed = true;
        _mint(msg.sender, newTokenId);
        _setTokenURI(newTokenId, submission.uri);
        emit ReceiptMinted(newTokenId, submissionId, msg.sender, submission.uri);

        assetMetadata[newTokenId] = AssetMetadata({
            basePrice: submission.basePrice,
            issuedTime: block.timestamp,
            expiryTime: block.timestamp + expireTime
        });

        if (mintingFees > 0) {
            require(txcToken.allowance(msg.sender, address(this)) >= mintingFees, "Insufficient allowance");
            require(txcToken.balanceOf(msg.sender) >= mintingFees, "Insufficient balance");
            txcToken.transferFrom(msg.sender, owner(), mintingFees);
            
            emit MintingFeePaid(msg.sender, mintingFees);
        }

        return newTokenId;
    }

    function burnFromMarketplace(uint256 tokenId) external onlyAdminOrMarketplace {
        _burn(tokenId);
    }

    // Set royalties for the token
    function setRoyalties(uint256 tokenId, address receiver, uint96 feeNumerator) external onlyOwner {
        _setTokenRoyalty(tokenId, receiver, feeNumerator);
    }

    function setDefaultRoyalty(address royaltyReceiver, uint96 royaltyFee) public onlyOwner {
        _setDefaultRoyalty(royaltyReceiver, royaltyFee);
    }

    function getApprovedSubmissionIds() external view returns (uint256[] memory) {
        return _approvedSubmissionIds;
    }

    function getPendingSubmissionIds() external view returns (uint256[] memory) {
        return _pendingSubmissionIds;
    }

    function getRejectedSubmissionIds() external view returns (uint256[] memory) {
        return _rejectedSubmissionIds;
    }

    function _removeFromPending(uint256 submissionId) internal {
        for (uint256 i = 0; i < _pendingSubmissionIds.length; i++) {
            if (_pendingSubmissionIds[i] == submissionId) {
                _pendingSubmissionIds[i] = _pendingSubmissionIds[_pendingSubmissionIds.length - 1];
                _pendingSubmissionIds.pop();
                break;
            }
        }
    }

    // Overriding _increaseBalance
    function _increaseBalance(address account, uint128 value) internal override(ERC721EnumerableUpgradeable,ERC721Upgradeable) {
        super._increaseBalance(account, value); // Call the base implementation
    }

    // Overriding _update
    function _update(address to, uint256 tokenId, address auth) internal override(ERC721EnumerableUpgradeable, ERC721Upgradeable) returns (address) {
        return super._update(to, tokenId, auth);
    }

    // Overriding supportsInterface
    function supportsInterface(bytes4 interfaceId) public view virtual override(ERC721EnumerableUpgradeable, ERC721URIStorageUpgradeable, ERC2981Upgradeable) returns (bool) {
        return super.supportsInterface(interfaceId);
    }

    // Overriding tokenURI
    function tokenURI(uint256 tokenId) public view virtual override(ERC721URIStorageUpgradeable, ERC721Upgradeable) returns (string memory) {
        return super.tokenURI(tokenId);
    }

    function getAssetMetadata(uint256 tokenId) external view returns (uint256 issuedTime,uint256 expiryTime,uint256 basePrice) {
        AssetMetadata memory meta = assetMetadata[tokenId];
        return (
            meta.issuedTime,
            meta.expiryTime,
            meta.basePrice
        );
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}
}
