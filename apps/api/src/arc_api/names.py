"""Display names: tidy, short, and free of profanity.

Checked server-side only; the client's checks are just for quick feedback.
"""

from __future__ import annotations

import re
import unicodedata
from functools import cache
from importlib import resources

MIN_LEN = 2
MAX_LEN = 20
# Letters (any script), digits, spaces, and . _ ' -
_ALLOWED = re.compile(r"^[\w .'-]+$", re.UNICODE)
_LEET = str.maketrans(
    {
        "0": "o",
        "1": "i",
        "3": "e",
        "4": "a",
        "5": "s",
        "7": "t",
        "8": "b",
        "9": "g",
        "@": "a",
        "$": "s",
        "!": "i",
        "|": "i",
        "+": "t",
    }
)


class BadNameError(ValueError):
    """Why a name was refused; the message is safe to show the player."""


@cache
def _blocklist() -> tuple[frozenset[str], frozenset[str]]:
    text = resources.files("arc_api.data").joinpath("blocked_names.txt").read_text("utf-8")
    roots: set[str] = set()
    words: set[str] = set()
    for line in text.splitlines():
        line = line.strip().lower()
        if not line or line.startswith("#"):
            continue
        (words if line.startswith("=") else roots).add(line.lstrip("="))
    return frozenset(roots), frozenset(words)


def _squash(s: str) -> str:
    """Collapses runs of the same letter: "fuuuck" -> "fuck"."""
    return re.sub(r"(.)\1+", r"\1", s)


def _candidates(name: str) -> set[str]:
    """Words to check: each word as written and with repeats collapsed, plus letters
    spelled out one at a time ("f u c k", "f.u.c.k") joined back together.

    Words are never joined across spaces otherwise: "Pawan Kumar" must not read as
    "pawankumar" and trip on a root in the middle.
    """
    base = unicodedata.normalize("NFKD", name.lower())
    base = "".join(c for c in base if not unicodedata.combining(c)).translate(_LEET)
    words = [w for w in re.split(r"[^a-z]+", base) if w]
    spelled: list[str] = []
    run = ""
    for w in [*words, ""]:
        if len(w) == 1:
            run += w
            continue
        if len(run) >= 2:
            spelled.append(run)
        run = ""
    out = set(words) | set(spelled)
    return out | {_squash(w) for w in out}


def is_profane(name: str) -> bool:
    roots, whole = _blocklist()
    for word in _candidates(name):
        if word in whole or word in roots:
            return True
        # Longer roots are caught inside words too ("fuckface", "chutiyapa").
        if any(len(root) >= 4 and root in word for root in roots):
            return True
    return False


def clean(raw: str) -> str:
    """Returns the tidy name to store, or raises BadNameError with a friendly reason."""
    name = " ".join(unicodedata.normalize("NFKC", raw).split())
    if not MIN_LEN <= len(name) <= MAX_LEN:
        raise BadNameError(f"Names are {MIN_LEN}-{MAX_LEN} characters.")
    if not _ALLOWED.match(name):
        raise BadNameError("Use letters, numbers, spaces, and . _ ' - only.")
    if not any(c.isalnum() for c in name):
        raise BadNameError("Names need at least one letter or number.")
    if is_profane(name):
        raise BadNameError("Please choose a different name.")
    return name
