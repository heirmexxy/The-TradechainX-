// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;


/// @notice Implemented by every asset the marketplace can trade. The marketplace refuses to settle a
///         sale unless the asset says it is tradable right now (not expired, not under a pending
///         status change, not suspended, not paused).
interface ITradableAsset {
    function isTradable(uint256 id) external view returns (bool);
}
