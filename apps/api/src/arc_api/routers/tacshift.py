"""TacShift: matches against the AI, played move by move on the server.

The player is X and moves first; the server checks each move and answers with the
AI's, chosen with a seed that never leaves the server, so the AI can't be weakened
or a win faked. The first win against each AI tier pays once (coins.TACSHIFT_REWARDS),
minus coins spent in that match. Pass & Play runs in the browser and pays nothing.
"""

from __future__ import annotations

import json
import secrets
import time
from typing import Annotated, Any, Literal

import arc_engine
from fastapi import APIRouter, Path, Request
from pydantic import Field
from sqlalchemy import select

from arc_api import analytics, coins, store
from arc_api.db import CoinLedger
from arc_api.errors import ApiError
from arc_api.levels import GameId
from arc_api.principal import Principal, PrincipalDep, issue_ticket
from arc_api.routers.common import StrictModel, limit
from arc_api.state import AppState, DbDep, StateDep

GAME: GameId = "tacshift"
router = APIRouter(prefix="/games/tacshift", tags=["tacshift"])

Mode = Literal["infinity", "classic", "ultimate"]
Tier = Literal["easy", "medium", "hard"]
MatchPath = Annotated[str, Path(pattern=r"^[A-Za-z0-9_-]{16,64}$")]
# Undo goes back this many of the player's moves at most.
HISTORY = 30
# Seeds stay within 53 bits, like every seed the server stores.
SEED_MASK = (1 << 53) - 1


def _slot(mode: str, tier: str) -> int:
    """The tier's place in TACSHIFT_REWARDS, from 1: its "level" in first-clear records."""
    for i, (m, t, _) in enumerate(coins.TACSHIFT_REWARDS, start=1):
        if (m, t) == (mode, tier):
            return i
    raise ApiError(404, "tier_not_found", "No such AI tier.")


def _reward(mode: str, tier: str) -> int:
    return coins.TACSHIFT_REWARDS[_slot(mode, tier) - 1][2]


class StartIn(StrictModel):
    mode: Mode
    tier: Tier


class Outcome(StrictModel):
    # For the player: "won", "lost" or "draw".
    result: Literal["won", "lost", "draw"]
    # True when this match earned the tier's reward (the first win, or a draw on Classic Hard).
    first_win: bool
    coins_earned: int
    streak_bonus: int
    coins: int


class MatchOut(StrictModel):
    match_id: str
    seq: int
    state: dict[str, Any]
    prices: dict[str, int]
    # This tier's first-win reward, 0 once it's been earned.
    reward: int
    coins: int
    guest_ticket: str | None = None


class MoveIn(StrictModel):
    seq: int = Field(ge=0, le=1_000_000)
    cell: int = Field(ge=0, le=80)


class AiMove(StrictModel):
    cell: int
    vanished: int | None


class MoveOut(StrictModel):
    seq: int
    state: dict[str, Any]
    # Infinity: the player's mark that left the board.
    vanished: int | None
    ai: AiMove | None
    outcome: Outcome | None = None


class AssistIn(StrictModel):
    seq: int = Field(ge=0, le=1_000_000)
    kind: Literal["undo", "radar"]
    # The price the player confirmed. A mismatch means it changed: ask again.
    price: int = Field(ge=0, le=10_000)


class AssistOut(StrictModel):
    seq: int
    state: dict[str, Any]
    # Radar: the suggested cell.
    cell: int | None = None
    coins: int
    spent: int


class TierOut(StrictModel):
    mode: Mode
    tier: Tier
    coins: int
    earned: bool


class ProgressOut(StrictModel):
    tiers: list[TierOut]
    prices: dict[str, int]


def _key(match_id: str) -> str:
    return f"ts:match:{match_id}"


async def _earned(db: DbDep, state: AppState, who: Principal) -> set[int]:
    """Tiers whose reward this player already has."""
    if who.player_id is not None:
        rows = await db.scalars(
            select(CoinLedger.level).where(
                CoinLedger.player_id == who.player_id,
                CoinLedger.game_id == GAME,
                CoinLedger.reason == "clear",
            )
        )
        return {int(level) for level in rows if level is not None}
    assert who.guest is not None
    guest = await coins.read_guest(state, who.guest.gid)
    return {level for (game, level) in guest.clears if game == GAME}


async def _load(state: AppState, who: Principal, match_id: str) -> dict[str, Any]:
    match = await store.get_json(state.redis, _key(match_id))
    # Same error for "missing" and "someone else's": don't confirm other players' ids.
    if match is None or match.get("owner") != who.owner:
        raise ApiError(404, "match_not_found", "This match has expired. Start a new one.")
    return match


def _check_seq(match: dict[str, Any], seq: int) -> None:
    if seq != match["seq"]:
        raise ApiError(
            409,
            "out_of_sync",
            "Out of sync.",
            extra={"seq": match["seq"], "state": json.loads(match["state"])},
        )


def _ai_seed(match: dict[str, Any], plies: int) -> int:
    return (int(match["seed"]) + plies * 0x9E3779B1) & SEED_MASK


async def _finish(
    db: DbDep, state: AppState, who: Principal, match: dict[str, Any], status: str
) -> Outcome:
    """Settles a finished match: pays the tier's reward on the first win."""
    result: Literal["won", "lost", "draw"] = (
        "won" if status == "x_won" else "lost" if status == "o_won" else "draw"
    )
    mode, tier = match["mode"], match["tier"]
    pays = result == "won" or (result == "draw" and (mode, tier) == ("classic", "hard"))
    spent = int(match.get("spent", 0))
    first, earned, bonus = False, 0, 0
    if pays:
        paid = await coins.award_clear(
            db,
            state,
            who,
            GAME,
            _slot(mode, tier),
            spent=spent,
            assisted=spent > 0,
            base_reward=_reward(mode, tier),
        )
        await db.commit()
        first, earned, bonus, balance = (
            paid.first_clear,
            paid.earned,
            paid.streak_bonus,
            paid.balance,
        )
    else:
        balance = await coins.balance(db, state, who)
    kind = {"won": "clear", "lost": "lost", "draw": "end"}[result]
    await analytics.record(
        db,
        state,
        who,
        kind,
        GAME,
        _slot(mode, tier),
        coins=earned + bonus,
        detail=f"{mode}:{tier}" if result != "draw" else f"{mode}:{tier}:draw",
        started_ms=match["started_ms"],
    )
    return Outcome(
        result=result, first_win=first, coins_earned=earned, streak_bonus=bonus, coins=balance
    )


@router.get("/progress")
async def progress(who: PrincipalDep, state: StateDep, db: DbDep) -> ProgressOut:
    earned = await _earned(db, state, who)
    return ProgressOut(
        tiers=[
            TierOut(mode=m, tier=t, coins=c, earned=i in earned)
            for i, (m, t, c) in enumerate(coins.TACSHIFT_REWARDS, start=1)
        ],
        prices=coins.PRICES[GAME],
    )


@router.post("/matches")
async def start(
    body: StartIn, request: Request, who: PrincipalDep, state: StateDep, db: DbDep
) -> MatchOut:
    await limit(state, request, who, "ts-start", 30)
    slot = _slot(body.mode, body.tier)
    match_id = store.new_id()
    now = int(time.time() * 1000)
    fresh = arc_engine.ts_new(body.mode)
    match: dict[str, Any] = {
        "owner": who.owner,
        "mode": body.mode,
        "tier": body.tier,
        "seed": secrets.randbits(53),
        "state": fresh,
        "history": [],
        "seq": 0,
        "last_ms": 0,
        "started_ms": now,
        "spent": 0,
    }
    await store.put_json(state.redis, _key(match_id), match)
    await analytics.record(db, state, who, "start", GAME, slot, detail=f"{body.mode}:{body.tier}")
    earned = slot in await _earned(db, state, who)
    return MatchOut(
        match_id=match_id,
        seq=0,
        state=json.loads(fresh),
        prices=coins.PRICES[GAME],
        reward=0 if earned else _reward(body.mode, body.tier),
        coins=await coins.balance(db, state, who),
        guest_ticket=issue_ticket(state, who.guest) if who.guest else None,
    )


@router.post("/matches/{match_id}/move")
async def move(
    match_id: MatchPath,
    body: MoveIn,
    request: Request,
    who: PrincipalDep,
    state: StateDep,
    db: DbDep,
) -> MoveOut:
    await limit(state, request, who, "ts-move", 240)
    key = _key(match_id)
    async with store.lock(state.redis, key):
        match = await _load(state, who, match_id)
        _check_seq(match, body.seq)
        now = int(time.time() * 1000)
        if now - int(match["last_ms"]) < state.settings.ts_min_ms_between_moves:
            raise ApiError(429, "too_fast", "Slow down a little.")
        before = match["state"]
        if json.loads(before)["turn"] != 1:
            raise ApiError(409, "not_your_turn", "Wait for the other player.")
        try:
            mine = arc_engine.ts_play(before, body.cell)
        except arc_engine.EngineError as exc:
            raise ApiError(422, "illegal_move", "That cell can't be played now.") from exc
        after, status, ai = mine.state, mine.status, None
        if status == "playing":
            plies = int(json.loads(after)["plies"])
            cell = await state.run_engine(
                arc_engine.ts_ai_move, after, match["tier"], _ai_seed(match, plies)
            )
            if cell is not None:
                theirs = arc_engine.ts_play(after, cell)
                after, status = theirs.state, theirs.status
                ai = AiMove(cell=cell, vanished=theirs.vanished)
        match["history"] = [*match["history"], before][-HISTORY:]
        match.update(state=after, seq=match["seq"] + 1, last_ms=now)
        outcome = None
        if status != "playing":
            outcome = await _finish(db, state, who, match, status)
            match["outcome"] = outcome.model_dump()
        await store.put_json(state.redis, key, match)
        return MoveOut(
            seq=match["seq"],
            state=json.loads(after),
            vanished=mine.vanished,
            ai=ai,
            outcome=outcome,
        )


@router.post("/matches/{match_id}/assist")
async def assist(
    match_id: MatchPath,
    body: AssistIn,
    request: Request,
    who: PrincipalDep,
    state: StateDep,
    db: DbDep,
) -> AssistOut:
    """Undo (takes back the player's last move and the AI's reply; also after a loss) or
    radar (the strongest move for the player). Not charged when there's nothing to do."""
    await limit(state, request, who, "ts-assist", 20)
    price = coins.PRICES[GAME][body.kind]
    if body.price != price:
        raise ApiError(
            409, "price_changed", f"The price is now {price} coins.", extra={"price": price}
        )
    key = _key(match_id)
    async with store.lock(state.redis, key):
        match = await _load(state, who, match_id)
        _check_seq(match, body.seq)
        result = match.get("outcome", {}).get("result")
        cell = None
        if body.kind == "undo":
            if not match["history"] or result in ("won", "draw"):
                raise ApiError(409, "nothing_to_undo", "There's no move to take back. Not charged.")
        else:
            if result is not None:
                raise ApiError(409, "hint_unavailable", "The match is over. Not charged.")
            cell = await state.run_engine(
                arc_engine.ts_radar, match["state"], _ai_seed(match, 10_000 + match["seq"])
            )
            if cell is None:
                raise ApiError(409, "hint_unavailable", "No move to suggest. Not charged.")
        left = await coins.spend(
            db, state, who, price, GAME, _slot(match["mode"], match["tier"]), body.kind
        )
        match["spent"] = int(match.get("spent", 0)) + price
        if body.kind == "undo":
            *rest, previous = match["history"]
            match["history"] = rest
            match["state"] = previous
            match.pop("outcome", None)
        match["seq"] += 1
        await store.put_json(state.redis, key, match)
        await analytics.record(
            db,
            state,
            who,
            "assist",
            GAME,
            _slot(match["mode"], match["tier"]),
            coins=price,
            detail=body.kind,
        )
        return AssistOut(
            seq=match["seq"],
            state=json.loads(match["state"]),
            cell=cell,
            coins=left,
            spent=match["spent"],
        )
