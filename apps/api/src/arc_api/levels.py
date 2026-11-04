"""Server-only level catalogue, loaded from the files written by `arc-levelgen`.

One file per game (`<dir>/<game>.json`), so regenerating one game leaves the others
alone. The files reveal every level, so they must never be served or committed.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Final, Literal

import arc_engine

GameId = Literal["water-sort", "brick-blast", "metro-jam", "dead-bridge", "traceout"]
GAME_IDS: Final[tuple[GameId, ...]] = (
    "water-sort",
    "brick-blast",
    "metro-jam",
    "dead-bridge",
    "traceout",
)
SUPPORTED_VERSION = 2


@dataclass(frozen=True, slots=True)
class WsLevel:
    level: int
    seed: int
    colors: int
    empty: int
    min_moves: int
    capacity: int = 4
    # Only each bottle's top colour run is visible until uncovered.
    hidden: bool = False

    def board(self) -> list[list[int]]:
        """The full board, true colours included. Server-only."""
        return arc_engine.ws_generate(self.seed, self.colors, self.empty, self.capacity)

    def stars_for(self, moves: int) -> int:
        if moves <= math.ceil(self.min_moves * 1.2):
            return 3
        if moves <= math.ceil(self.min_moves * 1.6):
            return 2
        return 1

    @property
    def star_thresholds(self) -> tuple[int, int]:
        return math.ceil(self.min_moves * 1.2), math.ceil(self.min_moves * 1.6)


@dataclass(frozen=True, slots=True)
class BbLevel:
    level: int
    script_json: str


@dataclass(frozen=True, slots=True)
class MjLevel:
    level: int
    # Full level including the whole queue. Server-only.
    level_json: str
    # What the client may see at the start.
    public_json: str
    # Commuters shown ahead of the front one; >= queue_len means the whole queue.
    visible: int
    queue_len: int


@dataclass(frozen=True, slots=True)
class DbLevel:
    level: int
    # The whole script is public: the browser simulates what the server replays.
    script_json: str


@dataclass(frozen=True, slots=True)
class ToLevel:
    level: int
    # The whole level is public: every line is on screen.
    level_json: str


@dataclass(frozen=True, slots=True)
class Levels:
    water_sort: dict[int, WsLevel]
    brick_blast: dict[int, BbLevel]
    metro_jam: dict[int, MjLevel]
    dead_bridge: dict[int, DbLevel]
    traceout: dict[int, ToLevel]

    def count(self, game: GameId) -> int:
        if game == "water-sort":
            return len(self.water_sort)
        if game == "brick-blast":
            return len(self.brick_blast)
        if game == "metro-jam":
            return len(self.metro_jam)
        if game == "traceout":
            return len(self.traceout)
        return len(self.dead_bridge)


def _contiguous(levels: dict[int, Any], name: str) -> None:
    if sorted(levels) != list(range(1, len(levels) + 1)):
        raise ValueError(f"{name} levels must be numbered 1..N without gaps")


def _read_game(directory: Path, game: GameId) -> list[dict[str, Any]]:
    path = directory / f"{game}.json"
    data = json.loads(path.read_text("utf-8"))
    if data.get("version") != SUPPORTED_VERSION or data.get("game") != game:
        raise ValueError(f"{path}: expected {game} levels, version {SUPPORTED_VERSION}")
    items = data.get("levels")
    if not isinstance(items, list) or not items:
        raise ValueError(f"{path}: no levels")
    return items


def load(directory: Path) -> Levels:
    ws: dict[int, WsLevel] = {}
    for item in _read_game(directory, "water-sort"):
        lvl = WsLevel(
            level=int(item["level"]),
            seed=int(item["seed"]),
            colors=int(item["colors"]),
            empty=int(item["empty"]),
            min_moves=int(item["min_moves"]),
            capacity=int(item.get("capacity", 4)),
            hidden=bool(item.get("hidden", False)),
        )
        lvl.board()  # validates parameters through the engine
        ws[lvl.level] = lvl

    bb: dict[int, BbLevel] = {}
    for item in _read_game(directory, "brick-blast"):
        script_json = json.dumps(item["script"], separators=(",", ":"))
        arc_engine.bb_validate_script(script_json)
        bb[int(item["level"])] = BbLevel(level=int(item["level"]), script_json=script_json)

    mj: dict[int, MjLevel] = {}
    for item in _read_game(directory, "metro-jam"):
        level_json = json.dumps(item["data"], separators=(",", ":"))
        arc_engine.mj_validate(level_json)
        mj[int(item["level"])] = MjLevel(
            level=int(item["level"]),
            level_json=level_json,
            public_json=arc_engine.mj_public(level_json),
            visible=int(item["data"]["visible"]),
            queue_len=int(item["data"]["queue_len"]),
        )

    db: dict[int, DbLevel] = {}
    for item in _read_game(directory, "dead-bridge"):
        script_json = json.dumps(item["script"], separators=(",", ":"))
        arc_engine.db_validate(script_json)
        db[int(item["level"])] = DbLevel(level=int(item["level"]), script_json=script_json)

    to: dict[int, ToLevel] = {}
    for item in _read_game(directory, "traceout"):
        level_json = json.dumps(item["data"], separators=(",", ":"))
        arc_engine.to_validate(level_json)
        to[int(item["level"])] = ToLevel(level=int(item["level"]), level_json=level_json)

    _contiguous(ws, "water_sort")
    _contiguous(bb, "brick_blast")
    _contiguous(mj, "metro_jam")
    _contiguous(db, "dead_bridge")
    _contiguous(to, "traceout")
    return Levels(water_sort=ws, brick_blast=bb, metro_jam=mj, dead_bridge=db, traceout=to)
