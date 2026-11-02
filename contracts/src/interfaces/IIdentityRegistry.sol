// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title IIdentityRegistry
/// @notice On-chain view of off-chain KYC/KYB results (PRD §4.2, §8.5).
/// @dev Only verification outcomes live on-chain — never personal data.
interface IIdentityRegistry {
    /// @dev Tier ordering matters: higher tiers are NOT supersets of lower ones;
    ///      callers check for the specific tiers they accept.
    enum Tier {
        None,          // not verified
        Individual,    // lightweight KYC: traders and retail investors
        Business,      // full KYB: warehouses, SMEs, carbon originators
        Institutional, // banks, MFBs, DFIs onboarded off-platform
        Platform       // TradeChainX protocol contracts (escrow, marketplace)
    }

    function tierOf(address account) external view returns (Tier);

    /// @notice True if the account holds any tier, is not frozen, and its verification has not lapsed.
    function isVerified(address account) external view returns (bool);

    /// @notice True if verified AND tier is Business or Institutional.
    function isVerifiedEntity(address account) external view returns (bool);
}
