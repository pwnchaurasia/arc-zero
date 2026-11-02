"""Water Sort: start a level, reveal hidden colours, verify a completion by replay,
sell assists, give hints.

The client sends only its moves. The server rebuilds the board from the secret
level seed, replays every move with the shared engine, and decides whether the
level is solved and how many stars it earns. On hidden levels the client only
ever receives a masked board: true colours stay here until they are uncovered.
"""

from __future__ import annotations

import time
from typing import Annotated, Any, Literal

import arc_engine
from fastapi import APIRouter, Path, Request
from pydantic import Field

from arc_api import analytics, coins, hints, store
from arc_api.errors import ApiError
from arc_api.levels import GameId, WsLevel
from arc_api.principal import Principal, PrincipalDep, issue_ticket
from arc_api.progress import ensure_playable, record_win
from arc_api.routers.common import StrictModel, limit
from arc_api.state import AppState, DbDep, StateDep

GAME: GameId = "water-sort"
router = APIRouter(prefix="/games/water-sort", tags=["water-sort"])

LevelPath = Annotated[int, Path(ge=1, le=10_000)]
# Bottle indices, plus 254 for the "add a bottle" move; the engine checks the rest.
BottleIndex = Annotated[int, Field(ge=0, le=254)]
AttemptId = Annotated[str, Field(pattern=r"^[A-Za-z0-9_-]{16,64}$")]
Moves = Annotated[list[tuple[BottleIndex, BottleIndex]], Field(max_length=arc_engine.WS_MAX_MOVES)]


class StartOut(StrictModel):
    attempt_id: str
    level: int
    capacity: int
    hidden: bool
    # Masked on hidden levels: 255 marks a colour not seen yet.
    board: list[list[int]]
    three_star_moves: int
    two_star_moves: int
    hints_left: int
    prices: dict[str, int]
    hint_price: int
    reward: int
    coins: int
    guest_ticket: str | None = None


class MovesIn(StrictModel):
    attempt_id: AttemptId
    moves: Moves


class ViewOut(StrictModel):
    board: list[list[int]]


class CompleteOut(StrictModel):
    level: int
    moves: int
    stars: int
    best_stars: int
    unlocked_level: int
    registration_required: bool
    first_clear: bool = False
    coins_earned: int = 0
    streak_bonus: int = 0
    coins: int | None = None
    guest_ticket: str | None = None


class HintIn(StrictModel):
    attempt_id: AttemptId
    moves: Moves
    # The coin price the player confirmed, once the free hints are used up.
    pay: int | None = Field(default=None, ge=0, le=10_000)


class HintOut(StrictModel):
    move: tuple[int, int] | None
    dead_end: bool = False
    hints_left: int
    coins: int | None = None


class BuyIn(StrictModel):
    attempt_id: AttemptId
    kind: Literal["extra_bottle"]
    price: int = Field(ge=0, le=10_000)


class BuyOut(StrictModel):
    coins: int
    owned: dict[str, int]
    spent: int


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


def _check_bottles(attempt: dict[str, Any], moves: list[tuple[int, int]]) -> None:
    """Extra bottles in the move list must have been bought for this attempt."""
    if arc_engine.ws_bottles_added(moves) > int(attempt.get("bought", {}).get("extra_bottle", 0)):
        raise ApiError(422, "assist_not_bought", "That extra bottle was not bought.")


async def _view(
    state: AppState, lvl: WsLevel, attempt: dict[str, Any], moves: list[tuple[int, int]]
) -> list[list[int]]:
    """The board the player may see after `moves`; remembers what they have seen."""
    try:
        board, seen = await state.run_engine(
            arc_engine.ws_view,
            lvl.board(),
            lvl.capacity,
            moves,
            lvl.hidden,
            attempt.get("seen", ""),
        )
    except arc_engine.EngineError as exc:
        raise ApiError(422, "illegal_move", "The move list contains an illegal pour.") from exc
    attempt["seen"] = seen
    return board


@router.post("/levels/{level}/start")
async def start(
    level: LevelPath, request: Request, who: PrincipalDep, state: StateDep, db: DbDep
) -> StartOut:
    await limit(state, request, who, "ws-start", 30)
    await ensure_playable(db, state, who, GAME, level)
    lvl = _level(state, level)
    attempt_id = store.new_id()
    attempt: dict[str, Any] = {
        "owner": who.owner,
        "level": level,
        "issued_ms": int(time.time() * 1000),
        "bought": {},
        "spent": 0,
    }
    board = await _view(state, lvl, attempt, [])
    await store.put_json(state.redis, _attempt_key(attempt_id), attempt)
    three, two = lvl.star_thresholds
    await analytics.record(db, state, who, "start", GAME, level)
    return StartOut(
        attempt_id=attempt_id,
        level=level,
        capacity=lvl.capacity,
        hidden=lvl.hidden,
        board=board,
        three_star_moves=three,
        two_star_moves=two,
        hints_left=await hints.remaining(db, state, who, GAME),
        prices=coins.PRICES[GAME],
        hint_price=coins.HINT_PRICE,
        reward=coins.clear_reward(level),
        coins=await coins.balance(db, state, who),
        guest_ticket=issue_ticket(state, who.guest) if who.guest else None,
    )


@router.post("/levels/{level}/reveal")
async def reveal(
    level: LevelPath, body: MovesIn, request: Request, who: PrincipalDep, state: StateDep
) -> ViewOut:
    """The board after the player's moves, with newly uncovered colours shown."""
    await limit(state, request, who, "ws-reveal", 240)
    lvl = _level(state, level)
    key = _attempt_key(body.attempt_id)
    async with store.lock(state.redis, key):
        attempt = await _load_attempt(state, who, body.attempt_id, level)
        _check_bottles(attempt, list(body.moves))
        board = await _view(state, lvl, attempt, list(body.moves))
        await store.put_json(state.redis, key, attempt)
        return ViewOut(board=board)


@router.post("/levels/{level}/assists")
async def buy_assist(
    level: LevelPath, body: BuyIn, request: Request, who: PrincipalDep, state: StateDep, db: DbDep
) -> BuyOut:
    await limit(state, request, who, "ws-buy", 20)
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
        if bought.get(body.kind, 0) >= arc_engine.WS_MAX_EXTRA_BOTTLES:
            raise ApiError(409, "assist_limit", "You can't add more bottles in this attempt.")
        left = await coins.spend(db, state, who, price, GAME, level, body.kind)
        bought[body.kind] = bought.get(body.kind, 0) + 1
        attempt["spent"] = int(attempt.get("spent", 0)) + price
        await store.put_json(state.redis, key, attempt)
        await analytics.record(db, state, who, "assist", GAME, level, coins=price, detail=body.kind)
        return BuyOut(coins=left, owned=bought, spent=attempt["spent"])


@router.post("/levels/{level}/complete")
async def complete(
    level: LevelPath,
    body: MovesIn,
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

        moves = list(body.moves)
        elapsed_ms = int(time.time() * 1000) - int(attempt["issued_ms"])
        if elapsed_ms < len(moves) * state.settings.ws_min_ms_per_move:
            raise ApiError(422, "too_fast", "That was faster than humanly possible.")
        _check_bottles(attempt, moves)

        try:
            solved = await state.run_engine(arc_engine.ws_replay, lvl.board(), lvl.capacity, moves)
        except arc_engine.EngineError as exc:
            raise ApiError(422, "illegal_move", "The move list contains an illegal pour.") from exc
        if not solved:
            raise ApiError(422, "not_solved", "The board is not solved.")

        pours = len(moves) - arc_engine.ws_bottles_added(moves)
        stars = lvl.stars_for(pours)
        spent = int(attempt.get("spent", 0))
        # Players: staged in the same transaction that record_win commits.
        paid = await coins.award_clear(db, state, who, GAME, level, spent=spent, assisted=spent > 0)
        outcome = await record_win(db, state, who, GAME, level, stars, pours)
        result = CompleteOut(
            level=level,
            moves=pours,
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
        attempt["result"] = result.model_dump()
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
            detail=f"moves:{pours}",
        )
        return result


@router.post("/levels/{level}/hint")
async def hint(
    level: LevelPath, body: HintIn, request: Request, who: PrincipalDep, state: StateDep, db: DbDep
) -> HintOut:
    await limit(state, request, who, "hint", 10)
    lvl = _level(state, level)
    key = _attempt_key(body.attempt_id)
    async with store.lock(state.redis, key):
        attempt = await _load_attempt(state, who, body.attempt_id, level)
        if "result" in attempt:
            raise ApiError(409, "already_complete", "This level is already complete.")
        moves = list(body.moves)
        _check_bottles(attempt, moves)
        if await hints.remaining(db, state, who, GAME) <= 0 and body.pay != coins.HINT_PRICE:
            # Checked before spending CPU on the search.
            raise ApiError(
                429,
                "no_hints_left",
                f"No free hints left today. A hint costs {coins.HINT_PRICE} coins.",
                extra={"price": coins.HINT_PRICE},
            )
        try:
            kind, move = await state.run_engine(
                arc_engine.ws_hint, lvl.board(), lvl.capacity, moves, state.settings.ws_hint_budget
            )
        except arc_engine.EngineError as exc:
            raise ApiError(422, "illegal_move", "The move list contains an illegal pour.") from exc

        if kind == "dead_end":
            # Not charged: the player needs to undo, not a move.
            left = await hints.remaining(db, state, who, GAME)
            return HintOut(move=None, dead_end=True, hints_left=left)
        if kind != "move" or move is None:
            raise ApiError(503, "hint_unavailable", "No hint available right now. Not charged.")
        left, balance, charged = await hints.take(db, state, who, GAME, level, body.pay)
        if charged:
            attempt["spent"] = int(attempt.get("spent", 0)) + charged
            await store.put_json(state.redis, key, attempt)
        await analytics.record(db, state, who, "hint", GAME, level, coins=charged or None)
        return HintOut(move=move, hints_left=left, coins=balance)
