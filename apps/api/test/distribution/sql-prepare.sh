#!/usr/bin/env bash
# PREPAREs every statement in src/distribution/sql.ts against a database that has migrations 0001-0005
# applied, so a typo in a column name or type fails here instead of in production.
#   PGHOST=... PGPORT=... PGUSER=... PGDATABASE=tcx ./sql-prepare.sh
set -u
here="$(cd "$(dirname "$0")" && pwd)"
statements=$(node --experimental-strip-types -e '
  import("'"$here"'/../../src/distribution/sql.ts").then(({ SQL }) => {
    for (const [name, text] of Object.entries(SQL)) console.log(name + "\t" + text);
  });')
pass=0; fail=0
while IFS=$'\t' read -r name text; do
  [ -z "$name" ] && continue
  out=$(psql -X -q -v ON_ERROR_STOP=1 -c "PREPARE s_${name} AS ${text}" 2>&1)
  if [ $? -eq 0 ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "  FAIL  $name"; echo "$out" | sed 's/^/        /'; fi
done <<< "$statements"
echo "prepared: $pass   failed: $fail"
[ $fail -eq 0 ] && [ $pass -gt 0 ]
