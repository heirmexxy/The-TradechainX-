#!/usr/bin/env bash
# Local smoke test: drives a full platform journey against a fresh deploy-local.sh deployment using
# only `cast`. Proves the deployed wiring (roles, platform registration, asset allow-list) works end to
# end — not just the unit-test harness. LOCAL ONLY: uses anvil's public dev keys.
#
#   anvil &                 # fresh chain
#   ./deploy-local.sh
#   ./smoke-local.sh
set -euo pipefail
cd "$(dirname "$0")"
R=${RPC_URL:-http://127.0.0.1:8545}
D=deployments/31337.json
j() { python3 -c "import json;print(json.load(open('$D'))['$1'])"; }
USDC=$(j usdc); IDS=$(j identityRegistry); WHS=$(j warehouseRegistry); WR=$(j warehouseReceipt)
LPO=$(j lpoToken); MKT=$(j marketplace); XF=$(j xownFactory)

# anvil dev keys (public). Roles match deploy-local.sh.
K0=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80  # super admin
K1=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d  # KYC reviewer
K2=0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a  # listing reviewer
K3=0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6  # warehouse registrar
K4=0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a  # pauser
K5=0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba  # asset manager
K6=0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e  # warehouse operator
K7=0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356  # trader
K8=0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97  # investor
K9=0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6  # SME + tractor SPV
a() { cast wallet address "$1"; }
send() { local key=$1; shift; cast send --private-key "$key" --rpc-url "$R" "$@" >/dev/null; }
call() { cast call --rpc-url "$R" "$@"; }
ok() { printf "  \033[32m✓\033[0m %s\n" "$1"; }
expect() { if [[ "$1" != "$2" ]]; then echo "FAIL: $3 (got $1, expected $2)"; exit 1; fi; ok "$3"; }
NOW=$(cast block latest --field timestamp --rpc-url "$R")
b32() { cast format-bytes32-string "$1"; }

echo "1. Verify participants"
until=$((NOW + 31536000))
send $K1 $IDS "setIdentity(address,uint8,uint64,bytes32)" $(a $K6) 2 $until $(cast keccak kyc-6)
send $K1 $IDS "setIdentity(address,uint8,uint64,bytes32)" $(a $K7) 1 $until $(cast keccak kyc-7)
send $K1 $IDS "setIdentity(address,uint8,uint64,bytes32)" $(a $K8) 1 $until $(cast keccak kyc-8)
send $K1 $IDS "setIdentity(address,uint8,uint64,bytes32)" $(a $K9) 2 $until $(cast keccak kyc-9)
expect "$(call $IDS 'isVerified(address)(bool)' $(a $K7))" true "trader verified"
send $K0 $USDC "mint(address,uint256)" $(a $K8) 100000000000
send $K0 $USDC "mint(address,uint256)" $(a $K9) 100000000000

echo "2. Register a warehouse"
send $K3 $WHS "registerWarehouse(address,bytes32,string)" $(a $K6) $(cast keccak OYO/WR/2026/001) "ipfs://wh"
expect "$(call $WHS 'isActiveOperator(uint256,address)(bool)' 1 $(a $K6))" true "warehouse 1 active"

echo "3. Issue a warehouse receipt (submit → review → mint)"
TERMS="(1,$(cast keccak ISY-2026/0042),$(b32 MAIZE),$(b32 GRADE_1),60000,$((NOW - 86400)),$((NOW + 15552000)),$(cast keccak docs),\"https://api/metadata/1\")"
send $K6 $WR "submitReceipt((uint256,bytes32,bytes32,bytes32,uint256,uint64,uint64,bytes32,string),address)" "$TERMS" $(a $K7)
expect "$(call $WR 'nextTokenId()(uint256)')" 0 "nothing minted before review"
send $K2 $WR "approveSubmission(uint256)" 1
expect "$(call $WR 'ownerOf(uint256)(address)' 1)" "$(a $K7)" "receipt minted to trader"

echo "4. Sell it on the marketplace (atomic USDC settlement)"
send $K7 $WR "approve(address,uint256)" $MKT 1
send $K7 $MKT "list(address,uint256,uint256,uint256)" $WR 1 1 18000000000
expect "$(call $WR 'ownerOf(uint256)(address)' 1)" "$MKT" "listed receipt held by marketplace"
send $K8 $USDC "approve(address,uint256)" $MKT 18000000000
send $K8 $MKT "buy(uint256,uint256,uint256)" 1 1 18000000000
expect "$(call $WR 'ownerOf(uint256)(address)' 1)" "$(a $K8)" "investor owns the receipt"
expect "$(call $USDC 'balanceOf(address)(uint256)' $(a $K7) | awk '{print $1}')" 17820000000 "trader paid 18,000 minus 1% fee"
expect "$(call $USDC 'balanceOf(address)(uint256)' $MKT | awk '{print $1}')" 0 "marketplace holds no USDC"

echo "5. LPO: issue, then the buyer settles to the holder"
LTERMS="($(cast keccak PO-7781),$(cast keccak RC-554433),$(b32 SOY_30T),30000000000,$NOW,$((NOW + 3888000)),$(cast keccak po),\"https://api/metadata/lpo/1\")"
send $K9 $LPO "submitLPO((bytes32,bytes32,bytes32,uint256,uint64,uint64,bytes32,string))" "$LTERMS"
send $K2 $LPO "approveSubmission(uint256)" 1
expect "$(call $LPO 'ownerOf(uint256)(address)' 1)" "$(a $K9)" "LPO minted to SME"
BEFORE=$(call $USDC 'balanceOf(address)(uint256)' $(a $K9) | awk '{print $1}')
send $K8 $USDC "approve(address,uint256)" $LPO 30000000000
send $K8 $LPO "settle(uint256)" 1
AFTER=$(call $USDC 'balanceOf(address)(uint256)' $(a $K9) | awk '{print $1}')
expect "$((AFTER - BEFORE))" 30000000000 "holder received the face value"

echo "6. XOwn: propose → approve → fully subscribe → operator funded"
OTERMS="(\"XOwn Tractor 01\",\"XO-ISY01\",$(a $K9),100,100000000,$((NOW + 1814400)),($(b32 TRACTOR),$(cast keccak MF-375-000123),$(cast keccak invoice),\"https://api/metadata/xown/1\"))"
send $K5 $XF "propose((string,string,address,uint256,uint256,uint64,(bytes32,bytes32,bytes32,string)))" "$OTERMS"
send $K2 $XF "approve(uint256)" 1
VAULT=$(call $XF 'vaults(uint256)(address)' 0)
ok "vault $VAULT created"
SPV_BEFORE=$(call $USDC 'balanceOf(address)(uint256)' $(a $K9) | awk '{print $1}')
send $K8 $USDC "approve(address,uint256)" $VAULT 10000000000
send $K8 $VAULT "subscribe(uint256)" 100
expect "$(call $VAULT 'state()(uint8)')" 1 "offering fully funded"
SPV_AFTER=$(call $USDC 'balanceOf(address)(uint256)' $(a $K9) | awk '{print $1}')
expect "$((SPV_AFTER - SPV_BEFORE))" 10000000000 "operator received the raise"

echo "7. Emergency pause"
send $K4 $MKT "pause()"
expect "$(call $MKT 'paused()(bool)')" true "pauser paused the marketplace"
if cast send --private-key $K4 --rpc-url "$R" $MKT "unpause()" >/dev/null 2>&1; then echo "FAIL: pauser could unpause"; exit 1; fi
ok "pauser cannot unpause"
send $K0 $MKT "unpause()"
expect "$(call $MKT 'paused()(bool)')" false "super admin resumed"

echo; echo "Smoke test passed."
