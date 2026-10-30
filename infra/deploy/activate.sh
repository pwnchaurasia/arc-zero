#!/usr/bin/env bash
# Runs ON THE SERVER: installs the uploaded config and starts a release.
#
#   activate.sh <deploy-dir> <image-prefix> <image-tag>
#
# Expects <deploy-dir>/secrets.new/{api.env,redis_password,levels.json} and
# <deploy-dir>/docker-compose.yml to have been uploaded already.
# Set SKIP_PULL=1 to use local images (testing).
set -euo pipefail

dir=${1:?deploy dir} prefix=${2:?image prefix} tag=${3:?image tag}
cd "$dir"

for f in api.env redis_password levels.json; do
  [ -s "secrets.new/$f" ] || { echo "missing secrets.new/$f" >&2; exit 1; }
done
# Containers read these as their own (non-root) users through bind mounts, which keep
# host permissions. The parent directory stays 700, so other host users still can't.
chmod 700 secrets.new
chmod 600 secrets.new/api.env secrets.new/redis_password
chmod 644 secrets.new/levels.json

# Swap the whole directory at once so a half-copied set is never used.
rm -rf secrets.old
if [ -d secrets ]; then mv secrets secrets.old; fi
mv secrets.new secrets
rm -rf secrets.old

# Record the live version so manual `docker compose` commands (and rollbacks:
# edit IMAGE_TAG, then `docker compose up -d`) need no extra flags.
touch .env
sed -i.bak '/^IMAGE_PREFIX=/d;/^IMAGE_TAG=/d' .env && rm -f .env.bak
printf 'IMAGE_PREFIX=%s\nIMAGE_TAG=%s\n' "$prefix" "$tag" >> .env

if [ "${SKIP_PULL:-0}" != 1 ]; then
  docker compose pull --quiet
fi
# --wait returns only when every service is healthy (or the one-shot migrate has
# finished), and fails the deploy otherwise.
if ! docker compose up -d --remove-orphans --wait --wait-timeout 180; then
  docker compose ps -a
  docker compose logs --tail 60 migrate api web
  exit 1
fi
docker image prune -f >/dev/null
echo "release $tag is running"
