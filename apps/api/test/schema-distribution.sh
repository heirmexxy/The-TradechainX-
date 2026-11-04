#!/usr/bin/env bash
# Checks the money-safety constraints in migrations/0005_distribution.sql against a real Postgres.
# Usage:  PGHOST=... PGPORT=... PGUSER=... PGDATABASE=tcx ./schema-distribution.sh
# The database must already have migrations 0001-0005 applied. Every test runs in a transaction that is
# rolled back, so it is safe to run against a scratch or CI database.
set -u

pass=0
fail=0

PRELUDE="
INSERT INTO users(id,email,user_type) VALUES
  ('00000000-0000-0000-0000-000000000001','admin@example.test','investor'),
  ('00000000-0000-0000-0000-000000000002','direct@example.test','investor'),
  ('00000000-0000-0000-0000-000000000003','partner@example.test','sme');
INSERT INTO partners(id,name,account_user_id,contact_email,referral_code,created_by) VALUES
  ('00000000-0000-0000-0000-0000000000a1','Fintech A','00000000-0000-0000-0000-000000000003','a@example.test','REFA','00000000-0000-0000-0000-000000000001'),
  ('00000000-0000-0000-0000-0000000000a2','Fintech B','00000000-0000-0000-0000-000000000002','b@example.test','REFB','00000000-0000-0000-0000-000000000001');
INSERT INTO distributors(partner_id,revenue_share_bps) VALUES
  ('00000000-0000-0000-0000-0000000000a1',3000),('00000000-0000-0000-0000-0000000000a2',2000);
INSERT INTO warehouses(id,operator,licence_ref,active,metadata_uri,updated_block) VALUES (1,'0xabc','LIC-1',true,'',1);
INSERT INTO commodity_classes(id,commodity,grade,display_name,grading_standard,shrinkage_bps,max_fee_bps) VALUES
  ('00000000-0000-0000-0000-0000000000c1','SOYBEAN','GRADE_1','Soybean Grade 1','NSQ',200,100);
INSERT INTO reference_prices(id,class_id,price_kobo_per_kg,method_version,sources,kitovu_weight_bps,approved_by) VALUES
  (1,'00000000-0000-0000-0000-0000000000c1',90000,'v1','[]',1000,'00000000-0000-0000-0000-000000000001');
INSERT INTO customers(id,channel,distributor_id,external_ref) VALUES
  ('00000000-0000-0000-0000-0000000000d1','distributor','00000000-0000-0000-0000-0000000000a1','cust-1'),
  ('00000000-0000-0000-0000-0000000000d2','distributor','00000000-0000-0000-0000-0000000000a2','cust-1');
"

# t <name> <ok|fail> <regex the error must match (fail only)> <sql>
t() {
  local name="$1" expect="$2" pattern="$3" sql="$4" out rc
  out=$(psql -X -q -v ON_ERROR_STOP=1 <<SQL 2>&1
BEGIN;
$PRELUDE
$sql
ROLLBACK;
SQL
)
  rc=$?
  if [ "$expect" = ok ]; then
    if [ $rc -eq 0 ]; then echo "  ok    $name"; pass=$((pass+1)); else echo "  FAIL  $name"; echo "$out" | sed 's/^/        /'; fail=$((fail+1)); fi
  else
    if [ $rc -ne 0 ] && echo "$out" | grep -Eqi "$pattern"; then echo "  ok    $name"; pass=$((pass+1));
    else echo "  FAIL  $name (expected error matching: $pattern, rc=$rc)"; echo "$out" | sed 's/^/        /'; fail=$((fail+1)); fi
  fi
}

Q1="INSERT INTO quotes(id,customer_id,class_id,side,units,kobo_per_kg,total_kobo,reference_price_id,expires_at) VALUES"
ORD="INSERT INTO orders(quote_id,customer_id,distributor_id,idempotency_key,side,units,total_kobo) VALUES"
CUST1="'00000000-0000-0000-0000-0000000000d1'"; CUST2="'00000000-0000-0000-0000-0000000000d2'"
CLS="'00000000-0000-0000-0000-0000000000c1'"; DA="'00000000-0000-0000-0000-0000000000a1'"; DB="'00000000-0000-0000-0000-0000000000a2'"
Q_A="$Q1 ('00000000-0000-0000-0000-0000000000e1',$CUST1,$CLS,'buy',10000,90900,909000,1,now()+interval '1 minute');"
Q_B="$Q1 ('00000000-0000-0000-0000-0000000000e2',$CUST1,$CLS,'buy',10000,90900,909000,1,now()+interval '1 minute');"
Q_C="$Q1 ('00000000-0000-0000-0000-0000000000e3',$CUST2,$CLS,'buy',10000,90900,909000,1,now()+interval '1 minute');"

echo "Ledger"
t "balanced journal is accepted" ok "" "
INSERT INTO ledger_entries(journal_id,account,delta_kobo,kind) VALUES
  ('00000000-0000-0000-0000-0000000000f1','customer:x',-909000,'buy'),('00000000-0000-0000-0000-0000000000f1','client_money',909000,'buy');
SET CONSTRAINTS ledger_journal_balanced IMMEDIATE;"
t "unbalanced journal is rejected" fail "Unbalanced ledger journal" "
INSERT INTO ledger_entries(journal_id,account,delta_kobo,kind) VALUES ('00000000-0000-0000-0000-0000000000f2','client_money',500,'buy');
SET CONSTRAINTS ledger_journal_balanced IMMEDIATE;"
t "three-way split must sum to zero" fail "Unbalanced ledger journal" "
INSERT INTO ledger_entries(journal_id,account,delta_kobo,kind) VALUES
  ('00000000-0000-0000-0000-0000000000f3','customer:x',-1000,'buy'),('00000000-0000-0000-0000-0000000000f3','platform_revenue',300,'fee'),('00000000-0000-0000-0000-0000000000f3','distributor_revenue:a',601,'revenue_share');
SET CONSTRAINTS ledger_journal_balanced IMMEDIATE;"
t "zero-value entry is rejected" fail "delta_kobo|check" "
INSERT INTO ledger_entries(journal_id,account,delta_kobo,kind) VALUES ('00000000-0000-0000-0000-0000000000f4','client_money',0,'buy');"
t "ledger rows cannot be updated" fail "append-only" "
INSERT INTO ledger_entries(journal_id,account,delta_kobo,kind) VALUES
  ('00000000-0000-0000-0000-0000000000f5','a',5,'adjustment'),('00000000-0000-0000-0000-0000000000f5','b',-5,'adjustment');
UPDATE ledger_entries SET delta_kobo = 999 WHERE journal_id = '00000000-0000-0000-0000-0000000000f5';"
t "ledger rows cannot be deleted" fail "append-only" "
INSERT INTO ledger_entries(journal_id,account,delta_kobo,kind) VALUES
  ('00000000-0000-0000-0000-0000000000f6','a',5,'adjustment'),('00000000-0000-0000-0000-0000000000f6','b',-5,'adjustment');
DELETE FROM ledger_entries WHERE journal_id = '00000000-0000-0000-0000-0000000000f6';"

echo "Orders and quotes"
t "an order with a fresh idempotency key is accepted" ok "" "$Q_A $ORD ('00000000-0000-0000-0000-0000000000e1',$CUST1,$DA,'key-1','buy',10000,909000);"
t "a retried idempotency key cannot create a second order" fail "duplicate key|unique" "$Q_A $Q_B
$ORD ('00000000-0000-0000-0000-0000000000e1',$CUST1,$DA,'key-1','buy',10000,909000);
$ORD ('00000000-0000-0000-0000-0000000000e2',$CUST1,$DA,'key-1','buy',10000,909000);"
t "the same key from a different distributor is a different order" ok "" "$Q_A $Q_C
$ORD ('00000000-0000-0000-0000-0000000000e1',$CUST1,$DA,'key-1','buy',10000,909000);
$ORD ('00000000-0000-0000-0000-0000000000e3',$CUST2,$DB,'key-1','buy',10000,909000);"
t "one quote can only become one order" fail "duplicate key|unique" "$Q_A
$ORD ('00000000-0000-0000-0000-0000000000e1',$CUST1,$DA,'key-1','buy',10000,909000);
$ORD ('00000000-0000-0000-0000-0000000000e1',$CUST1,$DA,'key-2','buy',10000,909000);"
t "buys below the 10 kg minimum are rejected" fail "check" "$Q1 ('00000000-0000-0000-0000-0000000000e4',$CUST1,$CLS,'buy',9999,90900,908000,1,now());"
t "small sells are allowed (clear a remainder)" ok "" "$Q1 ('00000000-0000-0000-0000-0000000000e5',$CUST1,$CLS,'sell',1,89100,89,1,now());"

echo "Customers and channels"
t "direct customer needs a signed-in user" fail "check" "INSERT INTO customers(channel) VALUES ('direct');"
t "direct customer with a user is accepted" ok "" "INSERT INTO customers(channel,user_id) VALUES ('direct','00000000-0000-0000-0000-000000000002');"
t "distributed customer needs the distributor's own reference" fail "check" "INSERT INTO customers(channel,distributor_id) VALUES ('distributor',$DA);"
t "the same external reference twice at one distributor is rejected" fail "duplicate key|unique" "INSERT INTO customers(channel,distributor_id,external_ref) VALUES ('distributor',$DA,'cust-1');"
t "KYC reliance is only for distributed customers" fail "check" "INSERT INTO customers(channel,user_id,kyc_basis) VALUES ('direct','00000000-0000-0000-0000-000000000002','distributor_reliance');"
t "one direct customer record per user" fail "duplicate key|unique" "INSERT INTO customers(channel,user_id) VALUES ('direct','00000000-0000-0000-0000-000000000002'),('direct','00000000-0000-0000-0000-000000000002');"

echo "Distributor grants and market parameters"
t "an enabled grant needs an approver and at least one tier" fail "check" "INSERT INTO distributor_asset_grants(distributor_id,asset_type,enabled) VALUES ($DA,'lpo',true);"
t "an enabled grant with approver and tiers is accepted" ok "" "INSERT INTO distributor_asset_grants(distributor_id,asset_type,enabled,tiers,enabled_by,enabled_at) VALUES ($DA,'lpo',true,'{qualified}','00000000-0000-0000-0000-000000000001',now());"
t "unknown investor tier is rejected" fail "check" "INSERT INTO distributor_asset_grants(distributor_id,asset_type,tiers) VALUES ($DA,'lpo','{whale}');"
t "unknown asset type is rejected" fail "check" "INSERT INTO distributor_asset_grants(distributor_id,asset_type) VALUES ($DA,'gold');"
t "buyback spread cannot be narrower than the user spread" fail "check" "
INSERT INTO market_params(class_id,user_spread_bps,buyback_spread_bps,fee_kobo_per_kg_month,buyback_daily_limit_user,buyback_daily_limit_total,circuit_breaker_bps,reserve_floor_bps,set_by)
VALUES ($CLS,200,100,300,100000,10000000,1000,2000,'00000000-0000-0000-0000-000000000001');"
t "valid market parameters are accepted" ok "" "
INSERT INTO market_params(class_id,user_spread_bps,buyback_spread_bps,fee_kobo_per_kg_month,buyback_daily_limit_user,buyback_daily_limit_total,circuit_breaker_bps,reserve_floor_bps,set_by)
VALUES ($CLS,100,400,300,100000,10000000,1000,2000,'00000000-0000-0000-0000-000000000001');"
t "reference price must be positive and approved" fail "check|null" "INSERT INTO reference_prices(class_id,price_kobo_per_kg,method_version,sources,kitovu_weight_bps,approved_by) VALUES ($CLS,0,'v1','[]',0,'00000000-0000-0000-0000-000000000001');"

echo "Stock and fees"
t "shrinkage buffer above 20% is rejected" fail "check" "INSERT INTO commodity_classes(commodity,grade,display_name,grading_standard,shrinkage_bps,max_fee_bps) VALUES ('MAIZE','G1','Maize','NSQ',2001,100);"
t "a lot reference cannot be reused in a warehouse" fail "duplicate key|unique" "
INSERT INTO commodity_lots(class_id,warehouse_id,lot_ref,gross_grams,intake_date) VALUES ($CLS,1,'LOT-1',100000,current_date),($CLS,1,'LOT-1',50000,current_date);"
t "a holder is charged once per fee period" fail "duplicate key|unique" "
INSERT INTO holding_fee_charges(customer_id,class_id,period,units) VALUES ($CUST1,$CLS,650,300),($CUST1,$CLS,650,300);"
t "a holder can be charged in the next period" ok "" "
INSERT INTO holding_fee_charges(customer_id,class_id,period,units) VALUES ($CUST1,$CLS,650,300),($CUST1,$CLS,651,300);"

echo
echo "passed: $pass   failed: $fail"
[ $fail -eq 0 ]
