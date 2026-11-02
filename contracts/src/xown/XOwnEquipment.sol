// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";

/// @title XOwnEquipment
/// @notice One token per physical machine (tractor, dryer, …) offered through XOwn. Minted only by the
///         XOwn factory, straight into that machine's vault, and never transferable: it's the on-chain
///         anchor the vault's shares are claims against. Burned by the vault on dissolution.
contract XOwnEquipment is ERC721 {
    struct Equipment {
        bytes32 assetType;    // e.g. bytes32("TRACTOR")
        bytes32 serialHash;   // keccak256 of manufacturer serial / chassis number
        bytes32 documentHash; // hash of purchase invoice, insurance, SPV agreement
        string metadataURI;
    }

    address public immutable factory;
    uint256 public count;
    mapping(uint256 => Equipment) private _equipment;
    mapping(bytes32 => bool) public serialUsed;

    error OnlyFactory();
    error NonTransferable();
    error DuplicateSerial();

    constructor() ERC721("TradeChainX XOwn Equipment", "TCX-EQ") {
        factory = msg.sender;
    }

    function mint(address vault, Equipment calldata e) external returns (uint256 id) {
        if (msg.sender != factory) revert OnlyFactory();
        if (serialUsed[e.serialHash]) revert DuplicateSerial();
        serialUsed[e.serialHash] = true;
        id = ++count;
        _equipment[id] = e;
        _mint(vault, id);
    }

    /// @notice The vault holding the machine burns it when the offering is dissolved.
    function burn(uint256 id) external {
        if (ownerOf(id) != msg.sender) revert NonTransferable();
        _burn(id);
    }

    function getEquipment(uint256 id) external view returns (Equipment memory) {
        return _equipment[id];
    }

    function tokenURI(uint256 id) public view override returns (string memory) {
        _requireOwned(id);
        return _equipment[id].metadataURI;
    }

    function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
        address from = _ownerOf(tokenId);
        if (from != address(0) && to != address(0)) revert NonTransferable();
        return super._update(to, tokenId, auth);
    }
}
