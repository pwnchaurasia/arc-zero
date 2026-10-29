"""Opaque server-side sessions in Redis.

The cookie holds a random token; Redis stores only its SHA-256, so a Redis
dump cannot be replayed as cookies. Sessions slide: each use extends the TTL.
"""

from __future__ import annotations

import hashlib
import secrets
import uuid

from redis.asyncio import Redis


def _key(token: str) -> str:
    return "sess:" + hashlib.sha256(token.encode()).hexdigest()


class Sessions:
    def __init__(self, redis: Redis, ttl_seconds: int) -> None:
        self._redis = redis
        self.ttl_seconds = ttl_seconds

    async def create(self, player_id: uuid.UUID) -> str:
        token = secrets.token_urlsafe(32)
        await self._redis.set(_key(token), str(player_id), ex=self.ttl_seconds)
        return token

    async def lookup(self, token: str) -> uuid.UUID | None:
        if not token or len(token) > 128:
            return None
        key = _key(token)
        pipe = self._redis.pipeline(transaction=True)
        pipe.get(key)
        pipe.expire(key, self.ttl_seconds, xx=True)
        value, _ = await pipe.execute()
        if value is None:
            return None
        try:
            return uuid.UUID(value.decode() if isinstance(value, bytes) else str(value))
        except ValueError:
            return None

    async def revoke(self, token: str) -> None:
        if token:
            await self._redis.delete(_key(token))
