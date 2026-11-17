"""LogoQuest: turtle-graphics lessons. The server judges every program.

Each level is two stages in the progress system (levels.lq_stage): Learn N, then Test N.
The client gets the drawing to match (and, for a Test, the reference card's facts),
never the answer key. "Check my code" sends the program built from chips; the engine
runs it, compares the drawing with the target, and only a pass unlocks the next stage
and pays coins. Every check, passed or not, is written to `logo_checks` so a parent can
follow the learning day by day (`make logo-report`).
"""

from __future__ import annotations

import json
import math
import time
from typing import Annotated, Any, Literal

import arc_engine
from fastapi import APIRouter, Path, Request
from pydantic import Field

from arc_api import analytics, coins, store
from arc_api.db import LogoCheck
from arc_api.errors import ApiError
from arc_api.levels import GameId, LqLevel, LqStage, lq_stage
from arc_api.principal import Principal, PrincipalDep, issue_ticket
from arc_api.progress import ensure_playable, record_win
from arc_api.routers.common import StrictModel, limit
from arc_api.state import AppState, DbDep, StateDep

GAME: GameId = "logoquest"
router = APIRouter(prefix="/games/logoquest", tags=["logoquest"])

StagePath = Annotated[int, Path(ge=1, le=10_000)]
AttemptId = Annotated[str, Field(pattern=r"^[A-Za-z0-9_-]{16,64}$")]
# A Learn level pays a little; its Test pays the usual level band.
LEARN_REWARD = 5
# Chips each chapter offers (decision 2026-11-17): new ideas arrive one chapter at a time.
CHAPTER_CHIPS: dict[int, dict[str, Any]] = {
    1: {"chips": ["fd", "bk", "rt", "lt"], "angles": [90], "any_angle": False, "depth": 0},
    2: {
        "chips": ["fd", "bk", "rt", "lt", "pu", "pd", "color"],
        "angles": [90],
        "any_angle": False,
        "depth": 0,
    },
    3: {
        "chips": ["fd", "bk", "rt", "lt", "pu", "pd", "color"],
        "angles": [30, 45, 60, 72, 90, 120, 135, 144],
        "any_angle": True,
        "depth": 0,
    },
    4: {
        "chips": ["fd", "bk", "rt", "lt", "pu", "pd", "color", "repeat"],
        "angles": [10, 30, 36, 40, 45, 60, 72, 90, 120, 135, 144, 160],
        "any_angle": True,
        "depth": 1,
    },
    5: {
        "chips": ["fd", "bk", "rt", "lt", "pu", "pd", "color", "repeat"],
        "angles": [10, 20, 30, 36, 45, 60, 72, 90, 120, 135, 144],
        "any_angle": True,
        "depth": 3,
    },
}


class StageData(StrictModel):
    level: int
    kind: Literal["learn", "test"]
    chapter: int
    chapter_name: str
    title: str
    tip: str
    # The drawing to match, [[x1, y1, x2, y2, colour], ...] in thousandths of a unit.
    target: list[list[Any]]
    # Test only: the reference card.
    facts: list[str]
    par: int
    tools: dict[str, Any]


class StartOut(StrictModel):
    attempt_id: str
    stage: int
    data: StageData
    prices: dict[str, int]
    reward: int
    coins: int
    guest_ticket: str | None = None


class CheckIn(StrictModel):
    attempt_id: AttemptId
    # The chips, as the engine's JSON (validated by the engine).
    program: list[dict[str, Any]] = Field(max_length=200)
    # Reported by the app, for the practice log only (never for coins or unlocking).
    runs: int = Field(ge=0, le=10_000)
    taps: int = Field(ge=0, le=100_000)
    active_seconds: int = Field(ge=0, le=86_400)


class HintIn(StrictModel):
    attempt_id: AttemptId
    program: list[dict[str, Any]] = Field(max_length=200)
    price: int = Field(ge=0, le=10_000)


class HintOut(StrictModel):
    # The first line of the target not drawn yet, in thousandths of a unit, and its length.
    line: list[int]
    length: int
    coins: int
    spent: int


class CheckOut(StrictModel):
    passed: bool
    accuracy: int
    coverage: int
    precision: int
    blocks: int
    par: int
    seconds: int
    stars: int = 0
    best_stars: int = 0
    unlocked_level: int = 0
    registration_required: bool = False
    first_clear: bool = False
    coins_earned: int = 0
    streak_bonus: int = 0
    coins: int = 0
    guest_ticket: str | None = None


def _attempt_key(attempt_id: str) -> str:
    return f"lq:attempt:{attempt_id}"


def _resolve(state: AppState, stage: int) -> tuple[LqLevel, LqStage, Literal["learn", "test"]]:
    number, kind = lq_stage(stage)
    level = state.levels.logoquest.get(number)
    if level is None:
        raise ApiError(404, "level_not_found", "No such level.")
    return level, level.learn if kind == "learn" else level.test, kind


def _reward(level: LqLevel, kind: str) -> int:
    return LEARN_REWARD if kind == "learn" else coins.clear_reward(level.level)


def stars_for(blocks: int, par: int) -> int:
    """3 at or under par, 2 within half as many again, 1 otherwise."""
    if blocks <= par:
        return 3
    if blocks <= par + math.ceil(par / 2):
        return 2
    return 1


def flags_for(*, passed: bool, seconds: int, par: int, runs: int, taps: int, blocks: int) -> str:
    """Reasons a parent might look closer at a pass. Not proof of anything on their own."""
    if not passed:
        return ""
    out = []
    # Much quicker than tapping out the answer key's chips could take.
    if seconds < 5 + 3 * par:
        out.append("fast")
    # The turtle never drew it: no Run and no live preview of an edit in the app.
    if runs == 0:
        out.append("no_runs")
    # Fewer taps than blocks: the program wasn't built in the app.
    if taps < blocks:
        out.append("few_taps")
    return ",".join(out)


async def _load(state: AppState, who: Principal, attempt_id: str, stage: int) -> dict[str, Any]:
    attempt = await store.get_json(state.redis, _attempt_key(attempt_id))
    # Same error for "missing" and "someone else's": don't confirm other players' ids.
    if attempt is None or attempt.get("owner") != who.owner or attempt.get("stage") != stage:
        raise ApiError(404, "attempt_not_found", "This lesson has expired. Open it again.")
    return attempt


async def _judge(state: AppState, program: list[dict[str, Any]], target: LqStage) -> Any:
    try:
        return await state.run_engine(arc_engine.logo_judge, json.dumps(program), target.program)
    except arc_engine.EngineError as exc:
        raise ApiError(422, "bad_program", "That program can't run.") from exc


class MapLevel(StrictModel):
    level: int
    chapter: int
    chapter_name: str
    learn: str
    test: str


@router.get("/levels")
async def level_map(state: StateDep) -> list[MapLevel]:
    """Level and chapter names for the map (no drawings, no answers)."""
    return [
        MapLevel(
            level=lv.level,
            chapter=lv.chapter,
            chapter_name=lv.chapter_name,
            learn=lv.learn.title,
            test=lv.test.title,
        )
        for lv in sorted(state.levels.logoquest.values(), key=lambda lv: lv.level)
    ]


@router.post("/stages/{stage}/start")
async def start(
    stage: StagePath, request: Request, who: PrincipalDep, state: StateDep, db: DbDep
) -> StartOut:
    await limit(state, request, who, "lq-start", 60)
    await ensure_playable(db, state, who, GAME, stage)
    level, target, kind = _resolve(state, stage)
    attempt_id = store.new_id()
    await store.put_json(
        state.redis,
        _attempt_key(attempt_id),
        {
            "owner": who.owner,
            "stage": stage,
            "issued_ms": int(time.time() * 1000),
            "spent": 0,
            "hints": 0,
        },
    )
    await analytics.record(db, state, who, "start", GAME, stage, detail=kind)
    return StartOut(
        attempt_id=attempt_id,
        stage=stage,
        data=StageData(
            level=level.level,
            kind=kind,
            chapter=level.chapter,
            chapter_name=level.chapter_name,
            title=target.title,
            tip=level.tip,
            target=json.loads(target.lines_json),
            facts=list(level.facts) if kind == "test" else [],
            par=target.par,
            tools=CHAPTER_CHIPS[level.chapter],
        ),
        prices=coins.PRICES[GAME],
        reward=_reward(level, kind),
        coins=await coins.balance(db, state, who),
        guest_ticket=issue_ticket(state, who.guest) if who.guest else None,
    )


@router.post("/stages/{stage}/hint")
async def hint(
    stage: StagePath, body: HintIn, request: Request, who: PrincipalDep, state: StateDep, db: DbDep
) -> HintOut:
    """Shows the first line still missing, after the player confirmed the price."""
    await limit(state, request, who, "hint", 10)
    price = coins.PRICES[GAME]["hint"]
    if body.price != price:
        raise ApiError(
            409, "price_changed", f"The price is now {price} coins.", extra={"price": price}
        )
    _, target, _ = _resolve(state, stage)
    key = _attempt_key(body.attempt_id)
    async with store.lock(state.redis, key):
        attempt = await _load(state, who, body.attempt_id, stage)
        verdict = await _judge(state, body.program, target)
        if verdict.missing is None:
            raise ApiError(409, "hint_unavailable", "Every line is already drawn. Not charged.")
        left = await coins.spend(db, state, who, price, GAME, stage, "hint")
        attempt["spent"] = int(attempt.get("spent", 0)) + price
        attempt["hints"] = int(attempt.get("hints", 0)) + 1
        await store.put_json(state.redis, key, attempt)
        await analytics.record(db, state, who, "hint", GAME, stage, coins=price)
        x1, y1, x2, y2, length = verdict.missing
        return HintOut(line=[x1, y1, x2, y2], length=length, coins=left, spent=attempt["spent"])


@router.post("/stages/{stage}/check")
async def check(
    stage: StagePath, body: CheckIn, request: Request, who: PrincipalDep, state: StateDep, db: DbDep
) -> CheckOut:
    await limit(state, request, who, "lq-check", 60)
    level, target, kind = _resolve(state, stage)
    key = _attempt_key(body.attempt_id)
    async with store.lock(state.redis, key):
        attempt = await _load(state, who, body.attempt_id, stage)
        if "result" in attempt:
            # Idempotent: a retried request gets the original answer, never new coins.
            return CheckOut.model_validate(attempt["result"])
        verdict = await _judge(state, body.program, target)
        seconds = max(0, int(time.time() * 1000) - int(attempt["issued_ms"])) // 1000
        out = CheckOut(
            passed=verdict.passed,
            accuracy=verdict.accuracy,
            coverage=verdict.coverage,
            precision=verdict.precision,
            blocks=verdict.blocks,
            par=target.par,
            seconds=seconds,
        )
        stars = stars_for(verdict.blocks, target.par) if verdict.passed else None
        db.add(
            LogoCheck(
                player_id=who.player_id,
                who=analytics.who(state, who),
                attempt=body.attempt_id,
                level=level.level,
                kind=kind,
                passed=verdict.passed,
                accuracy=verdict.accuracy,
                blocks=verdict.blocks,
                par=target.par,
                stars=stars,
                seconds=seconds,
                active_seconds=body.active_seconds,
                runs=body.runs,
                taps=body.taps,
                hints=int(attempt.get("hints", 0)),
                program=json.dumps(body.program, separators=(",", ":"))[:20_000],
                flags=flags_for(
                    passed=verdict.passed,
                    seconds=seconds,
                    par=target.par,
                    runs=body.runs,
                    taps=body.taps,
                    blocks=verdict.blocks,
                ),
            )
        )
        if not verdict.passed:
            await db.commit()
            return out

        assert stars is not None
        spent = int(attempt.get("spent", 0))
        paid = await coins.award_clear(
            db,
            state,
            who,
            GAME,
            stage,
            spent=spent,
            assisted=spent > 0,
            base_reward=_reward(level, kind),
        )
        outcome = await record_win(db, state, who, GAME, stage, stars, verdict.blocks)
        out = out.model_copy(
            update={
                "stars": stars,
                "best_stars": outcome.best_stars,
                "unlocked_level": outcome.unlocked_level,
                "registration_required": outcome.registration_required,
                "first_clear": paid.first_clear,
                "coins_earned": paid.earned,
                "streak_bonus": paid.streak_bonus,
                "coins": paid.balance,
                "guest_ticket": outcome.guest_ticket,
            }
        )
        attempt["result"] = out.model_dump()
        await store.put_json(state.redis, key, attempt)
        await analytics.record(
            db,
            state,
            who,
            "clear",
            GAME,
            stage,
            stars=stars,
            coins=paid.earned + paid.streak_bonus,
            detail=kind,
            started_ms=attempt["issued_ms"],
        )
        return out
