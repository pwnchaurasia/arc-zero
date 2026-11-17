"""Cipher9: the solution never leaves the server; it replays the moves, counts mistakes
for the stars and charges for hints and assists only after the player confirmed."""

from __future__ import annotations

from typing import Any

from httpx import AsyncClient

from tests.conftest import C9_PUZZLE, C9_SOLUTION, C9_WIN

C9 = "/api/v1/games/cipher9/levels"


async def _start(client: AsyncClient, level: int = 1) -> tuple[dict[str, Any], dict[str, str]]:
    r = await client.post(f"{C9}/{level}/start")
    assert r.status_code == 200, r.text
    start: dict[str, Any] = r.json()
    return start, {"x-guest-ticket": start["guest_ticket"]}


async def test_the_client_gets_the_givens_but_never_the_solution(app_client: AsyncClient) -> None:
    start, _ = await _start(app_client)
    assert start["data"]["puzzle"] == [int(d) for d in C9_PUZZLE]
    assert start["prices"] == {"hint": 25, "auto_notes": 20, "clear_wrong": 15}
    assert C9_SOLUTION not in str(start)
    assert "solution" not in str(start)


async def test_a_clean_solve_earns_three_stars_and_coins(app_client: AsyncClient) -> None:
    start, headers = await _start(app_client)
    r = await app_client.post(
        f"{C9}/1/complete",
        json={"attempt_id": start["attempt_id"], "moves": C9_WIN},
        headers=headers,
    )
    body = r.json()
    assert (body["stars"], body["mistakes"], body["coins_earned"]) == (3, 0, 5)
    assert body["unlocked_level"] == 2
    # A retried request gets the same answer, never more coins.
    again = await app_client.post(
        f"{C9}/1/complete",
        json={"attempt_id": start["attempt_id"], "moves": C9_WIN},
        headers=headers,
    )
    assert again.json() == body


async def test_wrong_numbers_cost_stars_and_unfinished_grids_lose(app_client: AsyncClient) -> None:
    start, headers = await _start(app_client)
    attempt = start["attempt_id"]
    r = await app_client.post(
        f"{C9}/1/complete", json={"attempt_id": attempt, "moves": C9_WIN[:-1]}, headers=headers
    )
    assert r.json()["error"]["code"] == "not_won"
    r = await app_client.post(
        f"{C9}/1/complete", json={"attempt_id": attempt, "moves": [(0, 1)]}, headers=headers
    )
    assert r.json()["error"]["code"] == "illegal_move"  # cell 0 is a given
    # Cell 2 should be a 4: a 1 then a 2 are two mistakes, even though it's fixed later.
    r = await app_client.post(
        f"{C9}/1/complete",
        json={"attempt_id": attempt, "moves": [(2, 1), (2, 2), *C9_WIN]},
        headers=headers,
    )
    assert (r.json()["stars"], r.json()["mistakes"]) == (2, 2)


async def test_a_hint_explains_the_next_number(app_client: AsyncClient) -> None:
    start, headers = await _start(app_client)
    attempt = start["attempt_id"]
    r = await app_client.post(
        f"{C9}/1/hint", json={"attempt_id": attempt, "moves": [], "price": 1}, headers=headers
    )
    assert r.json()["error"]["code"] == "price_changed"
    r = await app_client.post(
        f"{C9}/1/hint", json={"attempt_id": attempt, "moves": [], "price": 25}, headers=headers
    )
    hint = r.json()
    assert hint["digit"] == int(C9_SOLUTION[hint["cell"]])
    assert hint["technique"] in {"naked_single", "hidden_single"}
    assert (hint["coins"], hint["spent"]) == (75, 25)
    r = await app_client.post(
        f"{C9}/1/hint", json={"attempt_id": attempt, "moves": C9_WIN, "price": 25}, headers=headers
    )
    assert r.json()["error"]["code"] == "already_complete" or r.json()["error"]["code"] == (
        "hint_unavailable"
    )
    assert (await app_client.get("/api/v1/me", headers=headers)).json()["coins"] == 75


async def test_clearing_wrong_numbers_is_charged_only_when_there_are_some(
    app_client: AsyncClient,
) -> None:
    start, headers = await _start(app_client)
    attempt = start["attempt_id"]
    buy = {"attempt_id": attempt, "kind": "clear_wrong", "price": 15}
    r = await app_client.post(f"{C9}/1/assists", json={**buy, "moves": []}, headers=headers)
    assert r.json()["error"]["code"] == "nothing_wrong"
    right = C9_WIN[1]  # C9_WIN[0] is cell 2 itself
    r = await app_client.post(
        f"{C9}/1/assists", json={**buy, "moves": [(2, 1), right]}, headers=headers
    )
    assert (r.json()["wrong"], r.json()["coins"]) == ([2], 85)


async def test_auto_notes_are_bought_once_per_attempt(app_client: AsyncClient) -> None:
    start, headers = await _start(app_client)
    buy = {"attempt_id": start["attempt_id"], "kind": "auto_notes", "price": 20, "moves": []}
    r = await app_client.post(f"{C9}/1/assists", json=buy, headers=headers)
    assert (r.json()["owned"], r.json()["coins"]) == ({"auto_notes": 1}, 80)
    r = await app_client.post(f"{C9}/1/assists", json=buy, headers=headers)
    assert r.json()["error"]["code"] == "assist_limit"
    # The 20 spent comes off the 5-coin reward.
    r = await app_client.post(
        f"{C9}/1/complete",
        json={"attempt_id": start["attempt_id"], "moves": C9_WIN},
        headers=headers,
    )
    assert (r.json()["coins_earned"], r.json()["coins"]) == (0, 80)
