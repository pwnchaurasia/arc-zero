"""Proof-of-work for account creation and restore.

The server issues a signed challenge; the client must find a nonce such that
``sha256(f"{challenge}:{nonce}")`` has `difficulty` leading zero bits. Cheap
for one human (~1 s), expensive for a bot making thousands of accounts.
Challenges are stateless until used, then burned in Redis so each works once.
"""

from __future__ import annotations

import hashlib
import secrets
import time
from typing import Literal

from redis.asyncio import Redis

from arc_api.errors import ApiError
from arc_api.security.signing import InvalidTokenError, Signer

Purpose = Literal["register", "restore"]
_TOKEN_PURPOSE = "pow"  # noqa: S105 - a label, not a secret


def leading_zero_bits(digest: bytes) -> int:
    bits = 0
    for byte in digest:
        if byte == 0:
            bits += 8
            continue
        return bits + (8 - byte.bit_length())
    return bits


def issue(signer: Signer, purpose: Purpose, difficulty: int, ttl_seconds: int) -> dict[str, object]:
    challenge = secrets.token_urlsafe(24)
    token = signer.sign(
        _TOKEN_PURPOSE, {"c": challenge, "d": difficulty, "for": purpose}, ttl_seconds
    )
    return {
        "token": token,
        "challenge": challenge,
        "difficulty": difficulty,
        "expires_at": int(time.time()) + ttl_seconds,
    }


async def verify(
    signer: Signer, redis: Redis, purpose: Purpose, token: str, nonce: int, ttl_seconds: int
) -> None:
    bad = ApiError(400, "pow_invalid", "Proof of work is invalid or expired. Please retry.")
    try:
        body = signer.verify(_TOKEN_PURPOSE, token)
    except InvalidTokenError as exc:
        raise bad from exc
    challenge, difficulty = body.get("c"), body.get("d")
    if (
        body.get("for") != purpose
        or not isinstance(challenge, str)
        or not isinstance(difficulty, int)
    ):
        raise bad
    digest = hashlib.sha256(f"{challenge}:{nonce}".encode()).digest()
    if leading_zero_bits(digest) < difficulty:
        raise bad
    # Single use: burn the challenge for as long as it could still be valid.
    if not await redis.set(f"pow:used:{challenge}", "1", nx=True, ex=ttl_seconds + 5):
        raise bad
