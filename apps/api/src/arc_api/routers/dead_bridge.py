"""Dead Bridge Assault: start a level, sell assists, verify a win by replaying inputs.

The game is real time, but the browser sends only its inputs (steering and assist
buttons, 3 bytes per change). The server replays the whole level with the shared
engine: only what the replay produces counts. Assists bought with coins must have
been paid for in this attempt, and the level can't have been played faster than real
time.
"""

from __future__ import annotations

import base64
import binascii
import json
import time
from typing import Annotated, Any, Literal

import arc_engine
from fastapi import APIRouter, Path, Request
from pydantic import Field

from arc_api import analytics, coins, store
from arc_api.errors import ApiError
from arc_api.levels import DbLevel, GameId
from arc_api.principal import Principal, PrincipalDep, issue_ticket
from arc_api.progress import ensure_playable, record_win
from arc_api.routers.common import StrictModel, limit
from arc_api.state import AppState, DbDep, StateDep

GAME: GameId = "dead-bridge"
router = APIRouter(prefix="/games/dead-bridge", tags=["dead-bridge"])

# Engine order: AssistKind codes 0-6.
ASSISTS: tuple[str, ...] = ("airstrike", "freeze", "drones", "lance", "napalm", "barrage", "nuke")
MAX_BOUGHT_EACH = 3

LevelPath = Annotated[int, Path(ge=1, le=10_000)]
AttemptId = Annotated[str, Field(pattern=r"^[A-Za-z0-9_-]{16,64}$")]
AssistName = Literal["airstrike", "freeze", "drones", "lance", "napalm", "barrage", "nuke"]


class StartOut(StrictModel):
    attempt_id: str
    level: int
    script: dict[str, Any]
    prices: dict[str, int]
    reward: int
    coins: int
    guest_ticket: str | None = None


class BuyIn(StrictModel):
    attempt_id: AttemptId
    kind: AssistName
    # The price the player confirmed. A mismatch means it changed: ask again.
    price: int = Field(ge=0, le=10_000)


class BuyOut(StrictModel):
    coins: int
    owned: dict[str, int]
    spent: int


class CompleteIn(StrictModel):
    attempt_id: AttemptId
    # The input log, base64 (3 bytes per record; see the engine's InputLog).
    log: str = Field(max_length=32_000, pattern=r"^[A-Za-z0-9+/]*={0,2}$")


class CompleteOut(StrictModel):
    level: int
    stars: int
    best_stars: int
    unlocked_level: int
    registration_required: bool
    base_hp: int
    kills: int
    seconds: int
    first_clear: bool
    coins_earned: int
    streak_bonus: int
    coins: int
    guest_ticket: str | None = None


def _attempt_key(attempt_id: str) -> str:
    return f"db:attempt:{attempt_id}"


def _level(state: AppState, level: int) -> DbLevel:
    found = state.levels.dead_bridge.get(level)
    if found is None:
        raise ApiError(404, "level_not_found", "No such level.")
    return found


async def _load_attempt(
    state: AppState, who: Principal, attempt_id: str, level: int
) -> dict[str, Any]:
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
    await limit(state, request, who, "db-start", 30)
    await ensure_playable(db, state, who, GAME, level)
    lvl = _level(state, level)
    attempt_id = store.new_id()
    await store.put_json(
        state.redis,
        _attempt_key(attempt_id),
        {
            "owner": who.owner,
            "level": level,
            "issued_ms": int(time.time() * 1000),
            "bought": {},
            "spent": 0,
        },
    )
    await analytics.record(db, state, who, "start", GAME, level)
    return StartOut(
        attempt_id=attempt_id,
        level=level,
        script=json.loads(lvl.script_json),
        prices=coins.PRICES[GAME],
        reward=coins.clear_reward(level),
        coins=await coins.balance(db, state, who),
        guest_ticket=issue_ticket(state, who.guest) if who.guest else None,
    )


@router.post("/levels/{level}/assists")
async def buy_assist(
    level: LevelPath, body: BuyIn, request: Request, who: PrincipalDep, state: StateDep, db: DbDep
) -> BuyOut:
    await limit(state, request, who, "db-buy", 20)
    price = coins.PRICES[GAME][body.kind]
    if body.price != price:
        raise ApiError(
            409, "price_changed", f"The price is now {price} coins.", extra={"price": price}
        )
    key = _attempt_key(body.attempt_id)
    async with store.lock(state.redis, key):
        attempt = await _load_attempt(state, who, body.attempt_id, level)
        if "result" in attempt:
            raise ApiError(409, "already_complete", "This level is already complete.")
        bought: dict[str, int] = attempt.setdefault("bought", {})
        if bought.get(body.kind, 0) >= MAX_BOUGHT_EACH:
            raise ApiError(409, "assist_limit", "You can't buy more of that in this attempt.")
        left = await coins.spend(db, state, who, price, GAME, level, body.kind)
        bought[body.kind] = bought.get(body.kind, 0) + 1
        attempt["spent"] = int(attempt.get("spent", 0)) + price
        await store.put_json(state.redis, key, attempt)
        await analytics.record(db, state, who, "assist", GAME, level, coins=price, detail=body.kind)
        return BuyOut(coins=left, owned=bought, spent=attempt["spent"])


@router.post("/levels/{level}/complete")
async def complete(
    level: LevelPath,
    body: CompleteIn,
    request: Request,
    who: PrincipalDep,
    state: StateDep,
    db: DbDep,
) -> CompleteOut:
    await limit(state, request, who, "db-complete", 20)
    lvl = _level(state, level)
    key = _attempt_key(body.attempt_id)
    async with store.lock(state.redis, key):
        attempt = await _load_attempt(state, who, body.attempt_id, level)
        if "result" in attempt:
            # Idempotent: a retried request gets the original answer, never new coins.
            return CompleteOut.model_validate(attempt["result"])
        try:
            log = base64.b64decode(body.log, validate=True)
        except binascii.Error as exc:
            raise ApiError(422, "bad_log", "The input log is not valid.") from exc

        try:
            result = await state.run_engine(arc_engine.db_replay, lvl.script_json, log)
        except arc_engine.EngineError as exc:
            raise ApiError(422, "bad_log", "The input log does not replay.") from exc

        bought = attempt.get("bought", {})
        for name, used in zip(ASSISTS, result.bought, strict=True):
            if used > int(bought.get(name, 0)):
                raise ApiError(422, "assist_not_bought", "That assist was not bought.")
        elapsed_ms = int(time.time() * 1000) - int(attempt["issued_ms"])
        simulated_ms = result.ticks * 1000 // arc_engine.DB_TPS
        if elapsed_ms * 100 < simulated_ms * state.settings.db_min_real_time_pct:
            raise ApiError(422, "too_fast", "That was faster than real time.")
        if result.status != "won":
            await analytics.record(
                db, state, who, "lost", GAME, level, detail=f"kills:{result.kills}"
            )
            raise ApiError(422, "not_won", "The horde broke through.")

        spent = int(attempt.get("spent", 0))
        # Players: staged in the same transaction that record_win commits.
        paid = await coins.award_clear(db, state, who, GAME, level, spent=spent, assisted=spent > 0)
        outcome = await record_win(db, state, who, GAME, level, result.stars, None)
        out = CompleteOut(
            level=level,
            stars=result.stars,
            best_stars=outcome.best_stars,
            unlocked_level=outcome.unlocked_level,
            registration_required=outcome.registration_required,
            base_hp=result.base_hp,
            kills=result.kills,
            seconds=result.ticks // arc_engine.DB_TPS,
            first_clear=paid.first_clear,
            coins_earned=paid.earned,
            streak_bonus=paid.streak_bonus,
            coins=paid.balance,
            guest_ticket=outcome.guest_ticket,
        )
        attempt["result"] = out.model_dump()
        await store.put_json(state.redis, key, attempt)
        await analytics.record(
            db,
            state,
            who,
            "clear",
            GAME,
            level,
            stars=result.stars,
            coins=paid.earned + paid.streak_bonus,
            detail=f"kills:{result.kills}",
        )
        return out
