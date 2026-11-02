#!/usr/bin/env bash
# Deploys TradeChainX to Polygon PoS MAINNET (chain 137), settling in Circle's native USDC.
# Read docs/PRODUCTION_RUNBOOK.md §10 (mainnet checklist) first. Run from a clean checkout of a release tag.
#
# Required env:
#   POLYGON_RPC_URL     RPC endpoint (Alchemy/QuickNode/Infura)
#   SUPER_ADMIN         Safe multisig address on Polygon (accepts Super Admin after ADMIN_DELAY)
#   FEE_COLLECTOR       Safe (or treasury address) that receives marketplace fees
#   DEPLOYER_ADDRESS    the signer's address (passed as --sender so the script's msg.sender matches)
#   One signer, in order of preference:
#     LEDGER=1                  sign with a Ledger (recommended), or
#     DEPLOYER_ACCOUNT=<name>   a Foundry encrypted keystore (`cast wallet import <name> --interactive`)
# Role holders (each a separate person's address; see docs/ACCOUNTS_AND_KEYS.md §Roles):
#   KYC_REVIEWER LISTING_REVIEWER WAREHOUSE_REGISTRAR PAUSER ASSET_MANAGER
# Optional: FEE_BPS (default 100 = 1%), ADMIN_DELAY (seconds; default 2 days),
#           ETHERSCAN_API_KEY (Etherscan API V2 key — one key covers Polygon; verifies source code)
set -euo pipefail
cd "$(dirname "$0")"
: "${DEPLOYER_ADDRESS:?set DEPLOYER_ADDRESS}" "${POLYGON_RPC_URL:?set POLYGON_RPC_URL}" "${SUPER_ADMIN:?set SUPER_ADMIN (Safe)}" "${FEE_COLLECTOR:?set FEE_COLLECTOR}"
for r in KYC_REVIEWER LISTING_REVIEWER WAREHOUSE_REGISTRAR PAUSER ASSET_MANAGER; do
  [[ -n "${!r:-}" ]] || { echo "Set $r (a named person's address) before a mainnet deploy."; exit 1; }
done

export USDC=0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359   # Circle native USDC on Polygon PoS

CHAIN=$(cast chain-id --rpc-url "$POLYGON_RPC_URL")
[[ "$CHAIN" == "137" ]] || { echo "RPC is chain $CHAIN, expected 137"; exit 1; }
CODE=$(cast code "$SUPER_ADMIN" --rpc-url "$POLYGON_RPC_URL")
[[ "$CODE" != "0x" ]] || { echo "SUPER_ADMIN $SUPER_ADMIN has no code — it must be a deployed Safe on Polygon."; exit 1; }

SIGNER=()
if [[ "${LEDGER:-}" == "1" ]]; then SIGNER=(--ledger)
elif [[ -n "${DEPLOYER_ACCOUNT:-}" ]]; then SIGNER=(--account "$DEPLOYER_ACCOUNT")
else echo "Set LEDGER=1 or DEPLOYER_ACCOUNT. Raw private keys are not accepted for mainnet."; exit 1; fi

VERIFY=()
[[ -n "${ETHERSCAN_API_KEY:-}" ]] && VERIFY=(--verify --etherscan-api-key "$ETHERSCAN_API_KEY")

echo "About to deploy to Polygon mainnet with SUPER_ADMIN=$SUPER_ADMIN FEE_COLLECTOR=$FEE_COLLECTOR FEE_BPS=${FEE_BPS:-100}"
read -r -p "Type DEPLOY to continue: " ok; [[ "$ok" == "DEPLOY" ]] || exit 1

forge script script/Deploy.s.sol --rpc-url "$POLYGON_RPC_URL" --broadcast --slow --sender "$DEPLOYER_ADDRESS" "${SIGNER[@]}" "${VERIFY[@]}"
node ../packages/shared/scripts/generate.mjs

echo
echo "Deployed. Commit contracts/deployments/137.json and packages/shared/src/deployments.ts."
echo "Next (runbook §10): after ADMIN_DELAY, the Safe calls acceptDefaultAdminTransfer() on all 7 contracts."
