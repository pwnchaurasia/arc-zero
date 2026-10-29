"""Every cheat from the design doc's threat model must fail."""

from __future__ import annotations

import arc_engine
from httpx import AsyncClient

from tests.conftest import guest_through_gate, pow_for, solve_ws


async def _reset_rate_limits(client: AsyncClient) -> None:
    redis = client.app.state.arc.redis  # type: ignore[attr-defined]
    keys = [k async for k in redis.scan_iter("rl:*")]
    if keys:
        await redis.delete(*keys)


async def _start(client: AsyncClient, level: int = 1, ticket: str | None = None) -> dict:  # type: ignore[type-arg]
    headers = {"x-guest-ticket": ticket} if ticket else {}
    r = await client.post(f"/api/v1/games/water-sort/levels/{level}/start", headers=headers)
    assert r.status_code == 200, r.text
    return r.json()  # type: ignore[no-any-return]


async def test_cannot_skip_levels(app_client: AsyncClient) -> None:
    r = await app_client.post("/api/v1/games/water-sort/levels/2/start")
    assert r.status_code == 403
    assert r.json()["error"]["code"] == "level_locked"
    r = await app_client.post("/api/v1/games/water-sort/levels/999/start")
    assert r.status_code == 404


async def test_forged_completion_rejected(app_client: AsyncClient) -> None:
    start = await _start(app_client)
    h = {"x-guest-ticket": start["guest_ticket"]}
    url = "/api/v1/games/water-sort/levels/1/complete"

    r = await app_client.post(url, json={"attempt_id": start["attempt_id"], "moves": []}, headers=h)
    assert r.json()["error"]["code"] == "not_solved"

    r = await app_client.post(
        url, json={"attempt_id": start["attempt_id"], "moves": [[0, 0]]}, headers=h
    )
    assert r.json()["error"]["code"] == "illegal_move"

    r = await app_client.post(
        url, json={"attempt_id": start["attempt_id"], "moves": [[0, 99]]}, headers=h
    )
    assert r.status_code == 422


async def test_completion_is_single_use(app_client: AsyncClient) -> None:
    start = await _start(app_client)
    h = {"x-guest-ticket": start["guest_ticket"]}
    body = {"attempt_id": start["attempt_id"], "moves": solve_ws(start["board"])}
    url = "/api/v1/games/water-sort/levels/1/complete"
    first = (await app_client.post(url, json=body, headers=h)).json()
    again = (await app_client.post(url, json=body, headers=h)).json()
    assert first == again


async def test_attempt_belongs_to_its_owner(app_client: AsyncClient) -> None:
    mine = await _start(app_client)
    stranger = await _start(app_client)  # no ticket sent: a different guest
    r = await app_client.post(
        "/api/v1/games/water-sort/levels/1/complete",
        json={"attempt_id": mine["attempt_id"], "moves": solve_ws(mine["board"])},
        headers={"x-guest-ticket": stranger["guest_ticket"]},
    )
    assert r.status_code == 404


async def test_tampered_ticket_is_ignored(app_client: AsyncClient) -> None:
    ticket = await guest_through_gate(app_client)
    v, kid, payload, mac = ticket.split(".")
    forged = ".".join([v, kid, payload[:-2] + "AA", mac])
    r = await app_client.post(
        "/api/v1/games/water-sort/levels/3/start", headers={"x-guest-ticket": forged}
    )
    assert r.status_code == 403  # treated as a brand-new guest


async def test_inhumanly_fast_completion_rejected(app_client: AsyncClient) -> None:
    app_client.app.state.arc.settings.ws_min_ms_per_move = 60_000  # type: ignore[attr-defined]
    start = await _start(app_client)
    r = await app_client.post(
        "/api/v1/games/water-sort/levels/1/complete",
        json={"attempt_id": start["attempt_id"], "moves": solve_ws(start["board"])},
        headers={"x-guest-ticket": start["guest_ticket"]},
    )
    assert r.json()["error"]["code"] == "too_fast"


async def test_register_requires_gate_pow_and_single_use(app_client: AsyncClient) -> None:
    url = "/api/v1/auth/register"
    early = await _start(app_client)
    r = await app_client.post(
        url,
        json={"guest_ticket": early["guest_ticket"], "pow": await pow_for(app_client, "register")},
    )
    assert r.json()["error"]["code"] == "gate_not_reached"

    ticket = await guest_through_gate(app_client)
    pow_ok = await pow_for(app_client, "register")
    restore_pow = await pow_for(app_client, "restore")
    r = await app_client.post(url, json={"guest_ticket": ticket, "pow": restore_pow})
    assert r.json()["error"]["code"] == "pow_invalid", "pow is bound to its purpose"

    r = await app_client.post(url, json={"guest_ticket": ticket, "pow": pow_ok})
    assert r.status_code == 200, r.text
    await _reset_rate_limits(app_client)
    r = await app_client.post(url, json={"guest_ticket": ticket, "pow": pow_ok})
    assert r.json()["error"]["code"] == "pow_invalid", "challenge burned after use"
    r = await app_client.post(
        url, json={"guest_ticket": ticket, "pow": await pow_for(app_client, "register")}
    )
    assert r.json()["error"]["code"] == "already_registered"


async def test_registration_is_rate_limited_per_ip(app_client: AsyncClient) -> None:
    url = "/api/v1/auth/register"
    codes = []
    for _ in range(4):
        r = await app_client.post(
            url, json={"guest_ticket": "x", "pow": await pow_for(app_client, "register")}
        )
        codes.append(r.status_code)
    assert codes[:3] == [400, 400, 400]
    assert codes[3] == 429
    assert "retry-after" in r.headers


async def test_restore_with_unknown_key(app_client: AsyncClient) -> None:
    for key in ("abandon-ability-able-about-above-absent", "not a key"):
        r = await app_client.post(
            "/api/v1/auth/restore",
            json={"recovery_key": key, "pow": await pow_for(app_client, "restore")},
        )
        assert r.status_code == 401
        assert r.json()["error"]["code"] == "key_not_recognised"


async def test_request_guards(app_client: AsyncClient) -> None:
    url = "/api/v1/games/water-sort/levels/1/start"
    r = await app_client.post(url, headers={"origin": "https://evil.example"})
    assert r.status_code == 403
    r = await app_client.post(
        "/api/v1/pow/challenge",
        content=b"purpose=register",
        headers={"content-type": "application/x-www-form-urlencoded"},
    )
    assert r.status_code == 415
    r = await app_client.post(
        "/api/v1/pow/challenge",
        content=b"{" + b" " * 40_000 + b"}",
        headers={"content-type": "application/json"},
    )
    assert r.status_code == 413
    r = await app_client.post("/api/v1/pow/challenge", json={"purpose": "register", "extra": 1})
    assert r.status_code == 422


async def test_brick_blast_turn_rules(app_client: AsyncClient) -> None:
    r = await app_client.post("/api/v1/games/brick-blast/levels/2/start")
    assert r.json()["error"]["code"] == "level_locked"

    start = (await app_client.post("/api/v1/games/brick-blast/levels/1/start")).json()
    h = {"x-guest-ticket": start["guest_ticket"]}
    url = f"/api/v1/games/brick-blast/runs/{start['run_id']}/turn"
    r = await app_client.post(url, json={"turn": 0, "aim": arc_engine.BB_AIM_MAX + 1}, headers=h)
    assert r.status_code == 422
    r = await app_client.post(url, json={"turn": 5, "aim": 900}, headers=h)
    assert r.json()["error"]["code"] == "turn_mismatch"
    assert "state" in r.json()["error"]
    r = await app_client.post(url, json={"turn": 0, "aim": 900})  # different guest
    assert r.status_code == 404
