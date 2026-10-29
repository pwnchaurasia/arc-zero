"""Short-lived game state in Redis: Water Sort attempts and Brick Blast runs."""

from __future__ import annotations

import json
import secrets
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from redis.asyncio import Redis

from arc_api.errors import ApiError

ATTEMPT_TTL = 24 * 3600

# Delete the lock only if we still own it (it may have expired and been retaken).
_RELEASE = """
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0
"""


def new_id() -> str:
    return secrets.token_urlsafe(18)


async def get_json(redis: Redis, key: str) -> dict[str, Any] | None:
    raw = await redis.get(key)
    if raw is None:
        return None
    value = json.loads(raw)
    return value if isinstance(value, dict) else None


async def put_json(redis: Redis, key: str, value: dict[str, Any], ttl: int = ATTEMPT_TTL) -> None:
    await redis.set(key, json.dumps(value, separators=(",", ":")), ex=ttl)


@asynccontextmanager
async def lock(redis: Redis, key: str, ttl_ms: int = 10_000) -> AsyncIterator[None]:
    """Mutual exclusion per attempt/run so parallel requests can't double-apply."""
    token = secrets.token_hex(16)
    if not await redis.set(f"lock:{key}", token, nx=True, px=ttl_ms):
        raise ApiError(409, "busy", "Another request for this game is in progress.")
    try:
        yield
    finally:
        await redis.eval(_RELEASE, 1, f"lock:{key}", token)
