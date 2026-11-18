"""LogoQuest: the server judges every program, Tests unlock the next Learn, and every
check lands in the practice log a parent reads."""

from __future__ import annotations

from datetime import date
from typing import Any

import asyncpg
from httpx import AsyncClient

from arc_api.logo_report import Check, report
from arc_api.routers.logoquest import flags_for, stars_for
from tests.conftest import LQ_LEARN, LQ_TEST, TEST_DB_URL

LQ = "/api/v1/games/logoquest/stages"
RUN = {"runs": 2, "taps": 10, "active_seconds": 30}


async def _start(
    client: AsyncClient, stage: int, headers: dict[str, str] | None = None
) -> dict[str, Any]:
    r = await client.post(f"{LQ}/{stage}/start", headers=headers or {})
    assert r.status_code == 200, r.text
    body: dict[str, Any] = r.json()
    return body


async def _check(
    client: AsyncClient,
    stage: int,
    start: dict[str, Any],
    program: list[dict[str, Any]],
    headers: dict[str, str],
) -> dict[str, Any]:
    r = await client.post(
        f"{LQ}/{stage}/check",
        json={"attempt_id": start["attempt_id"], "program": program, **RUN},
        headers=headers,
    )
    assert r.status_code == 200, r.text
    body: dict[str, Any] = r.json()
    return body


async def _log() -> list[asyncpg.Record]:
    conn = await asyncpg.connect(TEST_DB_URL)
    try:
        rows: list[asyncpg.Record] = await conn.fetch(
            "SELECT level, kind, passed, accuracy, blocks, runs, taps, flags"
            " FROM logo_checks ORDER BY id"
        )
        return rows
    finally:
        await conn.close()


async def test_the_client_gets_the_drawing_but_never_the_answer(app_client: AsyncClient) -> None:
    start = await _start(app_client, 1)
    data = start["data"]
    assert (data["kind"], data["level"], data["par"], data["facts"]) == ("learn", 1, 1, [])
    assert data["target"] == [[0, 0, 0, -100000, "GREEN"]]
    assert "FD 100" not in str(start)
    assert data["tools"]["chips"] == ["fd", "bk", "rt", "lt"]


async def test_learn_then_test_then_the_next_learn(app_client: AsyncClient) -> None:
    start = await _start(app_client, 1)
    headers = {"x-guest-ticket": start["guest_ticket"]}
    # The Test can't be opened before its Learn is passed.
    r = await app_client.post(f"{LQ}/2/start", headers=headers)
    assert r.json()["error"]["code"] == "level_locked"

    wrong = await _check(app_client, 1, start, [{"op": "fd", "n": 40}], headers)
    assert (wrong["passed"], wrong["coins_earned"]) == (False, 0)
    assert wrong["accuracy"] < 90
    right = await _check(app_client, 1, start, LQ_LEARN, headers)
    assert (right["passed"], right["stars"], right["coins_earned"], right["unlocked_level"]) == (
        True,
        3,
        5,
        2,
    )

    # Guests carry their progress in a signed ticket: use the one the win returned.
    headers = {"x-guest-ticket": right["guest_ticket"]}
    test = await _start(app_client, 2, headers)
    assert (test["data"]["kind"], test["data"]["facts"]) == ("test", ["Lengths: 50", "Turns: 90°"])
    assert test["reward"] == 5  # level 1's band
    passed = await _check(app_client, 2, test, LQ_TEST, headers)
    assert (passed["passed"], passed["stars"], passed["unlocked_level"]) == (True, 3, 3)

    log = await _log()
    assert [(r["level"], r["kind"], r["passed"]) for r in log] == [
        (1, "learn", False),
        (1, "learn", True),
        (1, "test", True),
    ]
    # Passed within seconds of opening the level: worth a look.
    assert "fast" in log[1]["flags"]


async def test_any_way_to_draw_it_passes_and_extra_blocks_cost_stars(
    app_client: AsyncClient,
) -> None:
    start = await _start(app_client, 1)
    headers = {"x-guest-ticket": start["guest_ticket"]}
    long_way = [{"op": "fd", "n": 50}, {"op": "fd", "n": 50}]
    r = await _check(app_client, 1, start, long_way, headers)
    # Par is 1: two blocks is within half as many again (2 stars).
    assert (r["passed"], r["blocks"], r["stars"]) == (True, 2, 2)


async def test_bad_programs_are_refused(app_client: AsyncClient) -> None:
    start = await _start(app_client, 1)
    headers = {"x-guest-ticket": start["guest_ticket"]}
    r = await app_client.post(
        f"{LQ}/1/check",
        json={"attempt_id": start["attempt_id"], "program": [{"op": "fd", "n": 999}], **RUN},
        headers=headers,
    )
    assert r.json()["error"]["code"] == "bad_program"


async def test_a_hint_shows_the_missing_line(app_client: AsyncClient) -> None:
    start = await _start(app_client, 1)
    headers = {"x-guest-ticket": start["guest_ticket"]}
    body = {"attempt_id": start["attempt_id"], "program": [], "price": 15}
    r = await app_client.post(f"{LQ}/1/hint", json=body, headers=headers)
    hint = r.json()
    assert (hint["line"], hint["length"], hint["coins"]) == ([0, 0, 0, -100000], 100000, 85)
    r = await app_client.post(f"{LQ}/1/hint", json={**body, "program": LQ_LEARN}, headers=headers)
    assert r.json()["error"]["code"] == "hint_unavailable"


async def test_the_map_names_levels_without_answers(app_client: AsyncClient) -> None:
    r = await app_client.get("/api/v1/games/logoquest/levels")
    assert r.json()[0] == {
        "level": 1,
        "chapter": 1,
        "chapter_name": "Grid Walker",
        "learn": "Up",
        "test": "Corner",
    }
    assert "FD" not in r.text


def test_stars_and_flags() -> None:
    assert [stars_for(b, 4) for b in (3, 4, 6, 7)] == [3, 3, 2, 1]
    assert flags_for(passed=True, seconds=200, par=3, runs=2, taps=9, blocks=3) == ""
    assert (
        flags_for(passed=True, seconds=5, par=3, runs=0, taps=1, blocks=3)
        == "fast,no_runs,few_taps"
    )
    assert flags_for(passed=False, seconds=1, par=3, runs=0, taps=0, blocks=3) == ""


def test_the_report_reads_day_by_day() -> None:
    day = date(2026, 11, 20)

    def c(
        attempt: str, level: int, kind: str, passed: bool, seconds: int, flags: str = ""
    ) -> Check:
        return Check(
            day,
            attempt,
            level,
            kind,
            passed,
            100 if passed else 60,
            3,
            3,
            3 if passed else None,
            seconds,
            seconds,
            2,
            0,
            flags,
        )

    text = report(
        "Nephew",
        [
            c("a", 1, "learn", False, 40),
            c("a", 1, "learn", True, 90),
            c("b", 1, "test", True, 120, "no_runs"),
            c("c", 2, "learn", False, 200),
        ],
        {},
        14,
    )
    assert "2026-11-20  7        1        1             4       2       0      1" in text
    assert "1 ?   1      2:00  2     3/3" in text and "no_runs" in text
    assert "2 learn (?)  1      60%" in text
