"""Cipher9 (Sudoku): start a level, sell hints and assists, verify a win by replaying moves.

The client only ever gets the givens. The solution stays here: the replay decides the
win, counts mistakes (numbers that weren't the solution's) for the stars, and pays the
coins. Hints and "clear wrong numbers" are the only answers that leave the server, and
only after the player confirmed their price.
"""

from __future__ import annotations

import time
from typing import Annotated, Any, Literal

import arc_engine
from fastapi import APIRouter, Path, Request
from pydantic import Field

from arc_api import analytics, coins, store
from arc_api.errors import ApiError
from arc_api.levels import C9Level, GameId
from arc_api.principal import Principal, PrincipalDep, issue_ticket
from arc_api.progress import ensure_playable, record_win
from arc_api.routers.common import StrictModel, limit
from arc_api.state import AppState, DbDep, StateDep

GAME: GameId = "cipher9"
router = APIRouter(prefix="/games/cipher9", tags=["cipher9"])

LevelPath = Annotated[int, Path(ge=1, le=10_000)]
AttemptId = Annotated[str, Field(pattern=r"^[A-Za-z0-9_-]{16,64}$")]
Cell = Annotated[int, Field(ge=0, le=80)]
Digit = Annotated[int, Field(ge=0, le=9)]
Moves = Annotated[list[tuple[Cell, Digit]], Field(max_length=arc_engine.C9_MAX_MOVES)]


class LevelData(StrictModel):
    # 81 givens, row by row, 0 for an empty cell.
    puzzle: list[int]
    tier: str
    technique: str


class StartOut(StrictModel):
    attempt_id: str
    level: int
    data: LevelData
    prices: dict[str, int]
    reward: int
    coins: int
    guest_ticket: str | None = None


class MovesIn(StrictModel):
    attempt_id: AttemptId
    moves: Moves


class PricedIn(MovesIn):
    # The price the player confirmed. A mismatch means it changed: ask again.
    price: int = Field(ge=0, le=10_000)


class BuyIn(PricedIn):
    kind: Literal["auto_notes", "clear_wrong"]


class BuyOut(StrictModel):
    coins: int
    owned: dict[str, int]
    spent: int
    # For "clear_wrong": the cells to empty.
    wrong: list[int] = Field(default_factory=list)


class HintOut(StrictModel):
    cell: int
    digit: int
    technique: str | None
    unit_kind: Literal["row", "column", "box"] | None
    unit: int | None
    after: list[str]
    coins: int
    spent: int


class CompleteOut(StrictModel):
    level: int
    stars: int
    mistakes: int
    best_stars: int
    unlocked_level: int
    registration_required: bool
    first_clear: bool
    coins_earned: int
    streak_bonus: int
    coins: int
    guest_ticket: str | None = None


def _attempt_key(attempt_id: str) -> str:
    return f"c9:attempt:{attempt_id}"


def _level(state: AppState, level: int) -> C9Level:
    found = state.levels.cipher9.get(level)
    if found is None:
        raise ApiError(404, "level_not_found", "No such level.")
    return found


def _check_price(kind: str, offered: int) -> int:
    price = coins.PRICES[GAME][kind]
    if offered != price:
        raise ApiError(
            409, "price_changed", f"The price is now {price} coins.", extra={"price": price}
        )
    return price


async def _load_attempt(state: AppState, who: Principal, attempt_id: str, level: int) -> dict:  # type: ignore[type-arg]
    attempt = await store.get_json(state.redis, _attempt_key(attempt_id))
    # Same error for "missing" and "someone else's": don't confirm other players' ids.
    if attempt is None or attempt.get("owner") != who.owner or attempt.get("level") != level:
        raise ApiError(
            404, "attempt_not_found", "This game session has expired. Restart the level."
        )
    if "result" in attempt:
        raise ApiError(409, "already_complete", "This level is already complete.")
    return attempt


async def _replay(state: AppState, lvl: C9Level, moves: list[tuple[int, int]]) -> Any:
    try:
        return await state.run_engine(arc_engine.c9_replay, lvl.level_json, moves)
    except arc_engine.EngineError as exc:
        raise ApiError(422, "illegal_move", "The move list contains an illegal move.") from exc


async def _charge(
    state: AppState,
    db: DbDep,
    who: Principal,
    level: int,
    attempt: dict[str, Any],
    key: str,
    kind: str,
    price: int,
) -> int:
    """Takes the coins and records the spend on the attempt. Returns the balance."""
    left = await coins.spend(db, state, who, price, GAME, level, kind)
    bought: dict[str, int] = attempt.setdefault("bought", {})
    bought[kind] = bought.get(kind, 0) + 1
    attempt["spent"] = int(attempt.get("spent", 0)) + price
    await store.put_json(state.redis, key, attempt)
    await analytics.record(
        db,
        state,
        who,
        "hint" if kind == "hint" else "assist",
        GAME,
        level,
        coins=price,
        detail=None if kind == "hint" else kind,
    )
    return left


@router.post("/levels/{level}/start")
async def start(
    level: LevelPath, request: Request, who: PrincipalDep, state: StateDep, db: DbDep
) -> StartOut:
    await limit(state, request, who, "c9-start", 30)
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
        data=LevelData(puzzle=[int(d) for d in lvl.puzzle], tier=lvl.tier, technique=lvl.technique),
        prices=coins.PRICES[GAME],
        reward=coins.clear_reward(level),
        coins=await coins.balance(db, state, who),
        guest_ticket=issue_ticket(state, who.guest) if who.guest else None,
    )


@router.post("/levels/{level}/assists")
async def buy(
    level: LevelPath, body: BuyIn, request: Request, who: PrincipalDep, state: StateDep, db: DbDep
) -> BuyOut:
    """Auto-notes (once per attempt; the browser fills them in) or clearing every wrong
    number (charged only when there is one)."""
    await limit(state, request, who, "c9-buy", 20)
    price = _check_price(body.kind, body.price)
    lvl = _level(state, level)
    key = _attempt_key(body.attempt_id)
    async with store.lock(state.redis, key):
        attempt = await _load_attempt(state, who, body.attempt_id, level)
        wrong: list[int] = []
        if body.kind == "auto_notes":
            if attempt.get("bought", {}).get("auto_notes", 0) > 0:
                raise ApiError(409, "assist_limit", "Auto-notes are already on for this attempt.")
        else:
            result = await _replay(state, lvl, list(body.moves))
            wrong = list(result.wrong)
            if not wrong:
                raise ApiError(
                    409, "nothing_wrong", "Every number on the board is right. Not charged."
                )
        left = await _charge(state, db, who, level, attempt, key, body.kind, price)
        return BuyOut(coins=left, owned=attempt["bought"], spent=attempt["spent"], wrong=wrong)


@router.post("/levels/{level}/hint")
async def hint(
    level: LevelPath,
    body: PricedIn,
    request: Request,
    who: PrincipalDep,
    state: StateDep,
    db: DbDep,
) -> HintOut:
    """The next number a person could find, and how. Not charged if the grid is full."""
    await limit(state, request, who, "hint", 10)
    price = _check_price("hint", body.price)
    lvl = _level(state, level)
    key = _attempt_key(body.attempt_id)
    async with store.lock(state.redis, key):
        attempt = await _load_attempt(state, who, body.attempt_id, level)
        try:
            found = await state.run_engine(arc_engine.c9_hint, lvl.level_json, list(body.moves))
        except arc_engine.EngineError as exc:
            raise ApiError(422, "illegal_move", "The move list contains an illegal move.") from exc
        if found is None:
            raise ApiError(409, "hint_unavailable", "No hint needed right now. Not charged.")
        left = await _charge(state, db, who, level, attempt, key, "hint", price)
        return HintOut(
            cell=found.cell,
            digit=found.digit,
            technique=found.technique,
            unit_kind=found.unit_kind,
            unit=found.unit,
            after=list(found.after),
            coins=left,
            spent=attempt["spent"],
        )


@router.post("/levels/{level}/complete")
async def complete(
    level: LevelPath, body: MovesIn, request: Request, who: PrincipalDep, state: StateDep, db: DbDep
) -> CompleteOut:
    await limit(state, request, who, "c9-complete", 30)
    lvl = _level(state, level)
    key = _attempt_key(body.attempt_id)
    async with store.lock(state.redis, key):
        attempt = await store.get_json(state.redis, key)
        if attempt is not None and "result" in attempt and attempt.get("owner") == who.owner:
            # Idempotent: a retried request gets the original answer, never new coins.
            return CompleteOut.model_validate(attempt["result"])
        attempt = await _load_attempt(state, who, body.attempt_id, level)

        elapsed_ms = int(time.time() * 1000) - int(attempt["issued_ms"])
        if elapsed_ms < len(body.moves) * state.settings.c9_min_ms_per_move:
            raise ApiError(422, "too_fast", "That was faster than humanly possible.")

        result = await _replay(state, lvl, list(body.moves))
        if result.status != "won":
            raise ApiError(422, "not_won", "Some numbers are still missing or wrong.")

        spent = int(attempt.get("spent", 0))
        paid = await coins.award_clear(db, state, who, GAME, level, spent=spent, assisted=spent > 0)
        outcome = await record_win(db, state, who, GAME, level, result.stars, len(body.moves))
        out = CompleteOut(
            level=level,
            stars=result.stars,
            mistakes=result.mistakes,
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
            stars=result.stars,
            coins=paid.earned + paid.streak_bonus,
            detail=f"mistakes:{result.mistakes}",
            started_ms=attempt["issued_ms"],
        )
        return out
