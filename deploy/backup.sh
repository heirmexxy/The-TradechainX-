#!/usr/bin/env bash
# Encrypted Postgres backup → local disk (14 days) + off-site S3-compatible bucket (e.g. Cloudflare R2).
#
# Setup once (see runbook §8):
#   * age key pair: `age-keygen -o backup-key.txt` on YOUR computer. Keep backup-key.txt (the private key)
#     in the secrets manager, NOT on the server. Put the public key ("age1…") in deploy/env/backup.env.
#   * rclone remote named "offsite" pointing at the backup bucket: `rclone config` (type s3, provider Cloudflare).
#   * cron:  15 2 * * *  cd /srv/tradechainx && ./deploy/backup.sh >> /var/log/tradechainx-backup.log 2>&1
set -euo pipefail
cd "$(dirname "$0")/.."
source deploy/env/backup.env   # BACKUP_AGE_RECIPIENT, BACKUP_REMOTE (e.g. offsite:tradechainx-backups)
source deploy/env/postgres.env
TAG="${1:-daily}"; TAG="${TAG#--}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p backups
FILE="backups/tradechainx-$STAMP-$TAG.dump.age"

docker compose -f docker-compose.prod.yml exec -T postgres \
  pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --no-owner \
  | age -r "$BACKUP_AGE_RECIPIENT" > "$FILE"

[ -s "$FILE" ] || { echo "Backup file is empty"; exit 1; }
rclone copy "$FILE" "$BACKUP_REMOTE/" --s3-no-check-bucket
find backups -name '*.dump.age' -mtime +14 -delete
echo "$(date -u) backup ok: $FILE ($(du -h "$FILE" | cut -f1))"
