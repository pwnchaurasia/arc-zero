"""Recovery keys: six BIP-39 words (≈66 bits), generated server-side.

Only `HMAC-SHA256(pepper, key)` is stored, so a database leak does not expose
usable keys. A slow hash is unnecessary because the key is already high-entropy,
and a deterministic HMAC allows an indexed lookup.
"""

from __future__ import annotations

import hashlib
import hmac
import re
import secrets
from functools import cache
from importlib import resources

KEY_WORDS = 6
_WORD_RE = re.compile(r"[a-z]+")


@cache
def wordlist() -> tuple[str, ...]:
    text = resources.files("arc_api.data").joinpath("bip39_english.txt").read_text("ascii")
    words = tuple(w for w in text.split() if w)
    if len(words) != 2048:
        raise RuntimeError("BIP-39 wordlist is corrupt")
    return words


@cache
def _word_set() -> frozenset[str]:
    return frozenset(wordlist())


def generate_key() -> str:
    words = wordlist()
    return "-".join(secrets.choice(words) for _ in range(KEY_WORDS))


def normalize_key(raw: str) -> str | None:
    """Accepts any separators/case; returns the canonical key or None if invalid."""
    words = _WORD_RE.findall(raw.lower())
    if len(words) != KEY_WORDS or not all(w in _word_set() for w in words):
        return None
    return "-".join(words)


def hash_key(key: str, pepper: bytes) -> bytes:
    return hmac.new(pepper, key.encode("ascii"), hashlib.sha256).digest()
