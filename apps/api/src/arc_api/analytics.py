"""First-party play events. Counts only: nothing leaves our database.

Events never break a request: a failed insert is logged and dropped.
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import time

from sqlalchemy.ext.asyncio import AsyncSession

from arc_api.db import PlayEvent
from arc_api.principal import Principal
from arc_api.state import AppState

log = logging.getLogger("arc_api.analytics")

# Long enough to outlive the UTC day the key names.
VISIT_KEY_TTL = 2 * 24 * 3600


def who_hash(pepper: str, owner: str) -> str:
    """A stable, keyed, one-way id: without the pepper it can't be linked to anyone."""
    key = b"analytics:" + pepper.encode()
    return hmac.new(key, owner.encode(), hashlib.sha256).hexdigest()[:16]


def who(state: AppState, principal: Principal) -> str:
    return who_hash(state.settings.recovery_pepper.get_secret_value(), principal.owner)


async def record(
    db: AsyncSession,
    state: AppState,
    principal: Principal,
    kind: str,
    game: str | None = None,
    level: int | None = None,
    *,
    stars: int | None = None,
    coins: int | None = None,
    detail: str | None = None,
    started_ms: int | None = None,
) -> None:
    """Records one event. `started_ms` (when the level or run began, server clock)
    adds how long it took, for clears, losses and ends."""
    seconds = None
    if started_ms:
        seconds = max(0, int(time.time() * 1000 - started_ms) // 1000)
    try:
        db.add(
            PlayEvent(
                kind=kind,
                game_id=game,
                level=level,
                who=who(state, principal),
                signed_in=principal.player_id is not None,
                stars=stars,
                coins=coins,
                detail=detail,
                seconds=seconds,
            )
        )
        await db.commit()
    except Exception:  # analytics must never fail a game request
        log.warning("could not record %s event", kind, exc_info=True)
        await db.rollback()


async def record_visit(db: AsyncSession, state: AppState, principal: Principal) -> None:
    """Records that the app was opened, once per player per UTC day: the client asks for
    `/me` often, and a visit with no `start` after it means they looked but didn't play."""
    today = time.strftime("%Y-%m-%d", time.gmtime())
    key = f"analytics:visit:{today}:{who(state, principal)}"
    try:
        first = await state.redis.set(key, "1", nx=True, ex=VISIT_KEY_TTL)
    except Exception:  # analytics must never fail a game request
        log.warning("could not check today's visit", exc_info=True)
        return
    if first:
        await record(db, state, principal, "visit")
