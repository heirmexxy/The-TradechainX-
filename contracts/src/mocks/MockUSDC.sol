// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice TESTNET / LOCAL ONLY. A USDC stand-in with 6 decimals and an open faucet.
///         Never deploy to mainnet — use the real USDC address there.
contract MockUSDC is ERC20 {
    constructor() ERC20("Mock USD Coin (test only)", "mUSDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
