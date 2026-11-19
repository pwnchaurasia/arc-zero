#!/usr/bin/env bash
# Writes the server's runtime config from environment variables (GitHub secrets).
# Used by .github/workflows/release.yml; runnable locally for testing.
#
#   write-config.sh <out-dir>
#
# Required env: ARC_DATABASE_URL ARC_SIGNING_KEYS ARC_RECOVERY_PEPPER REDIS_PASSWORD SITE_ADDRESS
# Optional env: ARC_SIGNING_KID (default k1)
#               NGROK_DOMAIN + NGROK_AUTHTOKEN: optional ngrok tunnel. Both or neither.
set -euo pipefail

out=${1:?usage: write-config.sh <out-dir>}
fail=0
for name in ARC_DATABASE_URL ARC_SIGNING_KEYS ARC_RECOVERY_PEPPER REDIS_PASSWORD SITE_ADDRESS; do
  if [ -z "${!name:-}" ]; then
    echo "::error::Missing $name (GitHub: Settings → Environments → production)"
    fail=1
  fi
done
[ "$fail" = 0 ] || exit 1

case "$ARC_DATABASE_URL" in
  postgresql+asyncpg://*\?ssl=require | postgresql+asyncpg://*\?ssl=verify-ca | postgresql+asyncpg://*\?ssl=verify-full) ;;
  *) echo "::error::ARC_DATABASE_URL must be postgresql+asyncpg://…?ssl=require (nothing after it)"; fail=1 ;;
esac
[[ "$REDIS_PASSWORD" =~ ^[A-Za-z0-9]{16,}$ ]] || { echo "::error::REDIS_PASSWORD must be 16+ letters/digits"; fail=1; }
[[ "$SITE_ADDRESS" =~ ^[a-z0-9.-]+$ ]] || { echo "::error::SITE_ADDRESS must be a bare host name, e.g. play.example.com"; fail=1; }
[[ "$ARC_SIGNING_KEYS" == \{* ]] || { echo "::error::ARC_SIGNING_KEYS must be JSON, e.g. {\"k1\": \"…\"}"; fail=1; }
[[ "$ARC_SIGNING_KEYS" != *"'"* ]] || { echo "::error::ARC_SIGNING_KEYS must not contain single quotes"; fail=1; }

NGROK_DOMAIN=${NGROK_DOMAIN:-}
NGROK_AUTHTOKEN=${NGROK_AUTHTOKEN:-}
if [ -n "$NGROK_DOMAIN" ] || [ -n "$NGROK_AUTHTOKEN" ]; then
  [ -n "$NGROK_DOMAIN" ] && [ -n "$NGROK_AUTHTOKEN" ] || { echo "::error::Set both NGROK_DOMAIN and NGROK_AUTHTOKEN secrets, or neither"; fail=1; }
  [[ "$NGROK_DOMAIN" =~ ^[a-z0-9-]+\.(ngrok-free\.dev|ngrok-free\.app|ngrok\.app|ngrok\.dev|ngrok\.io)$ ]] || { echo "::error::NGROK_DOMAIN must be a bare ngrok host name, e.g. calm-otter-1234.ngrok-free.dev"; fail=1; }
  [[ "$NGROK_AUTHTOKEN" =~ ^[A-Za-z0-9_]{20,}$ ]] || { echo "::error::NGROK_AUTHTOKEN doesn't look like an ngrok authtoken"; fail=1; }
fi
[ "$fail" = 0 ] || exit 1

origins="\"https://$SITE_ADDRESS\""
hosts="\"$SITE_ADDRESS\",\"127.0.0.1\""
if [ -n "$NGROK_DOMAIN" ]; then
  origins="$origins,\"https://$NGROK_DOMAIN\""
  hosts="$hosts,\"$NGROK_DOMAIN\""
fi

umask 077
mkdir -p "$out"
printf '%s' "$REDIS_PASSWORD" > "$out/redis_password"
# JSON values are single-quoted: Compose treats single-quoted env-file values literally.
cat > "$out/api.env" <<CONF
ARC_ENV=production
ARC_DATABASE_URL=$ARC_DATABASE_URL
ARC_REDIS_URL=redis://:$REDIS_PASSWORD@redis:6379/0
ARC_SIGNING_KEYS='$ARC_SIGNING_KEYS'
ARC_SIGNING_KID=${ARC_SIGNING_KID:-k1}
ARC_RECOVERY_PEPPER=$ARC_RECOVERY_PEPPER
ARC_ALLOWED_ORIGINS='[$origins]'
ARC_ALLOWED_HOSTS='[$hosts]'
ARC_COOKIE_SECURE=true
ARC_HSTS=true
ARC_EXPOSE_DOCS=false
CONF
# Optional ngrok agent config (activate.sh starts the tunnel only when it has content).
if [ -n "$NGROK_DOMAIN" ]; then
  cat > "$out/ngrok.yml" <<CONF
version: 3
agent:
  authtoken: $NGROK_AUTHTOKEN
  log: stdout
tunnels:
  arcade:
    proto: http
    addr: web:80
    domain: $NGROK_DOMAIN
    inspect: false
CONF
else
  : > "$out/ngrok.yml"
fi
echo "wrote $out/api.env, $out/redis_password and $out/ngrok.yml"
