"""MetroJam: start a level, reveal the queue as it moves, sell assists, verify a win.

The client sends only its moves. The server replays them on the full level
(including the hidden end of the queue) with the shared engine, and only
accepts assists this attempt paid for.
"""

from __future__ import annotations

import json
import time
from typing import Annotated, Any, Literal

import arc_engine
from fastapi import APIRouter, Path, Request
from pydantic import Field

from arc_api import analytics, coins, store
from arc_api.errors import ApiError
from arc_api.levels import GameId, MjLevel
from arc_api.principal import Principal, PrincipalDep, issue_ticket
from arc_api.progress import ensure_playable, record_win
from arc_api.routers.common import StrictModel, limit
from arc_api.state import AppState, DbDep, StateDep

GAME: GameId = "metro-jam"
router = APIRouter(prefix="/games/metro-jam", tags=["metro-jam"])

# Same order as the engine's `assists_used`: [airlifts, shuffles, extra bays].
ASSIST_ORDER: tuple[str, ...] = ("airlift", "shuffle", "extra_bay")
# Per attempt. Extra bays are capped by the engine too.
MAX_BOUGHT: dict[str, int] = {"airlift": 3, "shuffle": 3, "extra_bay": 2}

LevelPath = Annotated[int, Path(ge=1, le=10_000)]
AttemptId = Annotated[str, Field(pattern=r"^[A-Za-z0-9_-]{16,64}$")]
Op = Annotated[int, Field(ge=0, le=3)]
VehicleIndex = Annotated[int, Field(ge=0, le=255)]
Moves = Annotated[list[tuple[Op, VehicleIndex]], Field(max_length=arc_engine.MJ_MAX_MOVES)]
AssistKind = Literal["airlift", "shuffle", "extra_bay"]


class StartOut(StrictModel):
    attempt_id: str
    level: int
    data: dict[str, Any]
    prices: dict[str, int]
    reward: int
    coins: int
    guest_ticket: str | None = None


class MovesIn(StrictModel):
    attempt_id: AttemptId
    moves: Moves


class RevealOut(StrictModel):
    queue: list[int]


class BuyIn(StrictModel):
    attempt_id: AttemptId
    kind: AssistKind
    # The price the player confirmed. A mismatch means it changed: ask again.
    price: int = Field(ge=0, le=10_000)


class BuyOut(StrictModel):
    coins: int
    owned: dict[str, int]
    spent: int


class CompleteOut(StrictModel):
    level: int
    stars: int
    best_stars: int
    unlocked_level: int
    registration_required: bool
    first_clear: bool
    coins_earned: int
    streak_bonus: int
    coins: int
    guest_ticket: str | None = None


def _attempt_key(attempt_id: str) -> str:
    return f"mj:attempt:{attempt_id}"


def _level(state: AppState, level: int) -> MjLevel:
    found = state.levels.metro_jam.get(level)
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


async def _replay(
    state: AppState, lvl: MjLevel, attempt: dict[str, Any], moves: list[tuple[int, int]]
) -> Any:
    try:
        result = await state.run_engine(arc_engine.mj_replay, lvl.level_json, moves)
    except arc_engine.EngineError as exc:
        raise ApiError(422, "illegal_move", "The move list contains an illegal move.") from exc
    bought = attempt.get("bought", {})
    for kind, used in zip(ASSIST_ORDER, result.assists, strict=True):
        if used > int(bought.get(kind, 0)):
            raise ApiError(422, "assist_not_bought", "That assist was not bought.")
    return result


@router.post("/levels/{level}/start")
async def start(
    level: LevelPath, request: Request, who: PrincipalDep, state: StateDep, db: DbDep
) -> StartOut:
    await limit(state, request, who, "mj-start", 30)
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
        data=json.loads(lvl.public_json),
        prices=coins.PRICES,
        reward=coins.clear_reward(level),
        coins=await coins.balance(db, state, who),
        guest_ticket=issue_ticket(state, who.guest) if who.guest else None,
    )


@router.post("/levels/{level}/reveal")
async def reveal(
    level: LevelPath, body: MovesIn, request: Request, who: PrincipalDep, state: StateDep
) -> RevealOut:
    """The queue up to what the player may now see, after replaying their moves."""
    await limit(state, request, who, "mj-reveal", 240)
    lvl = _level(state, level)
    attempt = await _load_attempt(state, who, body.attempt_id, level)
    result = await _replay(state, lvl, attempt, list(body.moves))
    return RevealOut(queue=list(result.revealed))


@router.post("/levels/{level}/assists")
async def buy_assist(
    level: LevelPath, body: BuyIn, request: Request, who: PrincipalDep, state: StateDep, db: DbDep
) -> BuyOut:
    await limit(state, request, who, "mj-buy", 20)
    price = coins.PRICES[body.kind]
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
        if bought.get(body.kind, 0) >= MAX_BOUGHT[body.kind]:
            raise ApiError(409, "assist_limit", "You can't buy more of that in this attempt.")
        left = await coins.spend(db, state, who, price, GAME, level, body.kind)
        bought[body.kind] = bought.get(body.kind, 0) + 1
        attempt["spent"] = int(attempt.get("spent", 0)) + price
        await store.put_json(state.redis, key, attempt)
        await analytics.record(db, state, who, "assist", GAME, level, coins=price, detail=body.kind)
        return BuyOut(coins=left, owned=bought, spent=attempt["spent"])


@router.post("/levels/{level}/complete")
async def complete(
    level: LevelPath, body: MovesIn, request: Request, who: PrincipalDep, state: StateDep, db: DbDep
) -> CompleteOut:
    await limit(state, request, who, "mj-complete", 30)
    lvl = _level(state, level)
    key = _attempt_key(body.attempt_id)
    async with store.lock(state.redis, key):
        attempt = await _load_attempt(state, who, body.attempt_id, level)
        if "result" in attempt:
            # Idempotent: a retried request gets the original answer, never new coins.
            return CompleteOut.model_validate(attempt["result"])

        taps = sum(1 for op, _ in body.moves if op == 0)
        elapsed_ms = int(time.time() * 1000) - int(attempt["issued_ms"])
        if elapsed_ms < taps * state.settings.mj_min_ms_per_move:
            raise ApiError(422, "too_fast", "That was faster than humanly possible.")

        result = await _replay(state, lvl, attempt, list(body.moves))
        if not result.won:
            raise ApiError(422, "not_won", "Not every commuter has boarded.")

        used = sum(result.assists)
        stars = 3 if used == 0 else 2 if used == 1 else 1
        spent = int(attempt.get("spent", 0))
        # Players: staged in the same transaction that record_win commits.
        paid = await coins.award_clear(
            db, state, who, GAME, level, spent=spent, assisted=spent > 0 or used > 0
        )
        outcome = await record_win(db, state, who, GAME, level, stars, len(body.moves))
        out = CompleteOut(
            level=level,
            stars=stars,
            best_stars=outcome.best_stars,
            unlocked_level=outcome.unlocked_level,
            registration_required=outcome.registration_required,
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
            stars=stars,
            coins=paid.earned + paid.streak_bonus,
            detail=f"assists:{used}",
        )
        return out
