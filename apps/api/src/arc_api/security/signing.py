"""HMAC-signed, expiring, purpose-bound tokens.

Format: ``v1.<kid>.<payload b64url>.<mac b64url>``. The MAC covers the purpose,
so a token minted for one use (e.g. a PoW challenge) is useless for another
(e.g. a guest ticket). Keys are looked up by id to allow rotation.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
from typing import Any

MAX_TOKEN_LEN = 4096


class InvalidTokenError(Exception):
    pass


def _b64e(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _b64d(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


class Signer:
    def __init__(self, keys: dict[str, bytes], current_kid: str) -> None:
        if current_kid not in keys:
            raise ValueError("current signing key id missing")
        self._keys = dict(keys)
        self._kid = current_kid

    def _mac(self, key: bytes, purpose: str, kid: str, payload_b64: str) -> bytes:
        msg = f"v1.{purpose}.{kid}.{payload_b64}".encode("ascii")
        return hmac.new(key, msg, hashlib.sha256).digest()

    def sign(self, purpose: str, payload: dict[str, Any], ttl_seconds: int) -> str:
        body = {**payload, "exp": int(time.time()) + ttl_seconds}
        payload_b64 = _b64e(json.dumps(body, separators=(",", ":"), sort_keys=True).encode())
        mac = self._mac(self._keys[self._kid], purpose, self._kid, payload_b64)
        return f"v1.{self._kid}.{payload_b64}.{_b64e(mac)}"

    def verify(self, purpose: str, token: str) -> dict[str, Any]:
        if len(token) > MAX_TOKEN_LEN:
            raise InvalidTokenError("token too long")
        parts = token.split(".")
        if len(parts) != 4 or parts[0] != "v1":
            raise InvalidTokenError("malformed token")
        _, kid, payload_b64, mac_b64 = parts
        key = self._keys.get(kid)
        if key is None:
            raise InvalidTokenError("unknown key")
        try:
            given = _b64d(mac_b64)
            expected = self._mac(key, purpose, kid, payload_b64)
            if not hmac.compare_digest(given, expected):
                raise InvalidTokenError("bad signature")
            body = json.loads(_b64d(payload_b64))
        except (ValueError, UnicodeDecodeError) as exc:
            raise InvalidTokenError("malformed token") from exc
        if not isinstance(body, dict) or not isinstance(body.get("exp"), int):
            raise InvalidTokenError("malformed payload")
        if body["exp"] < int(time.time()):
            raise InvalidTokenError("expired")
        return body
