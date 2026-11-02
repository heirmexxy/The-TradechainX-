// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import {ERC1155Pausable} from "@openzeppelin/contracts/token/ERC1155/extensions/ERC1155Pausable.sol";
import {ERC1155Supply} from "@openzeppelin/contracts/token/ERC1155/extensions/ERC1155Supply.sol";
import "@openzeppelin/contracts/token/ERC1155/utils/ERC1155Holder.sol";

abstract contract ReentrancyGuard {
    uint256 private constant _NOT_ENTERED = 1;
    uint256 private constant _ENTERED = 2;

    uint256 private _status;

    constructor() {
        _status = _NOT_ENTERED;
    }

    /**
     * @dev Prevents a contract from calling itself, directly or indirectly.
     */
    modifier nonReentrant() {
        // On the first call to nonReentrant, _notEntered will be true
        require(_status != _ENTERED, "ReentrancyGuard: reentrant call");

        // Any calls to nonReentrant after this point will fail
        _status = _ENTERED;

        _;

        // By storing the original value once again, a refund is triggered (see
        // https://eips.ethereum.org/EIPS/eip-2200)
        _status = _NOT_ENTERED;
    }
}

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 value) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
}

contract XOwnAssetManager is ERC1155, Ownable, ERC1155Pausable, ERC1155Supply, ERC1155Holder, ReentrancyGuard {
    uint256 public nextAssetId = 1;
    IERC20 public txcToken;
    uint256 public sellFeeBP = 200; // 200 basis points = 2%    

    struct Asset {
        string metadataURI;
        uint256 totalSupply;
        uint256 pricePerUnit;
        bool matured;
        uint256 totalYield; // total yield available for distribution
        uint256 maturityTimestamp;  // 🔹 Optional: defined at listing
        uint256 durationInMonths;      // ⬅ total months
       uint256 monthsDistributed;     // ⬅ discributed month
    }

    struct User {
        uint256 depositTime;
        uint256 lastClaimedTime;
        uint256 totalYield; // total yield claimed by user
        uint256 redeemed;     // ⬅ total redeems available
        uint256 lastRedeemed;     // ⬅ total redeems available
    }

    mapping(uint256 => Asset) public assets;
    mapping (uint256 => mapping (address => User)) public users;
    mapping(uint256 => mapping(uint256 => mapping(address => bool))) public claimedPeriod;
    mapping(uint256 => uint256) public lastDistribution; // assetId => ⬅ last distribution

    constructor(address tokenAddress) Ownable(msg.sender) ERC1155("") {
        txcToken = IERC20(tokenAddress);
    }

    event AssetCreated(uint256 indexed assetId, uint256 supply, uint256 pricePerUnit);
    event Investment(address indexed investor, uint256 indexed assetId, uint256 units);
    event YieldDistributed(uint256 indexed assetId, uint256 totalYield);
    event YieldClaimed(address indexed user, uint256 indexed assetId, uint256 amount);
    event AssetMatured(uint256 indexed assetId);
    event Redemption(address indexed user, uint256 indexed assetId, uint256 payout);
    event SharesSold(address indexed user, uint256 indexed assetId, uint256 units, uint256 grossPayout, uint256 fee);

    function pause() public onlyOwner {
        _pause();
    }

    function unpause() public onlyOwner {
        _unpause();
    }

    function createAsset(
        uint256 supply,
        uint256 pricePerUnit,
        string memory metadataURI,
        uint256 maturityTimestamp,
        uint256 durationInMonths
    ) external onlyOwner returns (uint256) {
        require(maturityTimestamp > block.timestamp, "Maturity timestamp must be in the future");
        require(durationInMonths > 0, "Duration must be greater than zero");
        uint256 assetId = nextAssetId++;
        _mint(address(this), assetId, supply, "");
        assets[assetId] = Asset(metadataURI, supply, pricePerUnit, false, 0, maturityTimestamp,durationInMonths,0);

        emit AssetCreated(assetId, supply, pricePerUnit);
        return assetId;
    }

    function invest(uint256 assetId, uint256 units) external  {
        Asset storage asset = assets[assetId];
        require(!asset.matured, "Asset matured");
        require(units > 0, "Invalid units");
        User storage user = users[assetId][msg.sender];
        uint256 availableUnits = balanceOf(address(this), assetId);
        require(availableUnits >= units, "Not enough units available");
        uint256 totalAmount = units * asset.pricePerUnit;
        txcToken.transferFrom(msg.sender, address(this), totalAmount);
        user.depositTime = block.timestamp;
        user.lastClaimedTime = block.timestamp;

        _safeTransferFrom(address(this), msg.sender, assetId, units, "");

        emit Investment(msg.sender, assetId, units);
    }

    function distributeYield(uint256 assetId, uint256 amount) external onlyOwner {
        Asset storage asset = assets[assetId];
        require(asset.monthsDistributed < asset.durationInMonths, "All months distributed");
        require(block.timestamp >= lastDistribution[assetId], "Too early");
        require(amount > 0, "No Amount sent");
        // txcToken.transferFrom(msg.sender, address(this), amount);
        assets[assetId].totalYield += amount;
        asset.monthsDistributed += 1;
        lastDistribution[assetId] = block.timestamp;

        emit YieldDistributed(assetId, amount);
    }

    function sellShares(uint256 assetId, uint256 units) external nonReentrant {
        require(units > 0, "Invalid units");

        Asset storage asset = assets[assetId];
        require(!asset.matured, "Cannot sell matured asset");

        // Check user's balance
        require(balanceOf(msg.sender, assetId) >= units, "Insufficient share balance");

        // Calculate payout and fee
        uint256 grossPayout = units * asset.pricePerUnit;
        uint256 fee = (grossPayout * sellFeeBP) / 10000;
        uint256 netPayout = grossPayout - fee;

        require(txcToken.balanceOf(address(this)) >= netPayout, "Contract has insufficient balance");

        // Transfer tokens back to contract
        safeTransferFrom(msg.sender, address(this), assetId, units, "");
        txcToken.transfer(msg.sender, netPayout);

        emit SharesSold(msg.sender, assetId, units, grossPayout, fee);
    }

    function claimYield(uint256 assetId) external nonReentrant {
        Asset memory asset = assets[assetId];
        uint256 userBalance = balanceOf(msg.sender, assetId);
        require(userBalance > 0, "No tokens");
        require(!claimedPeriod[assetId][asset.monthsDistributed][msg.sender], "Already claimed");
        User storage user = users[assetId][msg.sender];
        // uint256 nowTime = block.timestamp;
        // uint256 userHeldTime = nowTime - user.lastClaimedTime;

        uint256 userShare = (asset.totalYield * userBalance) / asset.totalSupply;
        uint256 alreadyClaimed = user.totalYield;
        uint256 claimable = userShare - alreadyClaimed;

        require(claimable > 0, "Nothing to claim");

        user.totalYield += claimable;
        user.lastClaimedTime = block.timestamp;
        txcToken.transfer(msg.sender, claimable);
        claimedPeriod[assetId][asset.monthsDistributed][msg.sender] = true;
        emit YieldClaimed(msg.sender, assetId, claimable);
    }

    function markAssetAsMatured(uint256 assetId) external onlyOwner {
        Asset storage asset = assets[assetId];
        require(!asset.matured, "Already matured");
        require(block.timestamp >= asset.maturityTimestamp, "Not matured yet");
        asset.matured = true;
        emit AssetMatured(assetId);
    }

    function redeem(uint256 assetId) external nonReentrant {
        Asset memory asset = assets[assetId];
        require(asset.matured, "Asset not matured");

        uint256 balance = balanceOf(msg.sender, assetId);
        require(balance > 0, "No tokens to redeem");

        uint256 payout = balance * asset.pricePerUnit;

        _burn(msg.sender, assetId, balance);
        txcToken.transfer(msg.sender, payout);

        emit Redemption(msg.sender, assetId, payout);
    }

    function uri(uint256 assetId) public view override returns (string memory) {
        return assets[assetId].metadataURI;
    }

        // Overriding supportsInterface
    function supportsInterface(
        bytes4 interfaceId
    )
        public
        view
        virtual
        override(ERC1155, ERC1155Holder)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }

    // The following functions are overrides required by Solidity.
    function _update(address from, address to, uint256[] memory ids, uint256[] memory values)
        internal
        override(ERC1155, ERC1155Pausable, ERC1155Supply)
    {
        super._update(from, to, ids, values);
    }

    function withdrawTokens(address token) external onlyOwner {
        uint256 amount = IERC20(token).balanceOf(address(this));
        require(amount > 0, "Nothing to withdraw");
        IERC20(token).transfer(msg.sender, amount);
    }

    function setSellFeeBP(uint256 _sellFeeBP) external onlyOwner {
        require(_sellFeeBP <= 1000, "Fee too high"); // max 10%
        sellFeeBP = _sellFeeBP;
    }
}
