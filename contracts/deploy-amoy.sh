#!/usr/bin/env bash
# Deploys to Polygon Amoy testnet. Uses MockUSDC unless USDC is set.
#
# Required env:
#   AMOY_RPC_URL        RPC endpoint
#   DEPLOYER_KEY        Throwaway deployer key (fund it with test POL). Never reuse a key that has
#                       been shared, committed, or zipped — including the old TradeChainX key.
#   SUPER_ADMIN         Safe multisig that will accept Super Admin after ADMIN_DELAY
# Optional: KYC_REVIEWER LISTING_REVIEWER WAREHOUSE_REGISTRAR PAUSER ASSET_MANAGER FEE_COLLECTOR FEE_BPS
#           ADMIN_DELAY (default 2 days) POLYGONSCAN_API_KEY (to verify source)
set -euo pipefail
cd "$(dirname "$0")"
: "${AMOY_RPC_URL:?set AMOY_RPC_URL}" "${DEPLOYER_KEY:?set DEPLOYER_KEY}" "${SUPER_ADMIN:?set SUPER_ADMIN}"

VERIFY=()
if [[ -n "${POLYGONSCAN_API_KEY:-}" ]]; then
  VERIFY=(--verify --etherscan-api-key "$POLYGONSCAN_API_KEY")
fi

forge script script/Deploy.s.sol --rpc-url "$AMOY_RPC_URL" --broadcast --private-key "$DEPLOYER_KEY" "${VERIFY[@]}"
node ../packages/shared/scripts/generate.mjs

echo
echo "Next: from the SUPER_ADMIN multisig, call acceptDefaultAdminTransfer() on each contract after ADMIN_DELAY."
