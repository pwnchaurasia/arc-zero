"""Happy paths: guest play, the Level-3 gate, registration, restore, hints."""

from __future__ import annotations

from httpx import AsyncClient

from tests.conftest import guest_through_gate, play_ws_level, pow_for, solve_ws


async def test_health_and_ready(app_client: AsyncClient) -> None:
    assert (await app_client.get("/api/v1/health")).json() == {"status": "ok"}
    assert (await app_client.get("/api/v1/ready")).json() == {"status": "ready"}


async def test_security_headers_present(app_client: AsyncClient) -> None:
    r = await app_client.get("/api/v1/health")
    assert r.headers["x-content-type-options"] == "nosniff"
    assert r.headers["x-frame-options"] == "DENY"
    assert r.headers["cache-control"] == "no-store"
    assert "default-src 'none'" in r.headers["content-security-policy"]


async def test_guest_reaches_gate_then_must_register(app_client: AsyncClient) -> None:
    ticket = await guest_through_gate(app_client)
    r = await app_client.post(
        "/api/v1/games/water-sort/levels/4/start", headers={"x-guest-ticket": ticket}
    )
    assert r.status_code == 403
    assert r.json()["error"]["code"] == "registration_required"

    me = (await app_client.get("/api/v1/me", headers={"x-guest-ticket": ticket})).json()
    assert me["signed_in"] is False
    assert me["registration_required"] is True
    assert set(me["games"]["water-sort"]["stars"]) == {"1", "2", "3"}


async def test_register_carries_progress_and_restore_works(app_client: AsyncClient) -> None:
    ticket = await guest_through_gate(app_client)
    r = await app_client.post(
        "/api/v1/auth/register",
        json={"guest_ticket": ticket, "pow": await pow_for(app_client, "register")},
    )
    assert r.status_code == 200, r.text
    key = r.json()["recovery_key"]
    assert len(key.split("-")) == 6
    cookie = r.headers["set-cookie"].lower()
    assert "httponly" in cookie and "samesite=strict" in cookie

    me = (await app_client.get("/api/v1/me")).json()
    assert me["signed_in"] is True
    assert me["games"]["water-sort"]["unlocked_level"] == 4
    assert len(me["games"]["water-sort"]["stars"]) == 3

    result = await play_ws_level(app_client, 4)
    assert result["unlocked_level"] == 5
    assert result["guest_ticket"] is None

    # A fresh device restores with the key (any case / separators).
    app_client.cookies.clear()
    assert (await app_client.get("/api/v1/me")).json()["signed_in"] is False
    r = await app_client.post(
        "/api/v1/auth/restore",
        json={
            "recovery_key": "  " + key.upper().replace("-", " ") + " ",
            "pow": await pow_for(app_client, "restore"),
        },
    )
    assert r.status_code == 204, r.text
    me = (await app_client.get("/api/v1/me")).json()
    assert me["signed_in"] is True
    assert me["games"]["water-sort"]["unlocked_level"] == 5

    r = await app_client.post("/api/v1/auth/logout")
    assert r.status_code == 204
    assert (await app_client.get("/api/v1/me")).json()["signed_in"] is False


async def test_hints_limited_to_three_per_day(app_client: AsyncClient) -> None:
    start = (await app_client.post("/api/v1/games/water-sort/levels/1/start")).json()
    headers = {"x-guest-ticket": start["guest_ticket"]}
    moves: list[list[int]] = []
    for expected_left in (2, 1, 0):
        r = await app_client.post(
            "/api/v1/games/water-sort/levels/1/hint",
            json={"attempt_id": start["attempt_id"], "moves": moves},
            headers=headers,
        )
        assert r.status_code == 200, r.text
        assert r.json()["hints_left"] == expected_left
        moves.append(r.json()["move"])
    r = await app_client.post(
        "/api/v1/games/water-sort/levels/1/hint",
        json={"attempt_id": start["attempt_id"], "moves": moves},
        headers=headers,
    )
    assert r.status_code == 429
    assert r.json()["error"]["code"] == "no_hints_left"


async def test_brick_blast_turn_flow(app_client: AsyncClient) -> None:
    start = (await app_client.post("/api/v1/games/brick-blast/levels/1/start")).json()
    assert "queue" not in start["state"], "upcoming rows must never reach the client"
    headers = {"x-guest-ticket": start["guest_ticket"]}
    run = start["run_id"]
    r = await app_client.post(
        f"/api/v1/games/brick-blast/runs/{run}/turn",
        json={"turn": 0, "aim": 900},
        headers=headers,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "won"
    assert body["stars"] == 3
    assert body["unlocked_level"] == 2
    assert body["guest_ticket"]

    r = await app_client.post(
        f"/api/v1/games/brick-blast/runs/{run}/turn",
        json={"turn": 1, "aim": 900},
        headers=headers,
    )
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "run_over"


async def test_me_gives_guest_one_stable_identity(app_client: AsyncClient) -> None:
    """Regression: parallel first requests must not split a new guest into two."""
    ticket = (await app_client.get("/api/v1/me")).json()["guest_ticket"]
    assert ticket
    headers = {"x-guest-ticket": ticket}
    start = (
        await app_client.post("/api/v1/games/water-sort/levels/1/start", headers=headers)
    ).json()
    again = (await app_client.get("/api/v1/me", headers=headers)).json()["guest_ticket"]
    r = await app_client.post(
        "/api/v1/games/water-sort/levels/1/complete",
        json={"attempt_id": start["attempt_id"], "moves": solve_ws(start["board"])},
        headers={"x-guest-ticket": again},
    )
    assert r.status_code == 200, r.text
