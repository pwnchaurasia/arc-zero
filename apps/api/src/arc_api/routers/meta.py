"""Health checks and proof-of-work challenges."""

from __future__ import annotations

import time
from typing import Literal

from fastapi import APIRouter, Request
from sqlalchemy import text

from arc_api.errors import ApiError
from arc_api.routers.common import StrictModel, client_ip
from arc_api.security import pow as pow_
from arc_api.state import DbDep, StateDep

router = APIRouter(tags=["meta"])


@router.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@router.get("/ready")
async def ready(state: StateDep, db: DbDep) -> dict[str, str]:
    try:
        await db.execute(text("SELECT 1"))
        await state.redis.ping()
    except Exception as exc:
        raise ApiError(503, "not_ready", "Dependencies unavailable.") from exc
    return {"status": "ready"}


class ChallengeIn(StrictModel):
    purpose: Literal["register", "restore"]


class ChallengeOut(StrictModel):
    token: str
    challenge: str
    difficulty: int
    expires_at: int


def registration_counter_key(minute: int) -> str:
    return f"reg:min:{minute}"


@router.post("/pow/challenge")
async def pow_challenge(body: ChallengeIn, request: Request, state: StateDep) -> ChallengeOut:
    s = state.settings
    await state.limiter.hit(f"pow:{client_ip(request)}", 20, 60)
    minute = int(time.time()) // 60
    recent = await state.redis.mget(
        registration_counter_key(minute), registration_counter_key(minute - 1)
    )
    registrations = sum(int(v) for v in recent if v is not None)
    surge = registrations > s.pow_surge_per_minute
    difficulty = s.pow_surge_difficulty if surge else s.pow_difficulty
    issued = pow_.issue(state.signer, body.purpose, difficulty, s.pow_ttl_seconds)
    return ChallengeOut.model_validate(issued)
