// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

contract TXCToken is Initializable, ERC20Upgradeable, OwnableUpgradeable, UUPSUpgradeable {

    function initialize(address initialOwner) public initializer {
        __ERC20_init("TXC Token", "TXC");
        __Ownable_init(initialOwner);
        _mint(initialOwner, 1000000 * 10 ** decimals());
        transferOwnership(initialOwner);
    }

    // Admin can mint additional tokens
    function mint(address to, uint256 amount) external onlyOwner {
        require(amount > 0, "Amount must be greater than zero");
        _mint(to, amount);
    }

    // Admin can burn tokens
    function burn(uint256 amount) external onlyOwner {
        require(amount > 0, "Amount must be greater than zero");
        _burn(msg.sender, amount);
    }

    // Increase the allowance of a spender
    function increaseAllowance(address spender, uint256 addedValue) public returns (bool) {
        _approve(msg.sender, spender, allowance(msg.sender, spender) + addedValue);
        return true;
    }

    // Decrease the allowance of a spender
    function decreaseAllowance(address spender, uint256 subtractedValue) public returns (bool) {
        uint256 currentAllowance = allowance(msg.sender, spender);
        require(currentAllowance >= subtractedValue, "ERC20: decreased allowance below zero");
        _approve(msg.sender, spender, currentAllowance - subtractedValue);
        return true;
    }

    /// @dev Required by UUPS upgradeability.
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

}
