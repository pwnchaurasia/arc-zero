"""Fixed-window rate limiting in Redis."""

from __future__ import annotations

import ipaddress
import time

from redis.asyncio import Redis

from arc_api.errors import ApiError


def ip_bucket(host: str | None) -> str:
    """IPv4 address, or the /64 network for IPv6 (one subscriber usually owns a /64)."""
    if not host:
        return "unknown"
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return "unknown"
    if ip.version == 6:
        return str(ipaddress.ip_network(f"{ip}/64", strict=False))
    return str(ip)


class RateLimiter:
    def __init__(self, redis: Redis) -> None:
        self._redis = redis

    async def hit(self, key: str, limit: int, window_seconds: int) -> None:
        now = int(time.time())
        bucket = now // window_seconds
        rkey = f"rl:{key}:{bucket}"
        pipe = self._redis.pipeline(transaction=True)
        pipe.incr(rkey)
        pipe.expire(rkey, window_seconds + 1)
        count, _ = await pipe.execute()
        if int(count) > limit:
            retry = (bucket + 1) * window_seconds - now
            raise ApiError(
                429,
                "rate_limited",
                "Too many requests. Try again later.",
                headers={"Retry-After": str(max(retry, 1))},
            )
