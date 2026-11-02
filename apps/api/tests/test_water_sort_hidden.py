"""Water Sort: hidden colours stay on the server, extra bottles must be bought, coins."""

from __future__ import annotations

from typing import Any

import arc_engine
from httpx import AsyncClient

from tests.conftest import WS_SHAPES, play_ws_level, solve_ws, ws_full_board

WS = "/api/v1/games/water-sort/levels"
HIDDEN = 255


async def _hidden_level_start(client: AsyncClient) -> tuple[dict[str, Any], dict[str, str]]:
    """A guest clears level 1, then starts the hidden level 2."""
    first = await play_ws_level(client, 1)
    headers = {"x-guest-ticket": first["guest_ticket"]}
    r = await client.post(f"{WS}/2/start", headers=headers)
    assert r.status_code == 200, r.text
    start: dict[str, Any] = r.json()
    headers["x-guest-ticket"] = start["guest_ticket"]
    return start, headers


async def test_hidden_colours_never_reach_the_client(app_client: AsyncClient) -> None:
    start, _ = await _hidden_level_start(app_client)
    assert start["hidden"] is True and start["capacity"] == 5
    full = ws_full_board(2)
    for masked, true in zip(start["board"], full, strict=True):
        assert len(masked) == len(true)
        if not true:
            continue
        # Only the top run is shown, in its true colour; everything under it is masked.
        shown = [c for c in masked if c != HIDDEN]
        assert shown and all(c == true[-1] for c in shown)
        assert masked[len(masked) - len(shown) :] == true[len(true) - len(shown) :]
    assert any(HIDDEN in b for b in start["board"])


async def test_reveal_uncovers_and_undo_keeps_what_was_seen(app_client: AsyncClient) -> None:
    start, headers = await _hidden_level_start(app_client)
    moves = solve_ws(ws_full_board(2), WS_SHAPES[2][0])
    hidden_before = sum(b.count(HIDDEN) for b in start["board"])
    body = {"attempt_id": start["attempt_id"], "moves": moves[:3]}
    after = (await app_client.post(f"{WS}/2/reveal", json=body, headers=headers)).json()["board"]
    hidden_after = sum(b.count(HIDDEN) for b in after)
    assert hidden_after < hidden_before

    # Undo back to the start: colours already seen stay visible.
    body = {"attempt_id": start["attempt_id"], "moves": []}
    undone = (await app_client.post(f"{WS}/2/reveal", json=body, headers=headers)).json()["board"]
    assert sum(b.count(HIDDEN) for b in undone) < hidden_before


async def test_extra_bottle_must_be_bought(app_client: AsyncClient) -> None:
    start, headers = await _hidden_level_start(app_client)
    add = list(arc_engine.WS_ADD_BOTTLE)
    body = {"attempt_id": start["attempt_id"], "moves": [add]}
    r = await app_client.post(f"{WS}/2/reveal", json=body, headers=headers)
    assert r.json()["error"]["code"] == "assist_not_bought"

    buy = {"attempt_id": start["attempt_id"], "kind": "extra_bottle", "price": 60}
    r = await app_client.post(f"{WS}/2/assists", json=buy, headers=headers)
    assert r.status_code == 200, r.text
    assert r.json()["coins"] == 100 + 5 - 60  # level 1 paid 5 coins first
    r = await app_client.post(f"{WS}/2/reveal", json=body, headers=headers)
    assert len(r.json()["board"]) == len(start["board"]) + 1

    # Win using the extra bottle: the reward (5) minus 60 spent is 0, never negative.
    moves = [tuple(add), *solve_ws(ws_full_board(2), WS_SHAPES[2][0])]
    r = await app_client.post(
        f"{WS}/2/complete",
        json={"attempt_id": start["attempt_id"], "moves": moves},
        headers=headers,
    )
    done = r.json()
    assert r.status_code == 200, r.text
    assert done["first_clear"] is True and done["coins_earned"] == 0
    assert done["coins"] == 45


async def test_first_clear_pays_coins(app_client: AsyncClient) -> None:
    result = await play_ws_level(app_client, 1)
    assert result["first_clear"] is True
    assert result["coins_earned"] == 5
    assert result["coins"] == 105
