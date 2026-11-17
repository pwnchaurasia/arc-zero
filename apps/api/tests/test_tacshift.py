"""TacShift: the server plays the AI move by move; first wins per tier pay once."""

from __future__ import annotations

import json
from typing import Any

import arc_engine
from httpx import AsyncClient

TS = "/api/v1/games/tacshift"


async def _start(
    client: AsyncClient, mode: str, tier: str, headers: dict[str, str] | None = None
) -> dict[str, Any]:
    r = await client.post(f"{TS}/matches", json={"mode": mode, "tier": tier}, headers=headers or {})
    assert r.status_code == 200, r.text
    start: dict[str, Any] = r.json()
    return start


async def _play_out(
    client: AsyncClient, start: dict[str, Any], headers: dict[str, str], seed: int = 1
) -> dict[str, Any]:
    """Plays X with the engine's Hard AI until the match ends. Returns the last reply."""
    match_id, seq, state = start["match_id"], start["seq"], start["state"]
    for turn in range(200):
        cell = arc_engine.ts_ai_move(json.dumps(state), "hard", seed + turn)
        assert cell is not None
        r = await client.post(
            f"{TS}/matches/{match_id}/move", json={"seq": seq, "cell": cell}, headers=headers
        )
        assert r.status_code == 200, r.text
        body: dict[str, Any] = r.json()
        seq, state = body["seq"], body["state"]
        if body["outcome"] is not None:
            return body
    raise AssertionError("the match never ended")


async def test_a_match_starts_empty_and_shows_the_reward(app_client: AsyncClient) -> None:
    start = await _start(app_client, "infinity", "easy")
    assert start["state"]["cells"] == [0] * 9
    assert (start["reward"], start["prices"]) == (10, {"undo": 15, "radar": 25})
    ultimate = await _start(
        app_client, "ultimate", "hard", {"x-guest-ticket": start["guest_ticket"]}
    )
    assert (len(ultimate["state"]["cells"]), ultimate["reward"]) == (81, 60)


async def test_the_server_answers_each_move_and_rejects_bad_ones(app_client: AsyncClient) -> None:
    start = await _start(app_client, "classic", "hard")
    headers = {"x-guest-ticket": start["guest_ticket"]}
    url = f"{TS}/matches/{start['match_id']}/move"
    r = await app_client.post(url, json={"seq": 0, "cell": 4}, headers=headers)
    body = r.json()
    assert body["state"]["cells"][4] == 1
    ai = body["ai"]["cell"]
    assert body["state"]["cells"][ai] == 2 and body["state"]["turn"] == 1
    r = await app_client.post(url, json={"seq": 0, "cell": 0}, headers=headers)
    assert r.json()["error"]["code"] == "out_of_sync"
    r = await app_client.post(url, json={"seq": 1, "cell": ai}, headers=headers)
    assert r.json()["error"]["code"] == "illegal_move"
    other = await app_client.post(url, json={"seq": 1, "cell": 0})  # a different guest
    assert other.json()["error"]["code"] == "match_not_found"


async def test_the_first_win_against_a_tier_pays_once(app_client: AsyncClient) -> None:
    start = await _start(app_client, "infinity", "easy")
    headers = {"x-guest-ticket": start["guest_ticket"]}
    wins = []
    for seed in range(12):
        match = start if seed == 0 else await _start(app_client, "infinity", "easy", headers)
        last = await _play_out(app_client, match, headers, seed)
        if last["outcome"]["result"] == "won":
            wins.append(last["outcome"])
        if len(wins) == 2:
            break
    assert len(wins) == 2, "Hard play should beat the Easy AI"
    assert (wins[0]["first_win"], wins[0]["coins_earned"], wins[0]["coins"]) == (True, 10, 110)
    assert (wins[1]["first_win"], wins[1]["coins_earned"]) == (False, 0)
    r = await app_client.get(f"{TS}/progress", headers=headers)
    earned = {(t["mode"], t["tier"]) for t in r.json()["tiers"] if t["earned"]}
    assert earned == {("infinity", "easy")}
    again = await _start(app_client, "infinity", "easy", headers)
    assert again["reward"] == 0


async def test_holding_classic_hard_to_a_draw_pays(app_client: AsyncClient) -> None:
    start = await _start(app_client, "classic", "hard")
    headers = {"x-guest-ticket": start["guest_ticket"]}
    last = await _play_out(app_client, start, headers)
    outcome = last["outcome"]
    assert (outcome["result"], outcome["first_win"], outcome["coins_earned"]) == ("draw", True, 20)


async def test_undo_and_radar_cost_coins_only_when_they_do_something(
    app_client: AsyncClient,
) -> None:
    start = await _start(app_client, "classic", "medium")
    headers = {"x-guest-ticket": start["guest_ticket"]}
    base = f"{TS}/matches/{start['match_id']}"
    r = await app_client.post(
        f"{base}/assist", json={"seq": 0, "kind": "undo", "price": 15}, headers=headers
    )
    assert r.json()["error"]["code"] == "nothing_to_undo"
    r = await app_client.post(
        f"{base}/assist", json={"seq": 0, "kind": "radar", "price": 1}, headers=headers
    )
    assert r.json()["error"]["code"] == "price_changed"
    r = await app_client.post(
        f"{base}/assist", json={"seq": 0, "kind": "radar", "price": 25}, headers=headers
    )
    radar = r.json()
    assert 0 <= radar["cell"] <= 8 and (radar["coins"], radar["seq"]) == (75, 1)
    r = await app_client.post(
        f"{base}/move", json={"seq": 1, "cell": radar["cell"]}, headers=headers
    )
    assert r.json()["state"]["plies"] == 2
    r = await app_client.post(
        f"{base}/assist", json={"seq": 2, "kind": "undo", "price": 15}, headers=headers
    )
    undone = r.json()
    assert undone["state"]["cells"] == [0] * 9
    assert (undone["coins"], undone["spent"], undone["seq"]) == (60, 40, 3)
