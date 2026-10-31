"""Current player's (or guest's) progress across all games."""

from __future__ import annotations

from fastapi import APIRouter
from sqlalchemy import select

from arc_api import hints
from arc_api.db import LevelResult
from arc_api.levels import GAME_IDS
from arc_api.principal import PrincipalDep, issue_ticket
from arc_api.progress import unlocked_level
from arc_api.routers.common import StrictModel
from arc_api.state import DbDep, StateDep

router = APIRouter(tags=["me"])


class GameOut(StrictModel):
    unlocked_level: int
    level_count: int
    stars: dict[int, int]
    hints_left: int


class MeOut(StrictModel):
    signed_in: bool
    # True only in local playtest mode (ARC_DEV_UNLOCK_ALL): every level can be played.
    all_levels_open: bool = False
    guest_max_level: int
    registration_required: bool
    games: dict[str, GameOut]
    # Guests get (or refresh) their ticket here, so the client has one stable
    # identity before any game request. Stateless: no database row is created.
    guest_ticket: str | None = None


@router.get("/me")
async def me(who: PrincipalDep, state: StateDep, db: DbDep) -> MeOut:
    stars: dict[str, dict[int, int]] = {g: {} for g in GAME_IDS}
    if who.player_id is not None:
        rows = await db.execute(
            select(LevelResult.game_id, LevelResult.level, LevelResult.stars).where(
                LevelResult.player_id == who.player_id
            )
        )
        for game, level, star in rows:
            stars.setdefault(game, {})[level] = star
    else:
        assert who.guest is not None
        for game, values in who.guest.progress.items():
            stars[game] = {i: s for i, s in enumerate(values, start=1)}

    games = {
        g: GameOut(
            unlocked_level=await unlocked_level(db, state, who, g),
            level_count=state.levels.count(g),
            stars=stars.get(g, {}),
            hints_left=await hints.remaining(db, state, who, g),
        )
        for g in GAME_IDS
    }
    gate = state.settings.guest_max_level
    return MeOut(
        signed_in=who.player_id is not None,
        all_levels_open=state.settings.dev_unlock_all,
        guest_max_level=gate,
        registration_required=who.player_id is None
        and any(len(stars[g]) >= gate for g in GAME_IDS),
        games=games,
        guest_ticket=issue_ticket(state, who.guest) if who.guest else None,
    )
