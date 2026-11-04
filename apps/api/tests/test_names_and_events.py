"""Display names over the API, and the first-party play events behind analytics."""

from __future__ import annotations

import asyncpg
from httpx import AsyncClient

from tests.conftest import MJ_WIN, TEST_DB_URL, guest_through_gate, pow_for


async def _events() -> list[asyncpg.Record]:
    conn = await asyncpg.connect(TEST_DB_URL)
    try:
        rows: list[asyncpg.Record] = await conn.fetch(
            "SELECT kind, game_id, level, who, signed_in, seconds FROM play_events ORDER BY id"
        )
        return rows
    finally:
        await conn.close()


async def test_names_need_an_account_and_are_checked(app_client: AsyncClient) -> None:
    r = await app_client.post("/api/v1/me/name", json={"name": "Pawan"})
    assert r.json()["error"]["code"] == "registration_required"

    ticket = await guest_through_gate(app_client)
    r = await app_client.post(
        "/api/v1/auth/register",
        json={
            "guest_ticket": ticket,
            "pow": await pow_for(app_client, "register"),
            "name": "B!tch",
        },
    )
    assert r.json()["error"]["code"] == "bad_name"
    r = await app_client.post(
        "/api/v1/auth/register",
        json={
            "guest_ticket": ticket,
            "pow": await pow_for(app_client, "register"),
            "name": " Pawan  Kumar ",
        },
    )
    assert r.status_code == 200, r.text
    assert (await app_client.get("/api/v1/me")).json()["name"] == "Pawan Kumar"

    r = await app_client.post("/api/v1/me/name", json={"name": "f u c k"})
    assert r.status_code == 422
    r = await app_client.post("/api/v1/me/name", json={"name": "Wankhede"})
    assert r.json() == {"name": "Wankhede"}
    assert (await app_client.get("/api/v1/me")).json()["name"] == "Wankhede"


async def test_plays_are_counted_without_storing_ids(app_client: AsyncClient) -> None:
    start = (await app_client.post("/api/v1/games/metro-jam/levels/1/start")).json()
    ticket = start["guest_ticket"]
    r = await app_client.post(
        "/api/v1/games/metro-jam/levels/1/complete",
        json={"attempt_id": start["attempt_id"], "moves": MJ_WIN},
        headers={"x-guest-ticket": ticket},
    )
    assert r.status_code == 200, r.text
    rows = await _events()
    assert [(e["kind"], e["game_id"], e["level"]) for e in rows] == [
        ("start", "metro-jam", 1),
        ("clear", "metro-jam", 1),
    ]
    # Same player, same pseudonymous key; it is not the guest id itself.
    assert rows[0]["who"] == rows[1]["who"]
    assert len(rows[0]["who"]) == 16 and not rows[0]["signed_in"]
    assert rows[0]["who"] not in ticket
    # Play time on the finishing event only (this test is quick: 0 seconds).
    assert rows[0]["seconds"] is None
    assert rows[1]["seconds"] is not None and 0 <= rows[1]["seconds"] < 60
