"""Dead Bridge Assault: wins come only from replayed inputs; assists must be paid for."""

from __future__ import annotations

import base64
from typing import Any

from httpx import ASGITransport, AsyncClient

from arc_api.config import Settings
from arc_api.main import create_app

DB = "/api/v1/games/dead-bridge/levels"
AIRSTRIKE = 0


def log(*records: tuple[int, int, int]) -> str:
    """`(ticks since previous, op, arg)` records, as the browser sends them."""
    return base64.b64encode(bytes(b for r in records for b in r)).decode()


async def _start(
    client: AsyncClient, headers: dict[str, str] | None = None
) -> tuple[str, dict[str, str]]:
    r = await client.post(f"{DB}/1/start", headers=headers or {})
    assert r.status_code == 200, r.text
    body: dict[str, Any] = r.json()
    assert body["script"]["spawns"], "the whole script is public"
    return body["attempt_id"], {"x-guest-ticket": body["guest_ticket"]}


async def test_replayed_win_pays_once(app_client: AsyncClient) -> None:
    headers: dict[str, str] | None = None
    for expected, first in ((5, True), (0, False)):
        attempt, headers = await _start(app_client, headers)
        r = await app_client.post(
            f"{DB}/1/complete", json={"attempt_id": attempt, "log": ""}, headers=headers
        )
        assert r.status_code == 200, r.text
        done = r.json()
        assert done["stars"] == 3 and done["kills"] == 6
        assert done["first_clear"] is first and done["coins_earned"] == expected
        headers = {"x-guest-ticket": done["guest_ticket"]}


async def test_bad_inputs_and_unpaid_assists_are_refused(app_client: AsyncClient) -> None:
    attempt, headers = await _start(app_client)
    # Using an assist with no charge doesn't replay.
    r = await app_client.post(
        f"{DB}/1/complete",
        json={"attempt_id": attempt, "log": log((5, 1, AIRSTRIKE))},
        headers=headers,
    )
    assert r.json()["error"]["code"] == "bad_log"
    # A bought charge that wasn't paid for.
    bought_log = log((0, 2, AIRSTRIKE), (60, 1, AIRSTRIKE))
    r = await app_client.post(
        f"{DB}/1/complete", json={"attempt_id": attempt, "log": bought_log}, headers=headers
    )
    assert r.json()["error"]["code"] == "assist_not_bought"

    buy = {"attempt_id": attempt, "kind": "airstrike", "price": 60}
    r = await app_client.post(f"{DB}/1/assists", json=buy, headers=headers)
    assert r.status_code == 200, r.text
    assert r.json()["coins"] == 40
    r = await app_client.post(
        f"{DB}/1/complete", json={"attempt_id": attempt, "log": bought_log}, headers=headers
    )
    assert r.status_code == 200, r.text
    assert r.json()["coins_earned"] == 0  # 5 for the level minus 60 spent, never below 0


async def test_faster_than_real_time_is_refused(
    app_client: AsyncClient, settings: Settings
) -> None:
    strict = create_app(settings.model_copy(update={"db_min_real_time_pct": 85}))
    async with strict.router.lifespan_context(strict):
        transport = ASGITransport(app=strict)
        async with AsyncClient(
            transport=transport,
            base_url="http://testserver",
            headers={"origin": "http://testserver"},
        ) as client:
            attempt, headers = await _start(client)
            r = await client.post(
                f"{DB}/1/complete", json={"attempt_id": attempt, "log": ""}, headers=headers
            )
            assert r.json()["error"]["code"] == "too_fast"
