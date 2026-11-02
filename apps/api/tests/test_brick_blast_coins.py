"""Brick Blast coins: first clears pay, assists cost and reduce the reward, paid hints."""

from __future__ import annotations

from typing import Any

from httpx import AsyncClient

BB = "/api/v1/games/brick-blast"


async def _start(
    client: AsyncClient, headers: dict[str, str] | None = None
) -> tuple[str, dict[str, str]]:
    start = (await client.post(f"{BB}/levels/1/start", headers=headers or {})).json()
    return start["run_id"], {"x-guest-ticket": start["guest_ticket"]}


async def test_first_clear_pays_and_replay_does_not(app_client: AsyncClient) -> None:
    headers: dict[str, str] | None = None
    for expected, first in ((5, True), (0, False)):
        run, headers = await _start(app_client, headers)  # same guest both times
        r = await app_client.post(
            f"{BB}/runs/{run}/turn", json={"turn": 0, "aim": 900}, headers=headers
        )
        body: dict[str, Any] = r.json()
        assert body["status"] == "won"
        assert body["first_clear"] is first
        assert body["coins_earned"] == expected
    assert body["coins"] == 105


async def test_assists_are_confirmed_paid_and_cut_the_reward(app_client: AsyncClient) -> None:
    run, headers = await _start(app_client)
    r = await app_client.post(
        f"{BB}/runs/{run}/assist",
        json={"turn": 0, "kind": "laser", "col": 4, "price": 1},
        headers=headers,
    )
    assert r.json()["error"]["code"] == "price_changed"
    r = await app_client.post(
        f"{BB}/runs/{run}/assist",
        json={"turn": 0, "kind": "laser", "col": 0, "price": 70},
        headers=headers,
    )
    assert r.json()["error"]["code"] == "assist_not_possible"  # empty column: not charged
    assert (await app_client.get("/api/v1/me", headers=headers)).json()["coins"] == 100

    # The laser clears the only block: the level is won, and 70 spent > 5 reward.
    r = await app_client.post(
        f"{BB}/runs/{run}/assist",
        json={"turn": 0, "kind": "laser", "col": 4, "price": 70},
        headers=headers,
    )
    body = r.json()
    assert body["status"] == "won"
    assert body["coins_earned"] == 0
    assert body["coins"] == 30


async def test_hints_cost_coins_after_the_free_ones(app_client: AsyncClient) -> None:
    run, headers = await _start(app_client)
    for left in (2, 1, 0):
        r = await app_client.post(f"{BB}/runs/{run}/hint", json={}, headers=headers)
        assert r.json()["hints_left"] == left
    r = await app_client.post(f"{BB}/runs/{run}/hint", json={}, headers=headers)
    assert r.status_code == 429
    assert r.json()["error"]["price"] == 20
    r = await app_client.post(f"{BB}/runs/{run}/hint", json={"pay": 20}, headers=headers)
    assert r.status_code == 200, r.text
    assert r.json()["coins"] == 80
