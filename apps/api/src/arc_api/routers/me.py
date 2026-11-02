"""Current player's (or guest's) progress across all games."""

from __future__ import annotations

from fastapi import APIRouter, Request
from pydantic import Field
from sqlalchemy import select, update

from arc_api import coins, hints, names
from arc_api.db import LevelResult, Player
from arc_api.errors import ApiError
from arc_api.levels import GAME_IDS
from arc_api.principal import PrincipalDep, issue_ticket
from arc_api.progress import unlocked_level
from arc_api.routers.common import StrictModel, limit
from arc_api.state import DbDep, StateDep

router = APIRouter(tags=["me"])


class GameOut(StrictModel):
    unlocked_level: int
    level_count: int
    stars: dict[int, int]
    hints_left: int


class MeOut(StrictModel):
    signed_in: bool
    name: str | None = None
    # True only in local playtest mode (ARC_DEV_UNLOCK_ALL): every level can be played.
    all_levels_open: bool = False
    guest_max_level: int
    registration_required: bool
    games: dict[str, GameOut]
    coins: int
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
    name = None
    if who.player_id is not None:
        name = await db.scalar(select(Player.display_name).where(Player.id == who.player_id))
    return MeOut(
        signed_in=who.player_id is not None,
        name=name,
        all_levels_open=state.settings.dev_unlock_all,
        guest_max_level=gate,
        registration_required=who.player_id is None
        and any(len(stars[g]) >= gate for g in GAME_IDS),
        games=games,
        coins=await coins.balance(db, state, who),
        guest_ticket=issue_ticket(state, who.guest) if who.guest else None,
    )


class NameIn(StrictModel):
    name: str = Field(min_length=1, max_length=60)


class NameOut(StrictModel):
    name: str


@router.post("/me/name")
async def set_name(
    body: NameIn, request: Request, who: PrincipalDep, state: StateDep, db: DbDep
) -> NameOut:
    """Sets the signed-in player's display name (not unique, profanity-checked)."""
    if who.player_id is None:
        raise ApiError(403, "registration_required", "Save your progress to choose a name.")
    await limit(state, request, who, "name", 5)
    await state.limiter.hit(f"name-day:{who.owner}", 20, 86400)
    try:
        name = names.clean(body.name)
    except names.BadNameError as exc:
        raise ApiError(422, "bad_name", str(exc)) from exc
    await db.execute(update(Player).where(Player.id == who.player_id).values(display_name=name))
    await db.commit()
    return NameOut(name=name)
