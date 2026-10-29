"""Server-only level catalogue, loaded from the file written by `arc-levelgen`.

The file reveals every level, so it must never be served or committed.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Final, Literal

import arc_engine

GameId = Literal["water-sort", "brick-blast"]
GAME_IDS: Final[tuple[GameId, ...]] = ("water-sort", "brick-blast")
SUPPORTED_VERSION = 1


@dataclass(frozen=True, slots=True)
class WsLevel:
    level: int
    seed: int
    colors: int
    empty: int
    min_moves: int

    def board(self) -> list[list[int]]:
        return arc_engine.ws_generate(self.seed, self.colors, self.empty)

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
class Levels:
    water_sort: dict[int, WsLevel]
    brick_blast: dict[int, BbLevel]

    def count(self, game: GameId) -> int:
        return len(self.water_sort) if game == "water-sort" else len(self.brick_blast)


def _contiguous(levels: dict[int, Any], name: str) -> None:
    if sorted(levels) != list(range(1, len(levels) + 1)):
        raise ValueError(f"{name} levels must be numbered 1..N without gaps")


def load(path: Path) -> Levels:
    data = json.loads(path.read_text("utf-8"))
    if data.get("version") != SUPPORTED_VERSION:
        raise ValueError(f"unsupported levels file version {data.get('version')}")

    ws: dict[int, WsLevel] = {}
    for item in data.get("water_sort", []):
        lvl = WsLevel(
            level=int(item["level"]),
            seed=int(item["seed"]),
            colors=int(item["colors"]),
            empty=int(item["empty"]),
            min_moves=int(item["min_moves"]),
        )
        lvl.board()  # validates parameters through the engine
        ws[lvl.level] = lvl

    bb: dict[int, BbLevel] = {}
    for item in data.get("brick_blast", []):
        script_json = json.dumps(item["script"], separators=(",", ":"))
        arc_engine.bb_validate_script(script_json)
        bb[int(item["level"])] = BbLevel(level=int(item["level"]), script_json=script_json)

    _contiguous(ws, "water_sort")
    _contiguous(bb, "brick_blast")
    if not ws or not bb:
        raise ValueError("levels file must contain both games")
    return Levels(water_sort=ws, brick_blast=bb)
