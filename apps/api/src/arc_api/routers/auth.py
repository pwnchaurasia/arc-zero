"""Account creation (after the guest Level-3 gate), restore by key, logout."""

from __future__ import annotations

import time

from fastapi import APIRouter, Request, Response
from pydantic import Field
from sqlalchemy import func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from arc_api.db import GameProgress, LevelResult, Player
from arc_api.errors import ApiError
from arc_api.levels import GAME_IDS
from arc_api.principal import PrincipalDep, parse_ticket
from arc_api.routers.common import StrictModel, client_ip
from arc_api.routers.meta import registration_counter_key
from arc_api.security import pow as pow_
from arc_api.security.recovery import generate_key, hash_key, normalize_key
from arc_api.state import AppState, DbDep, StateDep

router = APIRouter(prefix="/auth", tags=["auth"])


class PowIn(StrictModel):
    token: str = Field(max_length=4096)
    nonce: int = Field(ge=0, le=2**32)


class RegisterIn(StrictModel):
    guest_ticket: str = Field(max_length=4096)
    pow: PowIn


class RestoreIn(StrictModel):
    recovery_key: str = Field(min_length=1, max_length=200)
    pow: PowIn


class RegisterOut(StrictModel):
    recovery_key: str


def _set_session_cookie(response: Response, state: AppState, token: str) -> None:
    s = state.settings
    response.set_cookie(
        s.cookie_name,
        token,
        max_age=state.sessions.ttl_seconds,
        httponly=True,
        secure=s.cookie_secure,
        samesite="strict",
        path="/",
    )


async def _create_player(db: AsyncSession, state: AppState) -> tuple[Player, str]:
    pepper = state.settings.recovery_pepper.get_secret_value().encode()
    # A collision on 66 random bits is practically impossible; retry anyway.
    for _ in range(3):
        key = generate_key()
        player = Player(key_hash=hash_key(key, pepper))
        db.add(player)
        try:
            await db.flush()
        except IntegrityError:
            await db.rollback()
            continue
        return player, key
    raise ApiError(500, "internal", "Could not create account.")


@router.post("/register")
async def register(
    body: RegisterIn, request: Request, response: Response, state: StateDep, db: DbDep
) -> RegisterOut:
    s = state.settings
    ip = client_ip(request)
    await state.limiter.hit(f"register:{ip}", 3, 3600)
    await pow_.verify(
        state.signer, state.redis, "register", body.pow.token, body.pow.nonce, s.pow_ttl_seconds
    )

    guest = parse_ticket(state, body.guest_ticket)
    if guest is None:
        raise ApiError(400, "invalid_ticket", "Guest progress is invalid or expired.")
    if max((guest.cleared(g) for g in GAME_IDS), default=0) < s.guest_max_level:
        raise ApiError(403, "gate_not_reached", f"Clear level {s.guest_max_level} first.")
    # A guest ticket can create exactly one account.
    claimed = await state.redis.set(
        f"guest:registered:{guest.gid}", "1", nx=True, ex=s.guest_ticket_ttl_days * 86400
    )
    if not claimed:
        raise ApiError(409, "already_registered", "This progress was already saved.")

    try:
        player, key = await _create_player(db, state)
        for game, stars in guest.progress.items():
            if not stars:
                continue
            count = state.levels.count(game)  # type: ignore[arg-type]
            db.add(
                GameProgress(
                    player_id=player.id, game_id=game, unlocked_level=min(len(stars) + 1, count)
                )
            )
            for level, star in enumerate(stars, start=1):
                db.add(LevelResult(player_id=player.id, game_id=game, level=level, stars=star))
        await db.commit()
    except BaseException:
        await state.redis.delete(f"guest:registered:{guest.gid}")
        raise

    minute_key = registration_counter_key(int(time.time()) // 60)
    pipe = state.redis.pipeline(transaction=True)
    pipe.incr(minute_key)
    pipe.expire(minute_key, 180)
    await pipe.execute()

    token = await state.sessions.create(player.id)
    _set_session_cookie(response, state, token)
    return RegisterOut(recovery_key=key)


@router.post("/restore", status_code=204)
async def restore(
    body: RestoreIn, request: Request, response: Response, state: StateDep, db: DbDep
) -> None:
    s = state.settings
    ip = client_ip(request)
    await state.limiter.hit(f"restore:{ip}", 5, 60)
    await state.limiter.hit(f"restore-h:{ip}", 20, 3600)
    await pow_.verify(
        state.signer, state.redis, "restore", body.pow.token, body.pow.nonce, s.pow_ttl_seconds
    )

    not_found = ApiError(401, "key_not_recognised", "That key was not recognised.")
    key = normalize_key(body.recovery_key)
    if key is None:
        raise not_found
    key_hash = hash_key(key, s.recovery_pepper.get_secret_value().encode())
    player_id = await db.scalar(select(Player.id).where(Player.key_hash == key_hash))
    if player_id is None:
        raise not_found
    await db.execute(update(Player).where(Player.id == player_id).values(last_active=func.now()))
    await db.commit()

    token = await state.sessions.create(player_id)
    _set_session_cookie(response, state, token)
    response.status_code = 204


@router.post("/logout", status_code=204)
async def logout(response: Response, who: PrincipalDep, state: StateDep) -> None:
    if who.session_token:
        await state.sessions.revoke(who.session_token)
    response.delete_cookie(
        state.settings.cookie_name,
        path="/",
        secure=state.settings.cookie_secure,
        httponly=True,
        samesite="strict",
    )
    response.status_code = 204
