#!/usr/bin/env bash
# Restore a backup INTO A SEPARATE DATABASE first, check it, then switch — never straight over production.
#   ./deploy/restore.sh backups/tradechainx-20260101T021500Z-daily.dump.age /path/to/backup-key.txt [target_db]
# Default target_db is "tradechainx_restore". To make it live: stop api+indexer, rename databases
# (see runbook §8.3), start api+indexer. The indexer re-reads the chain from its saved cursor, so
# on-chain mirrors catch up automatically after a restore.
set -euo pipefail
cd "$(dirname "$0")/.."
FILE="${1:?backup file}"; KEY="${2:?age private key file}"; TARGET="${3:-tradechainx_restore}"
source deploy/env/postgres.env
C="docker compose -f docker-compose.prod.yml exec -T postgres"
$C psql -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS $TARGET" -c "CREATE DATABASE $TARGET"
age -d -i "$KEY" "$FILE" | $C pg_restore -U "$POSTGRES_USER" -d "$TARGET" --no-owner --exit-on-error
$C psql -U "$POSTGRES_USER" -d "$TARGET" -c "select count(*) as users from users" -c "select name, last_block from chain_cursor" -c "select max(applied_at) as last_migration from schema_migrations"
echo "Restored into $TARGET. Check the numbers above before switching."
