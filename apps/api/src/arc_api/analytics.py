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


def who(state: AppState, principal: Principal) -> str:
    """A stable, keyed, one-way id: counts distinct players without identifying them."""
    key = b"analytics:" + state.settings.recovery_pepper.get_secret_value().encode()
    return hmac.new(key, principal.owner.encode(), hashlib.sha256).hexdigest()[:16]


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
