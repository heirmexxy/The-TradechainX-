#!/usr/bin/env bash
# Build and (re)start the production stack, then check it's healthy. Run on the server from the repo root:
#   ./deploy/deploy.sh            # deploy the currently checked-out commit
#   ./deploy/deploy.sh v1.4.0     # check out a tag first
# Rolling back = ./deploy/deploy.sh <previous tag>. Database migrations are forward-only, so a rollback
# across a migration needs the restore procedure in the runbook.
set -euo pipefail
cd "$(dirname "$0")/.."
COMPOSE="docker compose -f docker-compose.prod.yml"

for f in deploy/env/api.env deploy/env/postgres.env deploy/env/caddy.env .env pnpm-lock.yaml; do
  [ -f "$f" ] || { echo "Missing $f — see docs/PRODUCTION_RUNBOOK.md"; exit 1; }
done
chmod 600 deploy/env/*.env

if [ -n "${1:-}" ]; then
  git fetch --tags --quiet
  git checkout --quiet "$1"
fi
export RELEASE="$(git describe --tags --always)"
echo "==> Deploying $RELEASE"

# Back up before every deploy (migrations run on API start).
if [ -n "$($COMPOSE ps -q --status running postgres 2>/dev/null)" ]; then
  ./deploy/backup.sh --pre-deploy || { echo "Backup failed — not deploying"; exit 1; }
fi

$COMPOSE build
$COMPOSE up -d --remove-orphans

echo "==> Waiting for the API to report healthy"
status=""
for i in $(seq 1 30); do
  status="$($COMPOSE ps api --format '{{.Health}}' 2>/dev/null || true)"
  [ "$status" = "healthy" ] && break
  sleep 5
done
[ "$status" = "healthy" ] || { echo "API did not become healthy. Logs:"; $COMPOSE logs --tail=100 api; exit 1; }

API_DOMAIN="$(grep ^API_DOMAIN deploy/env/caddy.env | cut -d= -f2)"
curl -fsS "https://$API_DOMAIN/health" | jq . || { echo "Public /health check failed"; exit 1; }
docker image prune -f >/dev/null
echo "==> $RELEASE is live"
