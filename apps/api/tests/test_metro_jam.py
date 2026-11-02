"""MetroJam and coins: verified wins, hidden queue, paid assists, no farming."""

from __future__ import annotations

from typing import Any

import asyncpg
from httpx import AsyncClient

from tests.conftest import MJ_WIN, TEST_DB_URL, pow_for

BASE = "/api/v1/games/metro-jam/levels"


class Guest:
    def __init__(self, client: AsyncClient) -> None:
        self.client = client
        self.ticket: str | None = None

    async def post(self, path: str, body: dict[str, Any] | None = None) -> Any:
        headers = {"x-guest-ticket": self.ticket} if self.ticket else {}
        r = await self.client.post(path, json=body, headers=headers)
        data = r.json()
        if isinstance(data, dict) and data.get("guest_ticket"):
            self.ticket = data["guest_ticket"]
        return r

    async def start(self, level: int) -> dict[str, Any]:
        r = await self.post(f"{BASE}/{level}/start")
        assert r.status_code == 200, r.text
        return r.json()  # type: ignore[no-any-return]

    async def win(self, level: int, moves: list[tuple[int, int]] | None = None) -> dict[str, Any]:
        start = await self.start(level)
        r = await self.post(
            f"{BASE}/{level}/complete",
            {"attempt_id": start["attempt_id"], "moves": moves or MJ_WIN},
        )
        assert r.status_code == 200, r.text
        return r.json()  # type: ignore[no-any-return]


async def test_start_hides_the_far_end_of_the_queue(app_client: AsyncClient) -> None:
    g = Guest(app_client)
    start = await g.start(1)
    assert start["data"]["queue"] == [1, 0, 1]
    assert start["data"]["queue_len"] == 8
    assert start["coins"] == 100
    assert start["reward"] == 5

    r = await g.post(f"{BASE}/1/reveal", {"attempt_id": start["attempt_id"], "moves": [[0, 0]]})
    assert r.json()["queue"] == [1, 0, 1]
    r = await g.post(f"{BASE}/1/reveal", {"attempt_id": start["attempt_id"], "moves": MJ_WIN[:2]})
    # Four commuters boarded, three more visible.
    assert r.json()["queue"] == [1, 0, 1, 0, 0, 0, 0]


async def test_first_clear_pays_and_replays_pay_nothing(app_client: AsyncClient) -> None:
    g = Guest(app_client)
    first = await g.win(1)
    assert first["first_clear"] is True
    assert first["coins_earned"] == 5
    assert first["coins"] == 105
    assert first["stars"] == 3

    again = await g.win(1)
    assert again["first_clear"] is False
    assert again["coins_earned"] == 0
    assert again["coins"] == 105


async def test_three_assist_free_clears_pay_the_streak_bonus(app_client: AsyncClient) -> None:
    g = Guest(app_client)
    for level in (1, 2):
        assert (await g.win(level))["streak_bonus"] == 0
    third = await g.win(3)
    assert third["streak_bonus"] == 25
    assert third["coins"] == 100 + 3 * 5 + 25


async def test_assists_must_be_bought_and_reduce_the_reward(app_client: AsyncClient) -> None:
    g = Guest(app_client)
    start = await g.start(1)
    attempt = start["attempt_id"]
    lifted = [(1, 1), (0, 0), (0, 2)]  # airlift the blocked car first

    r = await g.post(f"{BASE}/1/complete", {"attempt_id": attempt, "moves": lifted})
    assert r.status_code == 422
    assert r.json()["error"]["code"] == "assist_not_bought"

    r = await g.post(f"{BASE}/1/assists", {"attempt_id": attempt, "kind": "airlift", "price": 1})
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "price_changed"

    r = await g.post(f"{BASE}/1/assists", {"attempt_id": attempt, "kind": "airlift", "price": 80})
    assert r.status_code == 200, r.text
    assert r.json()["coins"] == 20

    r = await g.post(f"{BASE}/1/assists", {"attempt_id": attempt, "kind": "airlift", "price": 80})
    assert r.status_code == 402
    assert r.json()["error"]["code"] == "not_enough_coins"

    r = await g.post(f"{BASE}/1/complete", {"attempt_id": attempt, "moves": lifted})
    assert r.status_code == 200, r.text
    done = r.json()
    assert done["stars"] == 2
    # 5 for the level minus 80 spent, never below zero.
    assert done["coins_earned"] == 0
    assert done["coins"] == 20


async def test_wins_are_verified(app_client: AsyncClient) -> None:
    g = Guest(app_client)
    start = await g.start(1)
    attempt = start["attempt_id"]
    r = await g.post(f"{BASE}/1/complete", {"attempt_id": attempt, "moves": [[0, 1]]})
    assert r.json()["error"]["code"] == "illegal_move"
    r = await g.post(f"{BASE}/1/complete", {"attempt_id": attempt, "moves": MJ_WIN[:2]})
    assert r.json()["error"]["code"] == "not_won"
    r = await g.post(f"{BASE}/2/start")
    assert r.json()["error"]["code"] == "level_locked"


async def test_guest_coins_move_to_the_account(app_client: AsyncClient) -> None:
    g = Guest(app_client)
    for level in (1, 2, 3):
        result = await g.win(level)
    assert result["coins"] == 140
    r = await app_client.post(
        "/api/v1/auth/register",
        json={"guest_ticket": g.ticket, "pow": await pow_for(app_client, "register")},
    )
    assert r.status_code == 200, r.text
    me = (await app_client.get("/api/v1/me")).json()
    assert me["coins"] == 140
    assert me["games"]["metro-jam"]["unlocked_level"] == 4

    # Levels paid as a guest don't pay again; new ones do (25 from level 4).
    start = (await app_client.post(f"{BASE}/3/start")).json()
    r = await app_client.post(
        f"{BASE}/3/complete", json={"attempt_id": start["attempt_id"], "moves": MJ_WIN}
    )
    assert r.json()["coins_earned"] == 0
    start = (await app_client.post(f"{BASE}/4/start")).json()
    r = await app_client.post(
        f"{BASE}/4/complete", json={"attempt_id": start["attempt_id"], "moves": MJ_WIN}
    )
    assert r.json()["coins_earned"] == 25
    assert r.json()["coins"] == 165

    conn = await asyncpg.connect(TEST_DB_URL)
    try:
        rows = await conn.fetch("SELECT delta, balance_after FROM coin_ledger ORDER BY id")
    finally:
        await conn.close()
    assert sum(row["delta"] for row in rows) == 165
    assert rows[-1]["balance_after"] == 165


async def test_coin_rules_endpoint(app_client: AsyncClient) -> None:
    rules = (await app_client.get("/api/v1/coins")).json()
    assert rules["balance"] == 100
    assert rules["rewards"][0] == {"first_level": 1, "last_level": 3, "coins": 5}
    assert rules["prices"] == {"extra_bay": 60, "airlift": 80, "shuffle": 40}
