"""Display names over the API, and the first-party play events behind analytics."""

from __future__ import annotations

import asyncpg
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from arc_api.config import Settings
from arc_api.db import make_engine, make_sessionmaker
from arc_api.player_report import by_game, render, totals
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


async def test_report_links_plays_to_names_and_keeps_guests_anonymous(
    app_client: AsyncClient, settings: Settings
) -> None:
    async def play(ticket: str | None = None) -> str:
        headers = {"x-guest-ticket": ticket} if ticket else {}
        start = await app_client.post("/api/v1/games/metro-jam/levels/1/start", headers=headers)
        body = start.json()
        ticket = body.get("guest_ticket") or ticket
        done = await app_client.post(
            "/api/v1/games/metro-jam/levels/1/complete",
            json={"attempt_id": body["attempt_id"], "moves": MJ_WIN},
            headers={"x-guest-ticket": ticket} if ticket else {},
        )
        assert done.status_code == 200, done.text
        return ticket or ""

    await play()
    ticket = await guest_through_gate(app_client)
    r = await app_client.post(
        "/api/v1/auth/register",
        json={
            "guest_ticket": ticket,
            "pow": await pow_for(app_client, "register"),
            "name": "Nisha",
        },
    )
    assert r.status_code == 200, r.text
    await play()

    engine = make_engine(settings.database_url.get_secret_value(), 1, 0)
    try:
        session: AsyncSession
        async with make_sessionmaker(engine)() as session:
            rows = await by_game(session, settings.recovery_pepper.get_secret_value())
    finally:
        await engine.dispose()

    named = [row for row in rows if row.name == "Nisha"]
    assert [(row.game, row.plays, row.clears) for row in named] == [("metro-jam", 1, 1)]
    assert {row.name for row in rows} == {"Nisha", "(guest)"}
    assert sum(games for _, games in totals(named)) == 1
    assert "Nisha" in render(rows)


async def test_opening_the_app_counts_one_visit_per_person_per_day(
    app_client: AsyncClient,
) -> None:
    first = await app_client.get("/api/v1/me")
    ticket = first.json()["guest_ticket"]
    for _ in range(3):
        await app_client.get("/api/v1/me", headers={"x-guest-ticket": ticket})
    rows = await _events()
    assert [(e["kind"], e["game_id"], e["level"]) for e in rows] == [("visit", None, None)]
    assert len(rows[0]["who"]) == 16 and not rows[0]["signed_in"]

    # Another browser is another visitor.
    app_client.cookies.clear()
    await app_client.get("/api/v1/me")
    assert len({e["who"] for e in await _events()}) == 2
