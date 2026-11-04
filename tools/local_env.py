#!/usr/bin/env python3
"""Create infra/local/ settings for the always-on local stack (`make local-up`).

Never overwrites existing files. The signing keys and recovery pepper are copied from
apps/api/.env when it exists, so sessions and recovery keys made in development keep
working after `make local-import`. Database and Redis passwords are fresh.

Usage: python3 tools/local_env.py
"""

import json
import secrets
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "infra/local"
DEV_ENV = ROOT / "apps/api/.env"
SHARED = ("ARC_SIGNING_KEYS", "ARC_SIGNING_KID", "ARC_RECOVERY_PEPPER")


def dev_secrets() -> dict[str, str]:
    if not DEV_ENV.exists():
        return {}
    found = {}
    for line in DEV_ENV.read_text().splitlines():
        key, sep, value = line.partition("=")
        if sep and key.strip() in SHARED:
            found[key.strip()] = value.strip()
    return found if len(found) == len(SHARED) else {}


def write_secret(path: Path, text: str) -> None:
    path.write_text(text)
    path.chmod(0o600)


def main() -> int:
    env = OUT / "api.env"
    if env.exists():
        print(f"{env} already exists; leaving it alone")
        return 0
    OUT.mkdir(parents=True, exist_ok=True)
    pg, redis = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
    write_secret(OUT / "postgres_password", pg)
    write_secret(OUT / "redis_password", redis)
    lines = {
        # Development mode: plain-http localhost and ngrok addresses are allowed, and the
        # database is a container on a private Docker network.
        "ARC_ENV": "development",
        "ARC_DATABASE_URL": f"postgresql+asyncpg://arc:{pg}@postgres:5432/arc",
        "ARC_REDIS_URL": f"redis://:{redis}@redis:6379/0",
        "ARC_SIGNING_KEYS": json.dumps({"k1": secrets.token_urlsafe(48)}),
        "ARC_SIGNING_KID": "k1",
        "ARC_RECOVERY_PEPPER": secrets.token_urlsafe(48),
        **dev_secrets(),
        "ARC_ALLOWED_ORIGINS": json.dumps(["http://localhost:5173"]),
        # 127.0.0.1 is for the container healthcheck.
        "ARC_ALLOWED_HOSTS": json.dumps(["localhost", "127.0.0.1"]),
        # Friends reach it through ngrok.
        "ARC_DEV_TUNNEL": "true",
        "ARC_EXPOSE_DOCS": "false",
    }
    write_secret(env, "".join(f"{k}={v}\n" for k, v in lines.items()))
    print(f"created {OUT}/ (api.env, postgres_password, redis_password)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
