"""Shared request helpers for routers."""

from __future__ import annotations

from fastapi import Request
from pydantic import BaseModel, ConfigDict

from arc_api.principal import Principal
from arc_api.security.ratelimit import ip_bucket
from arc_api.state import AppState

# Generous per-IP ceiling: mobile carriers put many players behind one address.
IP_LIMIT_PER_MINUTE = 600


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


def client_ip(request: Request) -> str:
    return ip_bucket(request.client.host if request.client else None)


async def limit(
    state: AppState, request: Request, who: Principal, action: str, per_minute: int
) -> None:
    """Rate-limits an action per caller and per IP bucket."""
    await state.limiter.hit(f"{action}:{who.owner}", per_minute, 60)
    await state.limiter.hit(f"ip:{client_ip(request)}", IP_LIMIT_PER_MINUTE, 60)
