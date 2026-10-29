"""Daily hint quota: N hints per game per UTC day, enforced on the server.

Players: an atomic conditional UPSERT, so parallel requests can't exceed the quota.
Guests: a Redis counter per guest id (no database rows before registration).
"""

from __future__ import annotations

from datetime import UTC, date, datetime

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from arc_api.db import HintUsage
from arc_api.errors import ApiError
from arc_api.levels import GameId
from arc_api.principal import Principal
from arc_api.state import AppState

GUEST_KEY_TTL = 2 * 86400


def today_utc() -> date:
    return datetime.now(UTC).date()


def _guest_key(who: Principal, game: GameId, day: date) -> str:
    assert who.guest is not None
    return f"ghint:{who.guest.gid}:{game}:{day.isoformat()}"


async def remaining(db: AsyncSession, state: AppState, who: Principal, game: GameId) -> int:
    limit = state.settings.hints_per_day
    day = today_utc()
    if who.player_id is not None:
        used = await db.scalar(
            select(HintUsage.used).where(
                HintUsage.player_id == who.player_id,
                HintUsage.game_id == game,
                HintUsage.day_utc == day,
            )
        )
    else:
        raw = await state.redis.get(_guest_key(who, game, day))
        used = int(raw) if raw is not None else 0
    return max(limit - (used or 0), 0)


async def require_available(
    db: AsyncSession, state: AppState, who: Principal, game: GameId
) -> None:
    """Cheap pre-check before spending CPU on a hint."""
    if await remaining(db, state, who, game) <= 0:
        raise ApiError(429, "no_hints_left", "No hints left today. They reset at 00:00 UTC.")


async def consume(db: AsyncSession, state: AppState, who: Principal, game: GameId) -> int:
    """Uses one hint. Returns hints left. Raises if the quota is exhausted."""
    limit = state.settings.hints_per_day
    day = today_utc()
    exhausted = ApiError(429, "no_hints_left", "No hints left today. They reset at 00:00 UTC.")

    if who.player_id is not None:
        base = insert(HintUsage).values(player_id=who.player_id, game_id=game, day_utc=day, used=1)
        stmt = base.on_conflict_do_update(
            index_elements=[HintUsage.player_id, HintUsage.game_id, HintUsage.day_utc],
            set_={"used": HintUsage.used + 1},
            where=HintUsage.used < limit,
        ).returning(HintUsage.used)
        used = (await db.execute(stmt)).scalar_one_or_none()
        if used is None or used > limit:
            await db.rollback()
            raise exhausted
        await db.commit()
        return limit - int(used)

    key = _guest_key(who, game, day)
    pipe = state.redis.pipeline(transaction=True)
    pipe.incr(key)
    pipe.expire(key, GUEST_KEY_TTL)
    used, _ = await pipe.execute()
    if int(used) > limit:
        await state.redis.decr(key)
        raise exhausted
    return limit - int(used)
