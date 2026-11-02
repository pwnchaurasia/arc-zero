"""Level unlocking and win recording. The only code that advances progress."""

from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy import func, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from arc_api.db import GameProgress, LevelResult, Player
from arc_api.errors import ApiError
from arc_api.levels import GameId
from arc_api.principal import Principal, issue_ticket
from arc_api.state import AppState


async def unlocked_level(db: AsyncSession, state: AppState, who: Principal, game: GameId) -> int:
    count = state.levels.count(game)
    if who.player_id is not None:
        stored = await db.scalar(
            select(GameProgress.unlocked_level).where(
                GameProgress.player_id == who.player_id, GameProgress.game_id == game
            )
        )
        return min(stored or 1, count)
    assert who.guest is not None
    return min(who.guest.cleared(game) + 1, state.settings.guest_max_level, count)


async def ensure_playable(
    db: AsyncSession, state: AppState, who: Principal, game: GameId, level: int
) -> None:
    if not 1 <= level <= state.levels.count(game):
        raise ApiError(404, "level_not_found", "No such level.")
    if state.settings.dev_unlock_all:
        return  # local playtesting (refused in production by the settings check)
    if who.player_id is None and level > state.settings.guest_max_level:
        raise ApiError(403, "registration_required", "Save your progress to keep playing.")
    if level > await unlocked_level(db, state, who, game):
        raise ApiError(403, "level_locked", "Finish the previous level first.")


@dataclass(slots=True)
class WinOutcome:
    unlocked_level: int
    best_stars: int
    registration_required: bool = False
    guest_ticket: str | None = None


async def record_win(
    db: AsyncSession,
    state: AppState,
    who: Principal,
    game: GameId,
    level: int,
    stars: int,
    moves: int | None,
) -> WinOutcome:
    next_level = min(level + 1, state.levels.count(game))

    if who.player_id is not None:
        result_insert = insert(LevelResult).values(
            player_id=who.player_id, game_id=game, level=level, stars=stars, best_moves=moves
        )
        result_stmt = result_insert.on_conflict_do_update(
            index_elements=[LevelResult.player_id, LevelResult.game_id, LevelResult.level],
            set_={
                "stars": func.greatest(LevelResult.stars, result_insert.excluded.stars),
                "best_moves": func.least(LevelResult.best_moves, result_insert.excluded.best_moves),
                "completed_at": func.now(),
            },
        ).returning(LevelResult.stars)
        best = (await db.execute(result_stmt)).scalar_one()

        progress_insert = insert(GameProgress).values(
            player_id=who.player_id, game_id=game, unlocked_level=next_level
        )
        progress_stmt = progress_insert.on_conflict_do_update(
            index_elements=[GameProgress.player_id, GameProgress.game_id],
            set_={
                "unlocked_level": func.greatest(
                    GameProgress.unlocked_level, progress_insert.excluded.unlocked_level
                )
            },
        ).returning(GameProgress.unlocked_level)
        unlocked = (await db.execute(progress_stmt)).scalar_one()
        await db.execute(
            update(Player).where(Player.id == who.player_id).values(last_active=func.now())
        )
        await db.commit()
        return WinOutcome(unlocked_level=unlocked, best_stars=best)

    guest = who.guest
    assert guest is not None
    stars_list = guest.progress.setdefault(game, [])
    if level == len(stars_list) + 1:
        stars_list.append(stars)
    elif level <= len(stars_list):
        stars_list[level - 1] = max(stars_list[level - 1], stars)
    cleared = len(stars_list)
    gate = state.settings.guest_max_level
    return WinOutcome(
        unlocked_level=min(cleared + 1, gate, state.levels.count(game)),
        best_stars=stars_list[level - 1],
        registration_required=cleared >= gate,
        guest_ticket=issue_ticket(state, guest),
    )
