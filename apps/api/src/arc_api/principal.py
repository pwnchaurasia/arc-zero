"""Who is calling: a signed-in player (session cookie) or a guest (signed ticket).

Guests play levels 1..guest_max_level without any database row. Their progress
lives in an HMAC-signed ticket the client carries; tampering breaks the
signature, so a guest cannot fake cleared levels.
"""

from __future__ import annotations

import secrets
import uuid
from dataclasses import dataclass, field
from typing import Annotated, Any

from fastapi import Depends, Request

from arc_api.levels import GAME_IDS
from arc_api.security.signing import InvalidTokenError
from arc_api.state import AppState, StateDep

GUEST_PURPOSE = "guest"
GUEST_HEADER = "x-guest-ticket"


@dataclass(slots=True)
class Guest:
    gid: str
    # Stars per cleared level, in order, keyed by game id.
    progress: dict[str, list[int]] = field(default_factory=dict)

    def cleared(self, game: str) -> int:
        return len(self.progress.get(game, []))


@dataclass(slots=True)
class Principal:
    player_id: uuid.UUID | None = None
    guest: Guest | None = None
    session_token: str | None = None

    @property
    def owner(self) -> str:
        if self.player_id is not None:
            return f"p:{self.player_id}"
        assert self.guest is not None
        return f"g:{self.guest.gid}"


def new_guest() -> Guest:
    return Guest(gid=secrets.token_urlsafe(12))


def issue_ticket(state: AppState, guest: Guest) -> str:
    ttl = state.settings.guest_ticket_ttl_days * 86400
    return state.signer.sign(GUEST_PURPOSE, {"gid": guest.gid, "prog": guest.progress}, ttl)


def parse_ticket(state: AppState, token: str) -> Guest | None:
    try:
        body = state.signer.verify(GUEST_PURPOSE, token)
    except InvalidTokenError:
        return None
    return _guest_from_body(body, state.settings.guest_max_level)


def _guest_from_body(body: dict[str, Any], max_level: int) -> Guest | None:
    gid, prog = body.get("gid"), body.get("prog")
    if not isinstance(gid, str) or not 8 <= len(gid) <= 32 or not isinstance(prog, dict):
        return None
    progress: dict[str, list[int]] = {}
    for game, stars in prog.items():
        if game not in GAME_IDS or not isinstance(stars, list) or len(stars) > max_level:
            return None
        if not all(isinstance(s, int) and 1 <= s <= 3 for s in stars):
            return None
        progress[game] = list(stars)
    return Guest(gid=gid, progress=progress)


async def get_principal(request: Request, state: StateDep) -> Principal:
    token = request.cookies.get(state.settings.cookie_name)
    if token:
        player_id = await state.sessions.lookup(token)
        if player_id is not None:
            return Principal(player_id=player_id, session_token=token)
    ticket = request.headers.get(GUEST_HEADER)
    if ticket:
        guest = parse_ticket(state, ticket)
        if guest is not None:
            return Principal(guest=guest)
    return Principal(guest=new_guest())


PrincipalDep = Annotated[Principal, Depends(get_principal)]
