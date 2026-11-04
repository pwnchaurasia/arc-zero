"""GridSnap: endless runs and levels. The server deals every tray and applies every placement.

The deal's seed and the game state stay in Redis; the client only ever sees the
board and the current tray, so it can't know what comes next. A run's score is
whatever the server computed, recorded when the run ends (or when the player
starts the next one). Leaderboards show display names only.

Levels (decision 2026-11-04) use the same run machinery: a level run starts from the
level's board and is won the moment the engine reports its last stone cleared. That
placement (or bomb) pays the first-clear coins and unlocks the next level. Level runs
never touch scores, milestones or leaderboards.
"""

from __future__ import annotations

import json
import secrets
import time
from datetime import UTC, datetime, timedelta
from typing import Annotated, Any, Literal

import arc_engine
from fastapi import APIRouter, Path, Query, Request, Response
from pydantic import Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from arc_api import analytics, coins, store
from arc_api.db import GridSnapScore, Player
from arc_api.errors import ApiError
from arc_api.levels import GameId, GsLevel
from arc_api.principal import Principal, PrincipalDep, issue_ticket
from arc_api.progress import ensure_playable, record_win
from arc_api.routers.common import StrictModel, limit
from arc_api.state import AppState, DbDep, StateDep

GAME: GameId = "gridsnap"
router = APIRouter(prefix="/games/gridsnap", tags=["gridsnap"])

RunPath = Annotated[str, Path(pattern=r"^[A-Za-z0-9_-]{16,64}$")]
LevelPath = Annotated[int, Path(ge=1, le=10_000)]
Period = Literal["week", "month", "all"]
LEADERBOARD_SIZE = 10
LEADERBOARD_CACHE_SECONDS = 30
ANONYMOUS = "Anonymous player"


class FinalOut(StrictModel):
    score: int
    lines: int
    best: int
    new_best: bool
    # False when bought help was used: the run counts for the personal best only.
    ranked: bool
    coins_earned: int
    coins: int


class StartOut(StrictModel):
    run_id: str
    seq: int
    view: dict[str, Any]
    best: int
    prices: dict[str, int]
    coins: int
    # The run this start replaced, if it was still open (its score is now recorded).
    previous: FinalOut | None = None
    guest_ticket: str | None = None


class LevelStartOut(StrictModel):
    run_id: str
    seq: int
    level: int
    view: dict[str, Any]
    # Shapes for 3 stars; up to half again for 2.
    par: int
    prices: dict[str, int]
    reward: int
    coins: int
    guest_ticket: str | None = None


class LevelResultOut(StrictModel):
    level: int
    stars: int
    placed: int
    par: int
    best_stars: int
    unlocked_level: int
    registration_required: bool
    first_clear: bool
    coins_earned: int
    streak_bonus: int
    coins: int
    guest_ticket: str | None = None


class PlaceIn(StrictModel):
    # Actions applied so far: a retried or out-of-order request resyncs instead.
    seq: int = Field(ge=0, le=1_000_000)
    slot: int = Field(ge=0, le=2)
    row: int = Field(ge=0, le=7)
    col: int = Field(ge=0, le=7)


class AssistIn(StrictModel):
    seq: int = Field(ge=0, le=1_000_000)
    kind: Literal["reshuffle", "bomb"]
    # Bomb only: the centre of the 3-by-3 area.
    row: int = Field(default=0, ge=0, le=7)
    col: int = Field(default=0, ge=0, le=7)
    # The price the player confirmed. A mismatch means it changed: ask again.
    price: int = Field(ge=0, le=10_000)


class StepOut(StrictModel):
    seq: int
    view: dict[str, Any]
    points: int
    coins: int | None = None
    # Set when this action cleared a level's last stone.
    result: LevelResultOut | None = None


class Entry(StrictModel):
    rank: int
    name: str
    score: int
    you: bool


class LeaderboardOut(StrictModel):
    period: Period
    entries: list[Entry]
    # The caller's best unassisted score in this period and its rank (players only).
    you: Entry | None
    signed_in: bool


def _run_key(run_id: str) -> str:
    return f"gs:run:{run_id}"


def _current_key(who: Principal) -> str:
    return f"gs:current:{who.owner}"


def _guest_best_key(who: Principal) -> str:
    assert who.guest is not None
    return f"gs:best:{who.guest.gid}"


async def _load_run(state: AppState, who: Principal, run_id: str) -> dict[str, Any]:
    run = await store.get_json(state.redis, _run_key(run_id))
    # Same error for "missing" and "someone else's": don't confirm other players' ids.
    if run is None or run.get("owner") != who.owner:
        raise ApiError(404, "run_not_found", "This game has expired. Start a new one.")
    return run


def _view(run: dict[str, Any]) -> dict[str, Any]:
    return dict(json.loads(run["view"]))


def _level(state: AppState, level: int) -> GsLevel:
    found = state.levels.gridsnap.get(level)
    if found is None:
        raise ApiError(404, "level_not_found", "No such level.")
    return found


async def _level_won(
    db: AsyncSession, state: AppState, who: Principal, run: dict[str, Any], placed: int
) -> LevelResultOut:
    """A level's last stone is gone: pay, record the stars, unlock the next level. Once."""
    if "result" in run:
        return LevelResultOut.model_validate(run["result"])
    level = int(run["level"])
    lvl = _level(state, level)
    stars = arc_engine.gs_stars(placed, lvl.par)
    spent = int(run.get("spent", 0))
    paid = await coins.award_clear(db, state, who, GAME, level, spent=spent, assisted=spent > 0)
    outcome = await record_win(db, state, who, GAME, level, stars, placed)
    out = LevelResultOut(
        level=level,
        stars=stars,
        placed=placed,
        par=lvl.par,
        best_stars=outcome.best_stars,
        unlocked_level=outcome.unlocked_level,
        registration_required=outcome.registration_required,
        first_clear=paid.first_clear,
        coins_earned=paid.earned,
        streak_bonus=paid.streak_bonus,
        coins=paid.balance,
        guest_ticket=outcome.guest_ticket,
    )
    run["result"] = out.model_dump()
    run["final"] = True
    await analytics.record(
        db,
        state,
        who,
        "clear",
        GAME,
        level,
        stars=stars,
        coins=paid.earned + paid.streak_bonus,
        detail=f"shapes:{placed}",
        started_ms=run.get("started_ms"),
    )
    return out


def _out_of_sync(run: dict[str, Any]) -> ApiError:
    return ApiError(
        409, "out_of_sync", "Out of sync.", extra={"seq": run["seq"], "view": _view(run)}
    )


async def personal_best(db: AsyncSession, state: AppState, who: Principal) -> int:
    if who.player_id is not None:
        best = await db.scalar(
            select(func.max(GridSnapScore.score)).where(GridSnapScore.player_id == who.player_id)
        )
        return int(best or 0)
    raw = await state.redis.get(_guest_best_key(who))
    return int(raw or 0)


async def _finish(
    db: AsyncSession, state: AppState, who: Principal, run_id: str, run: dict[str, Any]
) -> FinalOut:
    """Ends a run once: records the score, pays milestones. Repeat calls return the result."""
    if "final" in run:
        return FinalOut.model_validate(run["final"])
    step = arc_engine.gs_end(run["state"])
    assisted = bool(run.get("assisted"))
    before = await personal_best(db, state, who)
    day = datetime.now(UTC).strftime("%Y%m%d")
    paid = await coins.award_milestones(db, state, who, GAME, step.score, day)
    if who.player_id is not None:
        if step.score > 0:
            db.add(
                GridSnapScore(
                    player_id=who.player_id,
                    score=step.score,
                    lines=step.lines,
                    assisted=assisted,
                )
            )
        await db.commit()
    elif step.score > before:
        await state.redis.set(
            _guest_best_key(who), step.score, ex=state.settings.guest_ticket_ttl_days * 86400
        )
    out = FinalOut(
        score=step.score,
        lines=step.lines,
        best=max(before, step.score),
        new_best=step.score > before,
        ranked=not assisted and who.player_id is not None,
        coins_earned=paid.earned,
        coins=paid.balance,
    )
    run["state"], run["view"], run["final"] = step.state, step.view, out.model_dump()
    await store.put_json(state.redis, _run_key(run_id), run)
    await analytics.record(
        db,
        state,
        who,
        "end",
        GAME,
        None,
        coins=paid.earned or None,
        detail=f"score:{step.score}",
        started_ms=run.get("started_ms"),
    )
    return out


@router.post("/runs/start")
async def start(request: Request, who: PrincipalDep, state: StateDep, db: DbDep) -> StartOut:
    await limit(state, request, who, "gs-start", 20)
    current = _current_key(who)
    async with store.lock(state.redis, current):
        previous = None
        old_id = await state.redis.get(current)
        if old_id is not None:
            old_id = old_id.decode() if isinstance(old_id, bytes) else str(old_id)
            old = await store.get_json(state.redis, _run_key(old_id))
            if old is not None and old.get("owner") == who.owner and "final" not in old:
                async with store.lock(state.redis, _run_key(old_id)):
                    previous = await _finish(db, state, who, old_id, old)

        step = arc_engine.gs_new(secrets.randbits(63))
        run_id = store.new_id()
        run = {
            "owner": who.owner,
            "state": step.state,
            "view": step.view,
            "seq": 0,
            "last_ms": 0,
            "assisted": False,
            "started_ms": int(time.time() * 1000),
        }
        await store.put_json(state.redis, _run_key(run_id), run)
        await state.redis.set(current, run_id, ex=store.ATTEMPT_TTL)
    await analytics.record(db, state, who, "start", GAME, None)
    return StartOut(
        run_id=run_id,
        seq=0,
        view=_view(run),
        best=await personal_best(db, state, who),
        prices=coins.PRICES[GAME],
        coins=await coins.balance(db, state, who),
        previous=previous,
        guest_ticket=issue_ticket(state, who.guest) if who.guest else None,
    )


@router.post("/levels/{level}/start")
async def start_level(
    level: LevelPath, request: Request, who: PrincipalDep, state: StateDep, db: DbDep
) -> LevelStartOut:
    """A fresh try at a level (never resumed: a retry starts from its board again)."""
    await limit(state, request, who, "gs-level-start", 30)
    await ensure_playable(db, state, who, GAME, level)
    lvl = _level(state, level)
    step = lvl.new_game()
    run_id = store.new_id()
    run = {
        "owner": who.owner,
        "level": level,
        "state": step.state,
        "view": step.view,
        "seq": 0,
        "last_ms": 0,
        "spent": 0,
        "started_ms": int(time.time() * 1000),
    }
    await store.put_json(state.redis, _run_key(run_id), run)
    await analytics.record(db, state, who, "start", GAME, level)
    return LevelStartOut(
        run_id=run_id,
        seq=0,
        level=level,
        view=_view(run),
        par=lvl.par,
        prices=coins.PRICES[GAME],
        reward=coins.clear_reward(level),
        coins=await coins.balance(db, state, who),
        guest_ticket=issue_ticket(state, who.guest) if who.guest else None,
    )


@router.get("/runs/current", response_model=None)
async def current(
    request: Request, who: PrincipalDep, state: StateDep, db: DbDep
) -> StartOut | Response:
    """The caller's open run, to continue where they left off; 204 when there is none."""
    await limit(state, request, who, "gs-current", 30)
    run_id = await state.redis.get(_current_key(who))
    run = None
    if run_id is not None:
        run_id = run_id.decode() if isinstance(run_id, bytes) else str(run_id)
        run = await store.get_json(state.redis, _run_key(run_id))
    if run_id is None or run is None or run.get("owner") != who.owner or "final" in run:
        return Response(status_code=204)
    return StartOut(
        run_id=run_id,
        seq=int(run["seq"]),
        view=_view(run),
        best=await personal_best(db, state, who),
        prices=coins.PRICES[GAME],
        coins=await coins.balance(db, state, who),
        guest_ticket=issue_ticket(state, who.guest) if who.guest else None,
    )


@router.post("/runs/{run_id}/place")
async def place(
    run_id: RunPath, body: PlaceIn, request: Request, who: PrincipalDep, state: StateDep, db: DbDep
) -> StepOut:
    await limit(state, request, who, "gs-place", 240)
    key = _run_key(run_id)
    async with store.lock(state.redis, key):
        run = await _load_run(state, who, run_id)
        if "final" in run:
            raise ApiError(409, "run_over", "This game is over.")
        if body.seq != run["seq"]:
            raise _out_of_sync(run)
        now_ms = int(time.time() * 1000)
        if now_ms - int(run["last_ms"]) < state.settings.gs_min_ms_between_moves:
            raise ApiError(429, "too_fast", "Slow down.")
        try:
            step = arc_engine.gs_place(run["state"], body.slot, body.row, body.col)
        except arc_engine.EngineError as exc:
            raise ApiError(
                422,
                "illegal_move",
                "That piece doesn't fit there.",
                extra={"seq": run["seq"], "view": _view(run)},
            ) from exc
        run.update(state=step.state, view=step.view, seq=run["seq"] + 1, last_ms=now_ms)
        result = None
        if "level" in run and step.status == "won":
            result = await _level_won(db, state, who, run, step.placed)
        await store.put_json(state.redis, key, run)
        return StepOut(seq=run["seq"], view=_view(run), points=step.points, result=result)


@router.post("/runs/{run_id}/assist")
async def assist(
    run_id: RunPath, body: AssistIn, request: Request, who: PrincipalDep, state: StateDep, db: DbDep
) -> StepOut:
    """Applies a paid assist, after the player confirmed the price."""
    await limit(state, request, who, "gs-assist", 20)
    price = coins.PRICES[GAME][body.kind]
    if body.price != price:
        raise ApiError(
            409, "price_changed", f"The price is now {price} coins.", extra={"price": price}
        )
    key = _run_key(run_id)
    async with store.lock(state.redis, key):
        run = await _load_run(state, who, run_id)
        if "final" in run:
            raise ApiError(409, "run_over", "This game is over.")
        if body.seq != run["seq"]:
            raise _out_of_sync(run)
        try:
            step = arc_engine.gs_assist(run["state"], body.kind, body.row, body.col)
        except arc_engine.EngineError as exc:
            raise ApiError(
                422, "assist_not_possible", "You can't use that again in this game. Not charged."
            ) from exc
        level = run.get("level")
        # Charged only once the engine accepted it.
        balance = await coins.spend(db, state, who, price, GAME, level, body.kind)
        run.update(
            state=step.state,
            view=step.view,
            seq=run["seq"] + 1,
            assisted=True,
            spent=int(run.get("spent", 0)) + price,
        )
        await analytics.record(db, state, who, "assist", GAME, level, coins=price, detail=body.kind)
        result = None
        if level is not None and step.status == "won":  # a bomb took the last stones
            result = await _level_won(db, state, who, run, step.placed)
            balance = result.coins
        await store.put_json(state.redis, key, run)
        return StepOut(seq=run["seq"], view=_view(run), points=0, coins=balance, result=result)


@router.post("/runs/{run_id}/end")
async def end(
    run_id: RunPath, request: Request, who: PrincipalDep, state: StateDep, db: DbDep
) -> FinalOut:
    await limit(state, request, who, "gs-end", 20)
    key = _run_key(run_id)
    async with store.lock(state.redis, key):
        run = await _load_run(state, who, run_id)
        if "level" in run:
            return await _give_up_level(db, state, who, run_id, run)
        return await _finish(db, state, who, run_id, run)


async def _give_up_level(
    db: AsyncSession, state: AppState, who: Principal, run_id: str, run: dict[str, Any]
) -> FinalOut:
    """Ends a level try that was not won (stuck, or the player left). Nothing is paid."""
    step = arc_engine.gs_end(run["state"])
    if "final" not in run:
        run.update(state=step.state, view=step.view, final=True)
        await store.put_json(state.redis, _run_key(run_id), run)
        if step.status != "won":
            await analytics.record(
                db,
                state,
                who,
                "lost",
                GAME,
                int(run["level"]),
                detail=f"stones:{_view(run)['cells'].count(arc_engine.GS_STONE)}",
                started_ms=run.get("started_ms"),
            )
    return FinalOut(
        score=step.score,
        lines=step.lines,
        best=0,
        new_best=False,
        ranked=False,
        coins_earned=0,
        coins=await coins.balance(db, state, who),
    )


def _since(period: Period) -> datetime | None:
    now = datetime.now(UTC)
    midnight = now.replace(hour=0, minute=0, second=0, microsecond=0)
    if period == "week":
        return midnight - timedelta(days=now.weekday())
    if period == "month":
        return midnight.replace(day=1)
    return None


async def _top(db: AsyncSession, since: datetime | None) -> list[tuple[str, str, int]]:
    """(player id, name, best) for the top players: unassisted runs only."""
    best = func.max(GridSnapScore.score).label("best")
    query = (
        select(GridSnapScore.player_id, Player.display_name, best)
        .join(Player, Player.id == GridSnapScore.player_id)
        .where(GridSnapScore.assisted.is_(False))
        .group_by(GridSnapScore.player_id, Player.display_name)
        .order_by(best.desc(), func.min(GridSnapScore.created_at))
        .limit(LEADERBOARD_SIZE)
    )
    if since is not None:
        query = query.where(GridSnapScore.created_at >= since)
    rows = await db.execute(query)
    return [(str(pid), name or ANONYMOUS, int(score)) for pid, name, score in rows]


@router.get("/leaderboard")
async def leaderboard(
    request: Request,
    who: PrincipalDep,
    state: StateDep,
    db: DbDep,
    period: Annotated[Period, Query()] = "week",
) -> LeaderboardOut:
    await limit(state, request, who, "gs-board", 60)
    since = _since(period)
    cache = f"gs:lb:{period}"
    cached = await state.redis.get(cache)
    if cached is None:
        top = await _top(db, since)
        await state.redis.set(cache, json.dumps(top), ex=LEADERBOARD_CACHE_SECONDS)
    else:
        top = [(str(pid), str(name), int(score)) for pid, name, score in json.loads(cached)]
    me = str(who.player_id) if who.player_id is not None else None
    # Player ids never leave the server: they only mark the caller's own row.
    entries = [
        Entry(rank=i, name=name, score=score, you=pid == me)
        for i, (pid, name, score) in enumerate(top, start=1)
    ]

    you = None
    if who.player_id is not None:
        mine = select(func.max(GridSnapScore.score)).where(
            GridSnapScore.player_id == who.player_id, GridSnapScore.assisted.is_(False)
        )
        if since is not None:
            mine = mine.where(GridSnapScore.created_at >= since)
        my_best = await db.scalar(mine)
        if my_best is not None:
            better = (
                select(GridSnapScore.player_id)
                .where(GridSnapScore.assisted.is_(False))
                .group_by(GridSnapScore.player_id)
                .having(func.max(GridSnapScore.score) > my_best)
            )
            if since is not None:
                better = better.where(GridSnapScore.created_at >= since)
            ahead = await db.scalar(select(func.count()).select_from(better.subquery()))
            name = await db.scalar(select(Player.display_name).where(Player.id == who.player_id))
            you = Entry(
                rank=int(ahead or 0) + 1, name=name or ANONYMOUS, score=int(my_best), you=True
            )
    return LeaderboardOut(
        period=period, entries=entries, you=you, signed_in=who.player_id is not None
    )
