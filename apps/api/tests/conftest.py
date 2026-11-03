"""Test fixtures. Requires the dev Postgres/Redis from infra/docker-compose.dev.yml.

Uses a dedicated `arc_test` database (migrated with Alembic) and Redis DB 15.
"""

from __future__ import annotations

import hashlib
import json
import os
from collections.abc import AsyncIterator, Iterator
from pathlib import Path
from typing import Any

import arc_engine
import asyncpg
import pytest
from alembic import command
from alembic.config import Config
from httpx import ASGITransport, AsyncClient
from redis.asyncio import Redis

from arc_api.config import Settings
from arc_api.main import create_app
from arc_api.security.pow import leading_zero_bits

API_DIR = Path(__file__).resolve().parents[1]
PG_ADMIN = os.environ.get("ARC_TEST_PG", "postgresql://arc:arc@localhost:55432/arc")
TEST_DB = "arc_test"
TEST_DB_URL = PG_ADMIN.rsplit("/", 1)[0] + f"/{TEST_DB}"
REDIS_URL = os.environ.get("ARC_TEST_REDIS", "redis://localhost:56379/15")
ORIGIN = "http://testserver"


# Water Sort test levels: level -> (capacity, hidden). Level 2 hides colours in taller bottles.
WS_SHAPES = {1: (4, False), 2: (5, True), 3: (4, False), 4: (4, False), 5: (4, False)}


def ws_full_board(level: int) -> list[list[int]]:
    """The true board of a test level (what only the server knows on hidden levels)."""
    return arc_engine.ws_generate(1000 + level, 3, 2, WS_SHAPES[level][0])


def solve_ws(board: list[list[int]], capacity: int = 4) -> list[tuple[int, int]]:
    """Solves a board by following engine hints (stands in for a human player)."""
    moves: list[tuple[int, int]] = []
    while True:
        kind, move = arc_engine.ws_hint(board, capacity, moves, 200_000)
        if kind == "solved":
            return moves
        assert kind == "move" and move is not None, kind
        moves.append(move)


def bb_script(hp: int) -> dict[str, Any]:
    row: list[dict[str, Any]] = [{"t": "empty"} for _ in range(9)]
    row[4] = {"t": "block", "shape": "square", "hp": hp}
    return {"start_balls": 3, "start_rows": [row], "row_queue": []}


# Vehicle 1 is blocked by vehicle 0; tapping 0, 1, 2 wins. Only 3 commuters are visible.
MJ_WIN = [(0, 0), (0, 1), (0, 2)]


def mj_level() -> dict[str, Any]:
    return {
        "width": 4,
        "height": 4,
        "barriers": [],
        "vehicles": [
            {"kind": "hatchback", "color": 0, "x": 1, "y": 0, "dir": "n"},
            {"kind": "hatchback", "color": 1, "x": 1, "y": 1, "dir": "n"},
            {"kind": "sedan", "color": 0, "x": 3, "y": 3, "dir": "e"},
        ],
        "queue": [1, 0, 1, 0, 0, 0, 0, 0],
        "queue_len": 8,
        "bays": 2,
        "visible": 3,
    }


def db_script() -> dict[str, Any]:
    """Six walkers straight down the middle, a cage and a crate: the centred gun wins."""
    return {
        "seed": 7,
        "base_hp": 10,
        "waves": [0],
        "spawns": [{"tick": i * 20, "kind": "walker", "x": 5000, "hp": 40} for i in range(6)],
        "cages": [{"tick": 0, "x": 1500, "stop_y": 6000, "hp": 60, "reward": "turret_left"}],
        "crates": [{"tick": 10, "x": 5000, "kind": "freeze", "hp": 20}],
    }


def make_levels(path: Path) -> None:
    ws = []
    for level in range(1, 6):
        capacity, hidden = WS_SHAPES[level]
        ws.append(
            {
                "level": level,
                "seed": 1000 + level,
                "colors": 3,
                "empty": 2,
                "capacity": capacity,
                "hidden": hidden,
                "min_moves": len(solve_ws(ws_full_board(level), capacity)),
            }
        )
    bb = [{"level": level, "script": bb_script(1)} for level in range(1, 6)]
    mj = [{"level": level, "data": mj_level()} for level in range(1, 6)]
    path.mkdir(parents=True, exist_ok=True)
    db = [{"level": level, "script": db_script()} for level in range(1, 6)]
    for game, levels in (
        ("water-sort", ws),
        ("brick-blast", bb),
        ("metro-jam", mj),
        ("dead-bridge", db),
    ):
        (path / f"{game}.json").write_text(
            json.dumps({"version": 2, "game": game, "levels": levels})
        )


@pytest.fixture(scope="session")
def settings(tmp_path_factory: pytest.TempPathFactory) -> Settings:
    levels = tmp_path_factory.mktemp("levels")
    make_levels(levels)
    return Settings(
        env="test",
        database_url=f"postgresql+asyncpg://{TEST_DB_URL.split('://', 1)[1]}",
        redis_url=REDIS_URL,
        levels_path=levels,
        signing_keys={"k1": "test-signing-key-" + "x" * 40},
        signing_kid="k1",
        recovery_pepper="test-pepper-" + "y" * 40,
        allowed_origins=[ORIGIN],
        allowed_hosts=["testserver"],
        pow_difficulty=8,
        pow_surge_difficulty=8,
        ws_min_ms_per_move=0,
        bb_min_ms_between_turns=0,
        mj_min_ms_per_move=0,
        db_min_real_time_pct=0,
    )


@pytest.fixture(scope="session")
def _database(settings: Settings) -> Iterator[None]:
    import asyncio

    async def recreate() -> None:
        conn = await asyncpg.connect(PG_ADMIN)
        try:
            await conn.execute(f'DROP DATABASE IF EXISTS "{TEST_DB}" WITH (FORCE)')
            await conn.execute(f'CREATE DATABASE "{TEST_DB}"')
        finally:
            await conn.close()

    asyncio.run(recreate())
    os.environ["ARC_DATABASE_URL"] = settings.database_url.get_secret_value()
    command.upgrade(Config(str(API_DIR / "alembic.ini")), "head")
    yield


@pytest.fixture
async def app_client(settings: Settings, _database: None) -> AsyncIterator[AsyncClient]:
    redis = Redis.from_url(REDIS_URL)
    await redis.flushdb()
    await redis.aclose()
    conn = await asyncpg.connect(TEST_DB_URL)
    await conn.execute(
        "TRUNCATE players, game_progress, level_results, hint_usage, play_events CASCADE"
    )
    await conn.close()

    app = create_app(settings.model_copy())
    async with app.router.lifespan_context(app):
        transport = ASGITransport(app=app)
        async with AsyncClient(
            transport=transport, base_url="http://testserver", headers={"origin": ORIGIN}
        ) as client:
            client.app = app  # type: ignore[attr-defined]
            yield client


def solve_pow(challenge: str, difficulty: int) -> int:
    nonce = 0
    while leading_zero_bits(hashlib.sha256(f"{challenge}:{nonce}".encode()).digest()) < difficulty:
        nonce += 1
    return nonce


async def pow_for(client: AsyncClient, purpose: str) -> dict[str, Any]:
    r = await client.post("/api/v1/pow/challenge", json={"purpose": purpose})
    assert r.status_code == 200, r.text
    c = r.json()
    return {"token": c["token"], "nonce": solve_pow(c["challenge"], c["difficulty"])}


async def play_ws_level(
    client: AsyncClient, level: int, ticket: str | None = None
) -> dict[str, Any]:
    headers = {"x-guest-ticket": ticket} if ticket else {}
    r = await client.post(f"/api/v1/games/water-sort/levels/{level}/start", headers=headers)
    assert r.status_code == 200, r.text
    start = r.json()
    ticket = start.get("guest_ticket") or ticket
    headers = {"x-guest-ticket": ticket} if ticket else {}
    # A human can't see hidden colours; this test player knows the true board.
    moves = solve_ws(ws_full_board(level), WS_SHAPES[level][0])
    r = await client.post(
        f"/api/v1/games/water-sort/levels/{level}/complete",
        json={"attempt_id": start["attempt_id"], "moves": moves},
        headers=headers,
    )
    assert r.status_code == 200, r.text
    result: dict[str, Any] = r.json()
    return result


async def guest_through_gate(client: AsyncClient) -> str:
    ticket: str | None = None
    for level in (1, 2, 3):
        result = await play_ws_level(client, level, ticket)
        ticket = result["guest_ticket"]
    assert result["registration_required"] is True
    assert ticket is not None
    return ticket
