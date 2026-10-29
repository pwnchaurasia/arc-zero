"""Process-wide services, created once in the app lifespan."""

from __future__ import annotations

from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass
from typing import Annotated, ParamSpec, TypeVar

import anyio.to_thread
from anyio import CapacityLimiter
from fastapi import Depends, Request
from redis.asyncio import Redis
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from arc_api.config import Settings
from arc_api.levels import Levels
from arc_api.security.ratelimit import RateLimiter
from arc_api.security.sessions import Sessions
from arc_api.security.signing import Signer

P = ParamSpec("P")
T = TypeVar("T")


@dataclass(slots=True)
class AppState:
    settings: Settings
    sessionmaker: async_sessionmaker[AsyncSession]
    redis: Redis
    signer: Signer
    limiter: RateLimiter
    sessions: Sessions
    levels: Levels
    engine_slots: CapacityLimiter

    async def run_engine(self, fn: Callable[..., T], *args: object) -> T:
        """Runs a CPU-bound engine call off the event loop, with bounded concurrency."""
        return await anyio.to_thread.run_sync(fn, *args, limiter=self.engine_slots)


def get_state(request: Request) -> AppState:
    state: AppState = request.app.state.arc
    return state


async def get_db(state: Annotated[AppState, Depends(get_state)]) -> AsyncIterator[AsyncSession]:
    async with state.sessionmaker() as session:
        yield session


StateDep = Annotated[AppState, Depends(get_state)]
DbDep = Annotated[AsyncSession, Depends(get_db)]
