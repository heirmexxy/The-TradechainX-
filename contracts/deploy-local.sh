#!/usr/bin/env bash
# Deploys the full suite to a local anvil chain with the well-known anvil dev accounts as role holders,
# then regenerates the shared ABIs/addresses. LOCAL DEVELOPMENT ONLY — these keys are public.
set -euo pipefail
cd "$(dirname "$0")"

RPC=${RPC_URL:-http://127.0.0.1:8545}
# anvil account 0 deploys and stays Super Admin locally.
DEPLOYER_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80

export ADMIN_DELAY=0
export KYC_REVIEWER=0x70997970C51812dc3A010C7d01b50e0d17dc79C8        # anvil 1
export LISTING_REVIEWER=0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC    # anvil 2
export WAREHOUSE_REGISTRAR=0x90F79bf6EB2c4f870365E785982E1f101E93b906 # anvil 3
export PAUSER=0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65              # anvil 4
export ASSET_MANAGER=0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc       # anvil 5

forge script script/Deploy.s.sol --rpc-url "$RPC" --broadcast --private-key "$DEPLOYER_KEY"
node ../packages/shared/scripts/generate.mjs
