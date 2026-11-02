// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts/interfaces/IERC2981.sol";
 
interface IAssetMetadata {
    function burnFromMarketplace(uint256 tokenId) external;
    function burnFromMarketplace(uint256 tokenId, uint256 amount) external;
    function getAssetMetadata(uint256 tokenId) external view returns (uint256 issuedTime,uint256 expiryTime,uint256 basePrice);
}

contract MarketplaceUpgradeable is Initializable, ReentrancyGuardUpgradeable, OwnableUpgradeable, UUPSUpgradeable {
    IERC20 public txcToken;
    uint256 public listingCount;

    enum TokenType { Warehouse, LPO, Carbon }

    // Struct to represent a listing
    struct Listing {
        address seller;
        address nftContract;
        uint256 tokenId;
        uint256 amount;
        uint256 price;
        bool isActive;
        bool isERC1155;
        TokenType tokenType;
        bool forSale; // true = Sell/Buy listing, false = staking
    }

    struct EscrowInfo {
        address buyer;
        address seller;
        address nftContract;
        uint256 tokenId;
        address arbitrator;
        uint256 totalAmount;     // Total amount sent by buyer
        uint256 royaltyAmount;   // Royalties deducted
        address royaltyRecipient;
        uint256 sellerAmount;    // Seller's portion after royalties
        EscrowStatus status;
        uint256 approvalCount;
        mapping(address => bool) approvals;
        bool resolved;
    }


    // Mapping of listings by listing ID
    mapping(uint256 => Listing) public listings;
    mapping(uint256 => EscrowInfo) public escrows;
    mapping(address => uint256) private userEscrowedAmount;
    // Mapping to track escrows for each user
    mapping(address => uint256[]) private userEscrows;
    mapping(address => mapping(uint256 => bool)) public isNFTListedBefore;

    uint256 public escrowCount;
    address public arbitrator;
    uint256 private totalEscrowedAmount;
    bool public isEscrowActive;

    uint256 public listingFees;      // e.g., 150 = 1.5%
    uint256 public resaleFees;       // e.g., 200 = 2%
    uint256 public liquidationFees;  // e.g., 50 = 0.5%
    address public feeCollector;       // where collected fees go

    // Events
    event ListingCancelled(uint256 indexed listingId);
    event RoyaltyPaid(uint256 indexed listingId, address indexed recipient, uint256 amount);
    event NFTSold(uint256 indexed listingId, address indexed buyer, address indexed seller, uint256 price);
    event ListingCreated(uint256 indexed listingId, address indexed seller, address nftContract, uint256 tokenId, uint256 price);
    event AssetLiquidated(address indexed assetContract, uint256 indexed tokenId, uint256 time, uint256 basePrice, uint256 finalPrice);

    event EscrowCreated(uint256 indexed escrowId, address indexed buyer, address indexed seller, uint256 amount);
    event EscrowApproved(uint256 indexed escrowId, address indexed approver);
    event EscrowRoyaltyPaid(uint256 indexed escrowId, address indexed recipient, uint256 amount);
    event EscrowReleased(uint256 indexed escrowId, address indexed recipient, uint256 amount);

    enum EscrowStatus { Pending, Completed, Canceled }

    // Initializer (replaces constructor)
    function initialize(address _txcToken, address admin) public initializer {
        __ReentrancyGuard_init();
        __Ownable_init(admin);
        txcToken = IERC20(_txcToken);
        listingFees = 150;
        resaleFees = 200;
        liquidationFees = 50;
        feeCollector = msg.sender;
    }

    function setTXCToken(address newToken) external onlyOwner {
        require(newToken != address(0), "Invalid token address");
        txcToken = IERC20(newToken);
    }

    function updateIsEscrowActive(bool _status) external onlyOwner() {
        isEscrowActive = _status;
    }

    function setArbitrator(address _arbitrator) external onlyOwner {
        require(_arbitrator != address(0), "Invalid arbitrator address");
        arbitrator = _arbitrator;
    }

    function setFees(
        uint256 _listingFees,
        uint256 _resaleFees,
        uint256 _liquidationFees
    ) external onlyOwner {
        require(_listingFees <= 10000, "Max 100%");
        require(_resaleFees <= 10000, "Max 100%");
        require(_liquidationFees <= 10000, "Max 100%");
        listingFees = _listingFees;
        resaleFees = _resaleFees;
        liquidationFees = _liquidationFees;
    }

    function setFeeCollector(address _collector) external onlyOwner {
        require(_collector != address(0), "Invalid address");
        feeCollector = _collector;
    }

    function withdrawTokens(address to, uint256 amount) external onlyOwner {
        require(to != address(0), "Invalid address");
        require(txcToken.balanceOf(address(this)) >= amount, "Insufficient available balance");

        require(txcToken.transfer(to, amount), "Transfer failed");
    }

    // Royalty Calculation (ERC-2981 compatible)
    function calculateRoyalty(address nftContract, uint256 tokenId, uint256 salePrice) internal view returns (address, uint256) {
        try IERC2981(nftContract).royaltyInfo(tokenId, salePrice) returns (address recipient, uint256 amount) {
            return (recipient, amount);
        } catch {
            return (address(0), 0);
        }
    }

    // List an NFT for sale
    function createListing(address nftContract, uint256 tokenId, uint256 amount, uint256 price, TokenType tokenType, bool _forSale) external nonReentrant returns (uint256) {
        require(price > 0, "Price must be greater than 0");

        bool isERC1155 = isERC1155Contract(nftContract); // Check if the contract is ERC1155
        bool isERC721 = isERC721Contract(nftContract);  // Check if the contract is ERC721

        require(isERC1155 || isERC721, "NFT contract is neither ERC1155 nor ERC721");

        // Get metadata from the asset contract
        (uint256 issuedTime,uint256 expiryTime,) = IAssetMetadata(nftContract).getAssetMetadata(tokenId);

        // Check expiry
        uint256 itemExpireTime = issuedTime + expiryTime;
        require(block.timestamp < itemExpireTime, "Item expired and must be liquidated");

        if (isERC1155) {
            require(IERC1155(nftContract).balanceOf(msg.sender, tokenId) >= amount, "Insufficient token balance");
            require(IERC1155(nftContract).isApprovedForAll(msg.sender, address(this)), "Marketplace not approved");
        } else {
            require(IERC721(nftContract).ownerOf(tokenId) == msg.sender, "Not token owner");
            require(
                IERC721(nftContract).getApproved(tokenId) == address(this) ||
                IERC721(nftContract).isApprovedForAll(msg.sender, address(this)),
                "Marketplace not approved"
            );
        }

         //Apply fee if NFT was listed before
        if (isNFTListedBefore[nftContract][tokenId]) {
            if (listingFees > 0) {
                uint256 listingFee = _calculateFee(price, listingFees);
                address feesReceiver = feeCollector != address(0) ? feeCollector : address(this);
                require(txcToken.allowance(msg.sender, address(this)) >= listingFee, "Insufficient allowance for listing fee");
                require(txcToken.transferFrom(msg.sender, feesReceiver, listingFee), "Listing fee transfer failed");
            }
        } else {
            isNFTListedBefore[nftContract][tokenId] = true;
        }

        listingCount++;
        listings[listingCount] = Listing({
            seller: msg.sender,
            nftContract: nftContract,
            tokenId: tokenId,
            amount: amount,
            price: price,
            isActive: true,
            isERC1155: isERC1155,
            tokenType: tokenType,
            forSale: _forSale
        });

        emit ListingCreated(listingCount, msg.sender, nftContract, tokenId, price);
        return listingCount;
    }

    // Cancel a listing
    function cancelListing(uint256 listingId) external nonReentrant {
        Listing storage listing = listings[listingId];
        require(listing.isActive, "Listing not active");
        require(listing.seller == msg.sender || msg.sender == owner(), "Not seller or admin");

        listing.isActive = false;
        emit ListingCancelled(listingId);
    }

    // Buy an NFT
    function buy(uint256 listingId, uint256 quantity) external nonReentrant {
        Listing storage listing = listings[listingId];
        require(listing.isActive, "Listing not active");
        require(listing.forSale, "Item is not for sale");

        require(quantity > 0, "Quantity must be greater than 0");

        // Get metadata from the asset contract
        (uint256 issuedTime ,uint256 expiryTime,) = IAssetMetadata(listing.nftContract).getAssetMetadata(listing.tokenId);

        // Check expiry
        uint256 itemExpireTime = issuedTime + expiryTime;
        require(block.timestamp < itemExpireTime, "Item expired and must be liquidated");

        uint256 totalPrice;

        if (listing.isERC1155) {
            require(quantity <= listing.amount, "Not enough quantity available");
            totalPrice = listing.price * quantity;
        } else {
            require(quantity == 1, "ERC721 only supports quantity of 1");
            totalPrice = listing.price;
        }
        uint256 platformFee = _calculateFee(totalPrice, resaleFees);

        // Calculate royalty
        (address royaltyRecipient, uint256 royaltyAmount) = calculateRoyalty(listing.nftContract, listing.tokenId, totalPrice);

        // Ensure the buyer has enough allowance and balance
        require(txcToken.allowance(msg.sender, address(this)) >= totalPrice + platformFee, "Insufficient allowance");
        require(txcToken.balanceOf(msg.sender) >= totalPrice + platformFee, "Insufficient balance");

        // Transfer NFT to buyer
        if (listing.isERC1155) {
            IERC1155(listing.nftContract).safeTransferFrom(listing.seller, msg.sender, listing.tokenId, quantity, "");
            listing.amount -= quantity;
            if (listing.amount == 0) {
                listing.isActive = false;
            }
        } else {
            IERC721(listing.nftContract).safeTransferFrom(listing.seller, msg.sender, listing.tokenId);
            listing.isActive = false;
        }

        // Platform Fees
        if (platformFee > 0) {
            address feesReceiver = feeCollector != address(0) ? feeCollector : address(this);
            require(txcToken.transferFrom(msg.sender, feesReceiver, platformFee), "Fee transfer failed");
        }

        if (isEscrowActive) {
            require(txcToken.transferFrom(msg.sender, address(this), totalPrice), "Escrow transfer failed");
            _createEscrow(msg.sender, listing.seller, listing.nftContract, listing.tokenId, totalPrice, royaltyAmount, royaltyRecipient);
        } else {
            if (royaltyAmount > 0 && royaltyRecipient != address(0)) {
                require(txcToken.transferFrom(msg.sender, royaltyRecipient, royaltyAmount), "Royalty transfer failed");
                emit RoyaltyPaid(listingId, royaltyRecipient, royaltyAmount);
            }

            uint256 sellerAmount = totalPrice - royaltyAmount;
            require(txcToken.transferFrom(msg.sender, listing.seller, sellerAmount), "Seller payment failed");
        }

        emit NFTSold(listingId, msg.sender, listing.seller, totalPrice);
    }

    function liquidate(uint256 listingId) external nonReentrant {
        Listing storage listing = listings[listingId];
        require(listing.isActive, "Listing not active");

        (uint256 issuedTime, uint256 expiryTime, uint256 basePrice) = IAssetMetadata(listing.nftContract).getAssetMetadata(listing.tokenId);
        uint256 itemExpireTime = issuedTime + expiryTime;
        require(block.timestamp >= itemExpireTime, "Asset not expired yet");

        uint256 finalPrice;

        if (listing.tokenType == TokenType.Warehouse) {
            finalPrice = basePrice + ((basePrice * 30) / 100); // Fixed 30% gain
        } else if (listing.tokenType == TokenType.LPO) {
            finalPrice = basePrice + ((basePrice * 4) / 100); // Fixed 4% gain
        } else if (listing.tokenType == TokenType.Carbon) {
            uint256 monthsElapsed = 24; // Fixed duration
            finalPrice = basePrice;
            for (uint256 i = 0; i < monthsElapsed; i++) {
                finalPrice = (finalPrice * 1035) / 1000; // Compound 3.5% monthly
            }
        }

        if(listing.tokenType==TokenType.Carbon){
            require(
            IERC1155(listing.nftContract).balanceOf(listing.seller, listing.tokenId) >= listing.amount,
            "Seller no longer owns the tokens"
            );
            IAssetMetadata(listing.nftContract).burnFromMarketplace(listing.tokenId, listing.amount);
        }else{
           require(
            IERC721(listing.nftContract).ownerOf(listing.tokenId) == listing.seller,
            "Seller no longer owns the token"
            );
            IAssetMetadata(listing.nftContract).burnFromMarketplace(listing.tokenId);
        }

        uint256 liquidationFee = _calculateFee(finalPrice, liquidationFees);
        if(liquidationFee > 0){
           if(feeCollector != address(0)) require(txcToken.transfer(feeCollector, liquidationFee), "Fee transfer failed");
        }

        require(txcToken.transfer(listing.seller, finalPrice-liquidationFee), "Token transfer failed");
        listing.isActive = false;

        emit AssetLiquidated(listing.nftContract, listing.tokenId, block.timestamp, basePrice, finalPrice);
    }

    function isExpired(uint256 listingId) public view returns (bool) {
        Listing memory listing = listings[listingId];

        (uint256 issuedTime, uint256 expiryTime,) = IAssetMetadata(listing.nftContract).getAssetMetadata(listing.tokenId);
        return block.timestamp >= issuedTime + expiryTime;
    }

    // Get listing details
    function getListing(uint256 listingId) external view returns (address, address, uint256, uint256, uint256, bool, bool) {
        Listing storage listing = listings[listingId];
        return (
            listing.seller,
            listing.nftContract,
            listing.tokenId,
            listing.amount,
            listing.price,
            listing.isActive,
            listing.isERC1155
        );
    }

    function _createEscrow(
        address buyer,
        address seller,
        address nftContract,
        uint256 tokenId,
        uint256 price,
        uint256 royaltyAmount,
        address royaltyRecipient
    ) internal {
        escrowCount++;
        EscrowInfo storage escrow = escrows[escrowCount];
        escrow.buyer = buyer;
        escrow.seller = seller;
        escrow.nftContract = nftContract;
        escrow.tokenId = tokenId;
        escrow.totalAmount = price;
        escrow.royaltyAmount = royaltyAmount;
        escrow.royaltyRecipient = royaltyRecipient;
        escrow.sellerAmount = price - royaltyAmount;
        escrow.arbitrator = arbitrator;
        escrow.status = EscrowStatus.Pending;

        totalEscrowedAmount += price;
        userEscrowedAmount[buyer] += price;

        // Associate the escrow ID with the buyer and seller
        userEscrows[buyer].push(escrowCount);
        userEscrows[seller].push(escrowCount);

        emit EscrowCreated(escrowCount, buyer, seller, price);
    }

    function approveAndReleaseEscrow(uint256 escrowId) external nonReentrant {
        EscrowInfo storage escrow = escrows[escrowId];
        require(escrow.status == EscrowStatus.Pending, "Invalid status");
        require(!escrow.resolved, "Already resolved");
        require(msg.sender == escrow.buyer || msg.sender == escrow.seller || msg.sender == escrow.arbitrator, "Not authorized");
        require(!escrow.approvals[msg.sender], "Already approved");

        escrow.approvals[msg.sender] = true;
        escrow.approvalCount++;
        emit EscrowApproved(escrowId, msg.sender);

        if (escrow.approvalCount >= 2) {
            escrow.status = EscrowStatus.Completed;
            escrow.resolved = true;

            totalEscrowedAmount -= escrow.totalAmount;
            userEscrowedAmount[escrow.buyer] -= escrow.totalAmount;

            if (escrow.royaltyAmount > 0 && escrow.royaltyRecipient != address(0)) {
                require(txcToken.transfer(escrow.royaltyRecipient, escrow.royaltyAmount), "Royalty transfer failed");
                emit EscrowReleased(escrowId, escrow.royaltyRecipient, escrow.royaltyAmount);
            }

            require(txcToken.transfer(escrow.seller, escrow.sellerAmount), "Seller payment failed");
            emit EscrowReleased(escrowId, escrow.seller, escrow.sellerAmount);
        }
    }

    function getEscrow(uint256 escrowId) external view returns (
        address buyer,
        address seller,
        address nftContract,
        uint256 tokenId,
        uint256 totalAmount,
        uint256 royaltyAmount,
        uint256 sellerAmount,
        address arb,
        EscrowStatus status,
        uint256 approvalCount,
        bool resolved
    ) {
        EscrowInfo storage e = escrows[escrowId];
        return (
            e.buyer,
            e.seller,
            e.nftContract,
            e.tokenId,
            e.totalAmount,
            e.royaltyAmount,
            e.sellerAmount,
            e.arbitrator,
            e.status,
            e.approvalCount,
            e.resolved
        );
    }

    function _calculateFee(uint256 amount, uint256 bps) internal pure returns (uint256) {
        return (amount * bps) / 10000;
    }

    function hasApproved(uint256 escrowId, address user) external view returns (bool) {
        return escrows[escrowId].approvals[user];
    }

    function getTotalEscrowedAmount() external view returns (uint256) {
        return totalEscrowedAmount;
    }

    function getUserEscrowedAmount(address user) external view returns (uint256) {
        return userEscrowedAmount[user];
    }

    function getUserEscrows(address user) external view returns (uint256[] memory) {
        return userEscrows[user];
    }

    // Add a function to check the type of NFT contract
    function isERC1155Contract(address nftContract) public view returns (bool) {
        return IERC165(nftContract).supportsInterface(type(IERC1155).interfaceId);
    }

    function isERC721Contract(address nftContract) public view returns (bool) {
        return IERC165(nftContract).supportsInterface(type(IERC721).interfaceId);
    }

    /// @dev Required by UUPS upgradeability.
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}
}
