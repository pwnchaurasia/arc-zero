#!/usr/bin/env python3
"""Create apps/api/.env for local development with fresh random secrets.

Never overwrites an existing file. These secrets are for your machine only;
production secrets live in GitHub (see readme "One-time server setup").

Usage: python3 tools/dev_env.py
"""

import json
import secrets
import sys
from pathlib import Path

ENV = Path(__file__).resolve().parents[1] / "apps/api/.env"


def main() -> int:
    if ENV.exists():
        print(f"{ENV} already exists; leaving it alone")
        return 0
    lines = {
        "ARC_ENV": "development",
        "ARC_DATABASE_URL": "postgresql+asyncpg://arc:arc@localhost:55432/arc",
        "ARC_REDIS_URL": "redis://localhost:56379/0",
        "ARC_LEVELS_PATH": "levels.json",
        "ARC_SIGNING_KEYS": json.dumps({"k1": secrets.token_urlsafe(48)}),
        "ARC_SIGNING_KID": "k1",
        "ARC_RECOVERY_PEPPER": secrets.token_urlsafe(48),
        "ARC_ALLOWED_ORIGINS": json.dumps(["http://localhost:5173", "http://localhost:4173"]),
        "ARC_ALLOWED_HOSTS": json.dumps(["localhost", "127.0.0.1"]),
        "ARC_EXPOSE_DOCS": "true",
    }
    ENV.write_text("".join(f"{k}={v}\n" for k, v in lines.items()))
    ENV.chmod(0o600)
    print(f"created {ENV}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
