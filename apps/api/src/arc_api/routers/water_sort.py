"""Water Sort: start a level, verify a completion by replay, give hints.

The client sends only its moves. The server rebuilds the board from the
secret level seed, replays every move with the shared engine, and decides
whether the level is solved and how many stars it earns.
"""

from __future__ import annotations

import time
from typing import Annotated

import arc_engine
from fastapi import APIRouter, Path, Request
from pydantic import Field

from arc_api import hints, store
from arc_api.errors import ApiError
from arc_api.levels import GameId, WsLevel
from arc_api.principal import Principal, PrincipalDep, issue_ticket
from arc_api.progress import ensure_playable, record_win
from arc_api.routers.common import StrictModel, limit
from arc_api.state import AppState, DbDep, StateDep

GAME: GameId = "water-sort"
router = APIRouter(prefix="/games/water-sort", tags=["water-sort"])

LevelPath = Annotated[int, Path(ge=1, le=10_000)]
BottleIndex = Annotated[int, Field(ge=0, le=15)]
AttemptId = Annotated[str, Field(pattern=r"^[A-Za-z0-9_-]{16,64}$")]
Moves = Annotated[list[tuple[BottleIndex, BottleIndex]], Field(max_length=arc_engine.WS_MAX_MOVES)]


class StartOut(StrictModel):
    attempt_id: str
    level: int
    board: list[list[int]]
    three_star_moves: int
    two_star_moves: int
    hints_left: int
    guest_ticket: str | None = None


class CompleteIn(StrictModel):
    attempt_id: AttemptId
    moves: Moves


class CompleteOut(StrictModel):
    level: int
    moves: int
    stars: int
    best_stars: int
    unlocked_level: int
    registration_required: bool
    guest_ticket: str | None = None


class HintIn(StrictModel):
    attempt_id: AttemptId
    moves: Moves


class HintOut(StrictModel):
    move: tuple[int, int] | None
    dead_end: bool = False
    hints_left: int


def _attempt_key(attempt_id: str) -> str:
    return f"ws:attempt:{attempt_id}"


def _level(state: AppState, level: int) -> WsLevel:
    found = state.levels.water_sort.get(level)
    if found is None:
        raise ApiError(404, "level_not_found", "No such level.")
    return found


async def _load_attempt(state: AppState, who: Principal, attempt_id: str, level: int) -> dict:  # type: ignore[type-arg]
    attempt = await store.get_json(state.redis, _attempt_key(attempt_id))
    # Same error for "missing" and "someone else's": don't confirm other players' ids.
    if attempt is None or attempt.get("owner") != who.owner or attempt.get("level") != level:
        raise ApiError(
            404, "attempt_not_found", "This game session has expired. Restart the level."
        )
    return attempt


@router.post("/levels/{level}/start")
async def start(
    level: LevelPath, request: Request, who: PrincipalDep, state: StateDep, db: DbDep
) -> StartOut:
    await limit(state, request, who, "ws-start", 30)
    await ensure_playable(db, state, who, GAME, level)
    lvl = _level(state, level)
    attempt_id = store.new_id()
    await store.put_json(
        state.redis,
        _attempt_key(attempt_id),
        {"owner": who.owner, "level": level, "issued_ms": int(time.time() * 1000)},
    )
    three, two = lvl.star_thresholds
    return StartOut(
        attempt_id=attempt_id,
        level=level,
        board=lvl.board(),
        three_star_moves=three,
        two_star_moves=two,
        hints_left=await hints.remaining(db, state, who, GAME),
        guest_ticket=issue_ticket(state, who.guest) if who.guest else None,
    )


@router.post("/levels/{level}/complete")
async def complete(
    level: LevelPath,
    body: CompleteIn,
    request: Request,
    who: PrincipalDep,
    state: StateDep,
    db: DbDep,
) -> CompleteOut:
    await limit(state, request, who, "ws-complete", 30)
    lvl = _level(state, level)
    key = _attempt_key(body.attempt_id)
    async with store.lock(state.redis, key):
        attempt = await _load_attempt(state, who, body.attempt_id, level)
        if "result" in attempt:
            # Idempotent: a retried request gets the original answer, never new progress.
            return CompleteOut.model_validate(attempt["result"])

        elapsed_ms = int(time.time() * 1000) - int(attempt["issued_ms"])
        if elapsed_ms < len(body.moves) * state.settings.ws_min_ms_per_move:
            raise ApiError(422, "too_fast", "That was faster than humanly possible.")

        try:
            solved = await state.run_engine(arc_engine.ws_replay, lvl.board(), list(body.moves))
        except arc_engine.EngineError as exc:
            raise ApiError(422, "illegal_move", "The move list contains an illegal pour.") from exc
        if not solved:
            raise ApiError(422, "not_solved", "The board is not solved.")

        stars = lvl.stars_for(len(body.moves))
        outcome = await record_win(db, state, who, GAME, level, stars, len(body.moves))
        result = CompleteOut(
            level=level,
            moves=len(body.moves),
            stars=stars,
            best_stars=outcome.best_stars,
            unlocked_level=outcome.unlocked_level,
            registration_required=outcome.registration_required,
            guest_ticket=outcome.guest_ticket,
        )
        attempt["result"] = result.model_dump()
        await store.put_json(state.redis, key, attempt)
        return result


@router.post("/levels/{level}/hint")
async def hint(
    level: LevelPath, body: HintIn, request: Request, who: PrincipalDep, state: StateDep, db: DbDep
) -> HintOut:
    await limit(state, request, who, "hint", 10)
    lvl = _level(state, level)
    attempt = await _load_attempt(state, who, body.attempt_id, level)
    if "result" in attempt:
        raise ApiError(409, "already_complete", "This level is already complete.")
    await hints.require_available(db, state, who, GAME)

    try:
        kind, move = await state.run_engine(
            arc_engine.ws_hint, lvl.board(), list(body.moves), state.settings.ws_hint_budget
        )
    except arc_engine.EngineError as exc:
        raise ApiError(422, "illegal_move", "The move list contains an illegal pour.") from exc

    if kind == "dead_end":
        # Not charged: the player needs to undo, not a move.
        left = await hints.remaining(db, state, who, GAME)
        return HintOut(move=None, dead_end=True, hints_left=left)
    if kind != "move" or move is None:
        raise ApiError(503, "hint_unavailable", "No hint available right now. Not charged.")
    left = await hints.consume(db, state, who, GAME)
    return HintOut(move=move, hints_left=left)
