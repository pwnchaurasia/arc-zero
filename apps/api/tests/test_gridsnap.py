"""GridSnap: the server deals and applies every move; scores, coins and leaderboards."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

import arc_engine
from httpx import AsyncClient

from arc_api import coins
from arc_api.principal import Principal, new_guest
from tests.conftest import guest_through_gate, pow_for

GS = "/api/v1/games/gridsnap"


async def _start(client: AsyncClient, headers: dict[str, str] | None = None) -> dict[str, Any]:
    r = await client.post(f"{GS}/runs/start", headers=headers or {})
    assert r.status_code == 200, r.text
    body: dict[str, Any] = r.json()
    return body


def _headers(start: dict[str, Any]) -> dict[str, str]:
    return {"x-guest-ticket": start["guest_ticket"]} if start.get("guest_ticket") else {}


def _cells(shape: int, row: int, col: int) -> set[int] | None:
    cells = set()
    for r, bits in enumerate(arc_engine.GS_SHAPES[shape]):
        for c in range(8):
            if bits & (1 << c):
                if row + r > 7 or col + c > 7:
                    return None
                cells.add((row + r) * 8 + col + c)
    return cells


def _spot(view: dict[str, Any], taken: set[int], slot: int) -> tuple[int, int]:
    shape = view["tray"][slot]["shape"]
    for row in range(8):
        for col in range(8):
            cells = _cells(shape, row, col)
            if cells is not None and not cells & taken:
                taken |= cells
                return row, col
    raise AssertionError("no room")


async def _place_first_tray(client: AsyncClient, start: dict[str, Any]) -> dict[str, Any]:
    """Places the whole tray on an empty board, each piece at the first free spot."""
    run, headers, seq = start["run_id"], _headers(start), start["seq"]
    view = start["view"]
    taken: set[int] = set()
    body: dict[str, Any] = {}
    for slot in range(3):
        row, col = _spot(view, taken, slot)
        r = await client.post(
            f"{GS}/runs/{run}/place",
            json={"seq": seq, "slot": slot, "row": row, "col": col},
            headers=headers,
        )
        assert r.status_code == 200, r.text
        body = r.json()
        seq = body["seq"]
    return body


async def _register(client: AsyncClient, name: str) -> None:
    ticket = await guest_through_gate(client)
    r = await client.post(
        "/api/v1/auth/register",
        json={"guest_ticket": ticket, "pow": await pow_for(client, "register"), "name": name},
    )
    assert r.status_code == 200, r.text


async def test_the_server_deals_and_scores(app_client: AsyncClient) -> None:
    start = await _start(app_client)
    view = start["view"]
    assert start["best"] == 0 and start["prices"] == {"reshuffle": 40, "bomb": 60}
    assert len(view["cells"]) == 64 and all(p is not None for p in view["tray"])
    assert "seed" not in view and "deals" not in view

    body = await _place_first_tray(app_client, start)
    assert body["seq"] == 3
    # The tray emptied, so the server dealt a new one.
    assert all(p is not None for p in body["view"]["tray"])
    assert body["view"]["score"] >= 3


async def test_bad_moves_resync_instead_of_counting(app_client: AsyncClient) -> None:
    start = await _start(app_client)
    run, headers = start["run_id"], _headers(start)
    ok = {"seq": 0, "slot": 0, "row": 0, "col": 0}
    r = await app_client.post(f"{GS}/runs/{run}/place", json=ok, headers=headers)
    assert r.is_success
    cells = r.json()["view"]["cells"]
    taken = {i for i, c in enumerate(cells) if c}

    r = await app_client.post(f"{GS}/runs/{run}/place", json=ok, headers=headers)
    assert r.status_code == 409 and r.json()["error"]["seq"] == 1  # a retried request
    shape = start["view"]["tray"][1]["shape"]
    row, col = next(
        (row, col)
        for row in range(8)
        for col in range(8)
        if (spot := _cells(shape, row, col)) is not None and spot & taken
    )
    r = await app_client.post(
        f"{GS}/runs/{run}/place",
        json={"seq": 1, "slot": 1, "row": row, "col": col},
        headers=headers,
    )
    assert r.json()["error"]["code"] == "illegal_move"  # overlaps the first piece
    r = await app_client.post(
        f"{GS}/runs/{run}/place", json={**ok, "seq": 1, "slot": 0, "row": 4}, headers=headers
    )
    assert r.json()["error"]["code"] == "illegal_move"  # slot 0 is already placed

    # Someone else's run looks like no run at all.
    r = await app_client.post(f"{GS}/runs/{run}/place", json={**ok, "seq": 1, "slot": 1})
    assert r.json()["error"]["code"] == "run_not_found"


async def test_ending_records_the_best_once(app_client: AsyncClient) -> None:
    start = await _start(app_client)
    run, headers = start["run_id"], _headers(start)
    await _place_first_tray(app_client, start)
    r = await app_client.post(f"{GS}/runs/{run}/end", headers=headers)
    final = r.json()
    assert final["score"] >= 3 and final["new_best"] is True and final["best"] == final["score"]
    assert final["ranked"] is False  # guests don't appear on leaderboards
    assert (await app_client.post(f"{GS}/runs/{run}/end", headers=headers)).json() == final
    r = await app_client.post(
        f"{GS}/runs/{run}/place",
        json={"seq": 3, "slot": 0, "row": 3, "col": 3},
        headers=headers,
    )
    assert r.json()["error"]["code"] == "run_over"
    assert (await app_client.get("/api/v1/me", headers=headers)).json()["gridsnap_best"] == final[
        "score"
    ]


async def test_a_new_run_closes_the_open_one(app_client: AsyncClient) -> None:
    first = await _start(app_client)
    headers = _headers(first)
    placed = await _place_first_tray(app_client, first)
    # Leaving and coming back continues the same game.
    resumed = (await app_client.get(f"{GS}/runs/current", headers=headers)).json()
    assert (resumed["run_id"], resumed["seq"], resumed["view"]) == (
        first["run_id"],
        3,
        placed["view"],
    )
    second = await _start(app_client, headers)
    assert second["previous"] is not None and second["previous"]["score"] >= 3
    assert second["best"] == second["previous"]["score"]
    await app_client.post(f"{GS}/runs/{second['run_id']}/end", headers=headers)
    r = await app_client.get(f"{GS}/runs/current", headers=headers)
    assert r.status_code == 204


async def test_assists_are_confirmed_and_paid(app_client: AsyncClient) -> None:
    start = await _start(app_client)
    run, headers = start["run_id"], _headers(start)
    reshuffle = {"seq": 0, "kind": "reshuffle", "price": 1}
    r = await app_client.post(f"{GS}/runs/{run}/assist", json=reshuffle, headers=headers)
    assert r.json()["error"]["code"] == "price_changed"

    r = await app_client.post(
        f"{GS}/runs/{run}/assist", json={**reshuffle, "price": 40}, headers=headers
    )
    assert r.status_code == 200, r.text
    assert r.json()["coins"] == 60 and r.json()["seq"] == 1
    bomb = {"seq": 1, "kind": "bomb", "row": 3, "col": 3, "price": 60}
    r = await app_client.post(f"{GS}/runs/{run}/assist", json=bomb, headers=headers)
    assert r.json()["coins"] == 0

    # Broke: refused, and the run is unchanged.
    r = await app_client.post(
        f"{GS}/runs/{run}/assist", json={**reshuffle, "seq": 2, "price": 40}, headers=headers
    )
    assert r.json()["error"]["code"] == "not_enough_coins"
    r = await app_client.post(
        f"{GS}/runs/{run}/place",
        json={"seq": 2, "slot": 0, "row": 0, "col": 0},
        headers=headers,
    )
    assert r.status_code == 200, r.text
    final = (await app_client.post(f"{GS}/runs/{run}/end", headers=headers)).json()
    assert final["ranked"] is False and final["coins"] == 0


async def test_milestones_pay_within_the_daily_cap(app_client: AsyncClient) -> None:
    assert coins.milestone_coins(999) == 0
    assert coins.milestone_coins(2_500) == 10
    assert coins.milestone_coins(50_000) == 30
    state = app_client.app.state.arc  # type: ignore[attr-defined]
    who = Principal(guest=new_guest())
    day = datetime.now(UTC).strftime("%Y%m%d")
    async with state.sessionmaker() as db:
        first = await coins.award_milestones(db, state, who, "gridsnap", 5_000, day)
        second = await coins.award_milestones(db, state, who, "gridsnap", 5_000, day)
        third = await coins.award_milestones(db, state, who, "gridsnap", 5_000, day)
    assert (first.earned, second.earned, third.earned) == (20, 10, 0)
    assert third.balance == coins.START_BALANCE + coins.MILESTONE_DAILY_CAP


async def test_leaderboards_show_names_and_skip_assisted_runs(app_client: AsyncClient) -> None:
    await _register(app_client, "Asha")
    start = await _start(app_client)
    await _place_first_tray(app_client, start)
    asha = (await app_client.post(f"{GS}/runs/{start['run_id']}/end")).json()
    assert asha["ranked"] is True

    # A second run with bought help: a personal best at most, never on the board.
    start = await _start(app_client)
    r = await app_client.post(
        f"{GS}/runs/{start['run_id']}/assist",
        json={"seq": 0, "kind": "reshuffle", "price": 40},
    )
    assert r.status_code == 200
    await _place_first_tray(app_client, {**start, "seq": 1, "view": r.json()["view"]})
    assisted = (await app_client.post(f"{GS}/runs/{start['run_id']}/end")).json()
    assert assisted["ranked"] is False

    for period in ("week", "month", "all"):
        board = (await app_client.get(f"{GS}/leaderboard", params={"period": period})).json()
        assert board["entries"] == [
            {"rank": 1, "name": "Asha", "score": asha["score"], "you": True}
        ]
        assert board["you"]["rank"] == 1
        text = str(board)
        assert "player_id" not in text and "recovery" not in text

    # Another player sees Asha but not themselves.
    app_client.cookies.clear()
    board = (await app_client.get(f"{GS}/leaderboard")).json()
    assert board["signed_in"] is False and board["you"] is None
    assert board["entries"][0]["you"] is False
