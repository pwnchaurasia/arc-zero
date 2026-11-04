#!/usr/bin/env bash
# Copy the development database and Redis into the always-on local stack, replacing its
# data, so players keep their accounts, progress, coins and sessions.
# Usage: make local-import (both stacks must be running).
set -euo pipefail
cd "$(dirname "$0")/.."

DEV="docker compose -f infra/docker-compose.dev.yml"
LOCAL="docker compose -f infra/docker-compose.local.yml"
LOCAL_REDIS=arc-zero-local-redis-1
LOCAL_NET=arc-zero-local_internal

echo "Stopping the local API while its data is replaced"
$LOCAL stop web api

echo "Copying Postgres"
$DEV exec -T postgres pg_dump -U arc -Fc arc \
  | $LOCAL exec -T postgres pg_restore -U arc -d arc --clean --if-exists --no-owner

echo "Copying Redis (keys keep their expiry)"
dev_redis=$($DEV ps -q redis)
docker network connect "$LOCAL_NET" "$dev_redis"
trap 'docker network disconnect "$LOCAL_NET" "$dev_redis" >/dev/null 2>&1 || true' EXIT
password=$(cat infra/local/redis_password)
keys=$($DEV exec -T redis redis-cli --scan | wc -l | tr -d ' ')
if [ "$keys" -gt 0 ]; then
  $DEV exec -T redis redis-cli --scan \
    | xargs -n 200 $DEV exec -T redis redis-cli \
        MIGRATE "$LOCAL_REDIS" 6379 "" 0 10000 COPY REPLACE AUTH "$password" KEYS >/dev/null
fi
echo "  $keys keys"

$LOCAL up -d --wait
echo "Done. The local arcade now has your development data."
