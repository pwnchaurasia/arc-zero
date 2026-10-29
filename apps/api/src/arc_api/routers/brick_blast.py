"""Brick Blast: the server simulates every turn.

The client sends one integer per turn (the aim). The server runs the full
physics turn with the shared engine, keeps the authoritative state in Redis,
and only then reveals the next row. Upcoming rows never leave the server.
"""

from __future__ import annotations

import json
import time
from typing import Annotated, Any

import arc_engine
from fastapi import APIRouter, Path, Request
from pydantic import Field

from arc_api import hints, store
from arc_api.errors import ApiError
from arc_api.levels import GameId
from arc_api.principal import Principal, PrincipalDep, issue_ticket
from arc_api.progress import ensure_playable, record_win
from arc_api.routers.common import StrictModel, limit
from arc_api.state import AppState, DbDep, StateDep

GAME: GameId = "brick-blast"
router = APIRouter(prefix="/games/brick-blast", tags=["brick-blast"])

LevelPath = Annotated[int, Path(ge=1, le=10_000)]
RunPath = Annotated[str, Path(pattern=r"^[A-Za-z0-9_-]{16,64}$")]


class StartOut(StrictModel):
    run_id: str
    level: int
    state: dict[str, Any]
    hints_left: int
    guest_ticket: str | None = None


class TurnIn(StrictModel):
    turn: int = Field(ge=0, le=1000)
    aim: int = Field(ge=arc_engine.BB_AIM_MIN, le=arc_engine.BB_AIM_MAX)


class TurnOut(StrictModel):
    turn: int
    hash: str
    status: str
    state: dict[str, Any]
    new_row: list[dict[str, Any]] | None
    stars: int
    unlocked_level: int | None = None
    registration_required: bool = False
    guest_ticket: str | None = None


class HintOut(StrictModel):
    aim: int
    hints_left: int


def _run_key(run_id: str) -> str:
    return f"bb:run:{run_id}"


async def _load_run(state: AppState, who: Principal, run_id: str) -> dict[str, Any]:
    run = await store.get_json(state.redis, _run_key(run_id))
    if run is None or run.get("owner") != who.owner:
        raise ApiError(404, "run_not_found", "This game session has expired. Restart the level.")
    return run


def _public(state_json: str) -> dict[str, Any]:
    data = json.loads(arc_engine.bb_public_state(state_json))
    assert isinstance(data, dict)
    return data


@router.post("/levels/{level}/start")
async def start(
    level: LevelPath, request: Request, who: PrincipalDep, state: StateDep, db: DbDep
) -> StartOut:
    await limit(state, request, who, "bb-start", 30)
    await ensure_playable(db, state, who, GAME, level)
    lvl = state.levels.brick_blast[level]
    state_json = arc_engine.bb_new_run(lvl.script_json)
    run_id = store.new_id()
    await store.put_json(
        state.redis,
        _run_key(run_id),
        {"owner": who.owner, "level": level, "state": state_json, "last_turn_ms": 0},
    )
    return StartOut(
        run_id=run_id,
        level=level,
        state=_public(state_json),
        hints_left=await hints.remaining(db, state, who, GAME),
        guest_ticket=issue_ticket(state, who.guest) if who.guest else None,
    )


@router.post("/runs/{run_id}/turn")
async def turn(
    run_id: RunPath, body: TurnIn, request: Request, who: PrincipalDep, state: StateDep, db: DbDep
) -> TurnOut:
    await limit(state, request, who, "bb-turn", 120)
    key = _run_key(run_id)
    async with store.lock(state.redis, key):
        run = await _load_run(state, who, run_id)
        current = json.loads(run["state"])
        if current["status"] != "playing":
            raise ApiError(
                409, "run_over", "This game is over.", extra={"state": _public(run["state"])}
            )
        if body.turn != current["turn"]:
            # Retries and out-of-order turns resync to the server's truth.
            raise ApiError(
                409, "turn_mismatch", "Out of sync.", extra={"state": _public(run["state"])}
            )
        now_ms = int(time.time() * 1000)
        if now_ms - int(run["last_turn_ms"]) < state.settings.bb_min_ms_between_turns:
            raise ApiError(429, "too_fast", "Slow down.")

        try:
            result = await state.run_engine(arc_engine.bb_play_turn, run["state"], body.aim)
        except arc_engine.EngineError as exc:
            raise ApiError(422, "invalid_turn", "That turn could not be played.") from exc

        run["state"] = result.state
        run["last_turn_ms"] = now_ms
        out = TurnOut(
            turn=result.turn,
            hash=result.hash,
            status=result.status,
            state=json.loads(result.public_state),
            new_row=json.loads(result.new_row) if result.new_row else None,
            stars=result.stars,
        )
        if result.status == "won":
            outcome = await record_win(db, state, who, GAME, int(run["level"]), result.stars, None)
            out = out.model_copy(
                update={
                    "unlocked_level": outcome.unlocked_level,
                    "registration_required": outcome.registration_required,
                    "guest_ticket": outcome.guest_ticket,
                }
            )
        await store.put_json(state.redis, key, run)
        return out


@router.post("/runs/{run_id}/hint")
async def hint(
    run_id: RunPath, request: Request, who: PrincipalDep, state: StateDep, db: DbDep
) -> HintOut:
    await limit(state, request, who, "hint", 10)
    run = await _load_run(state, who, run_id)
    if json.loads(run["state"])["status"] != "playing":
        raise ApiError(409, "run_over", "This game is over.")
    await hints.require_available(db, state, who, GAME)
    aim = await state.run_engine(
        arc_engine.bb_best_aim, run["state"], state.settings.bb_hint_candidates
    )
    if aim is None:
        raise ApiError(503, "hint_unavailable", "No hint available right now. Not charged.")
    left = await hints.consume(db, state, who, GAME)
    return HintOut(aim=aim, hints_left=left)
