"""TraceOut: the server replays every tap; mistakes set the stars; continues must be paid."""

from __future__ import annotations

from typing import Any

from httpx import AsyncClient

from tests.conftest import TO_WIN

TO = "/api/v1/games/traceout/levels"


async def _start(client: AsyncClient, level: int = 1) -> tuple[dict[str, Any], dict[str, str]]:
    r = await client.post(f"{TO}/{level}/start")
    assert r.status_code == 200, r.text
    start: dict[str, Any] = r.json()
    return start, {"x-guest-ticket": start["guest_ticket"]}


async def test_a_clean_clear_earns_three_stars_and_coins(app_client: AsyncClient) -> None:
    start, headers = await _start(app_client)
    assert start["prices"] == {"continue": 20, "hint": 30}
    assert len(start["data"]["lines"]) == 3
    r = await app_client.post(
        f"{TO}/1/complete",
        json={"attempt_id": start["attempt_id"], "moves": TO_WIN},
        headers=headers,
    )
    body = r.json()
    assert (body["stars"], body["mistakes"], body["coins_earned"]) == (3, 0, 5)
    assert body["unlocked_level"] == 2


async def test_mistakes_cost_stars_and_unfinished_boards_lose(app_client: AsyncClient) -> None:
    start, headers = await _start(app_client)
    attempt = start["attempt_id"]
    r = await app_client.post(
        f"{TO}/1/complete", json={"attempt_id": attempt, "moves": TO_WIN[:2]}, headers=headers
    )
    assert r.json()["error"]["code"] == "not_won"
    r = await app_client.post(
        f"{TO}/1/complete", json={"attempt_id": attempt, "moves": [(0, 9)]}, headers=headers
    )
    assert r.json()["error"]["code"] == "illegal_move"
    r = await app_client.post(
        f"{TO}/1/complete",
        json={"attempt_id": attempt, "moves": [(0, 0), *TO_WIN]},
        headers=headers,
    )
    assert (r.json()["stars"], r.json()["mistakes"]) == (2, 1)


async def test_a_continue_must_be_bought(app_client: AsyncClient) -> None:
    start, headers = await _start(app_client)
    attempt = start["attempt_id"]
    out = [(0, 0), (0, 0), (0, 0), (1, 0), *TO_WIN]
    r = await app_client.post(
        f"{TO}/1/complete", json={"attempt_id": attempt, "moves": out}, headers=headers
    )
    assert r.json()["error"]["code"] == "assist_not_bought"

    r = await app_client.post(
        f"{TO}/1/assists",
        json={"attempt_id": attempt, "kind": "continue", "price": 20},
        headers=headers,
    )
    assert r.json()["coins"] == 80
    r = await app_client.post(
        f"{TO}/1/complete", json={"attempt_id": attempt, "moves": out}, headers=headers
    )
    body = r.json()
    # 20 spent comes off the 5-coin reward; 3 mistakes: one star.
    assert (body["stars"], body["coins_earned"], body["coins"]) == (1, 0, 80)


async def test_hints_point_at_a_free_line_and_cost_coins(app_client: AsyncClient) -> None:
    start, headers = await _start(app_client)
    attempt = start["attempt_id"]
    r = await app_client.post(
        f"{TO}/1/hint", json={"attempt_id": attempt, "moves": [], "price": 1}, headers=headers
    )
    assert r.json()["error"]["code"] == "price_changed"
    r = await app_client.post(
        f"{TO}/1/hint", json={"attempt_id": attempt, "moves": [], "price": 30}, headers=headers
    )
    assert r.json() == {"line": 1, "coins": 70, "spent": 30}
    r = await app_client.post(
        f"{TO}/1/hint",
        json={"attempt_id": attempt, "moves": TO_WIN, "price": 30},
        headers=headers,
    )
    assert r.json()["error"]["code"] == "hint_unavailable"  # already won: not charged
    assert (await app_client.get("/api/v1/me", headers=headers)).json()["coins"] == 70
