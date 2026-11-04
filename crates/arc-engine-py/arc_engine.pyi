"""Type stubs for the native `arc_engine` extension (crates/arc-engine-py)."""

from typing import Final, Literal

WS_MAX_MOVES: Final[int]
BB_AIM_MIN: Final[int]
BB_AIM_MAX: Final[int]
BB_TICKS_PER_SECOND: Final[int]

class EngineError(ValueError): ...

class TurnResult:
    state: str
    public_state: str
    hash: str
    status: Literal["playing", "won", "lost"]
    stars: int
    turn: int
    new_row: str | None
    ticks: int

WS_ADD_BOTTLE: Final[tuple[int, int]]
WS_MAX_EXTRA_BOTTLES: Final[int]

def ws_generate(seed: int, colors: int, empty: int, capacity: int) -> list[list[int]]: ...
def ws_replay(board: list[list[int]], capacity: int, moves: list[tuple[int, int]]) -> bool: ...
def ws_view(
    board: list[list[int]], capacity: int, moves: list[tuple[int, int]], hidden: bool, seen_hex: str
) -> tuple[list[list[int]], str]: ...
def ws_bottles_added(moves: list[tuple[int, int]]) -> int: ...
def ws_hint(
    board: list[list[int]], capacity: int, moves: list[tuple[int, int]], budget: int
) -> tuple[Literal["move", "dead_end", "solved", "unknown"], tuple[int, int] | None]: ...
def bb_new_run(script_json: str) -> str: ...
def bb_validate_script(script_json: str) -> None: ...
def bb_public_state(state_json: str) -> str: ...
def bb_play_turn(state_json: str, aim: int) -> TurnResult: ...
def bb_best_aim(state_json: str, candidates: int) -> int | None: ...
def bb_apply_assist(state_json: str, assist: str, col: int) -> TurnResult: ...

# MetroJam
MJ_MAX_MOVES: Final[int]

class MjReplay:
    won: bool
    stuck: bool
    boarded: int
    assists: list[int]
    revealed: list[int]

def mj_validate(level_json: str) -> None: ...
def mj_public(level_json: str) -> str: ...
def mj_replay(level_json: str, moves: list[tuple[int, int]]) -> MjReplay: ...

# Dead Bridge Assault
DB_TPS: Final[int]
DB_MAX_LOG_BYTES: Final[int]

class DbReplay:
    status: Literal["won", "lost"]
    stars: int
    base_hp: int
    ticks: int
    kills: int
    bought: list[int]

def db_validate(script_json: str) -> None: ...
def db_replay(script_json: str, log: bytes) -> DbReplay: ...

# GridSnap
GS_MAX_RESHUFFLES: Final[int]
GS_MAX_BOMBS: Final[int]
GS_SHAPES: Final[list[list[int]]]
GS_STONE: Final[int]

class GsStep:
    state: str
    view: str
    status: Literal["playing", "stuck", "ended", "won"]
    score: int
    lines: int
    placed: int
    points: int

def gs_new(seed: int) -> GsStep: ...
def gs_place(state_json: str, slot: int, row: int, col: int) -> GsStep: ...
def gs_assist(state_json: str, kind: str, row: int, col: int) -> GsStep: ...
def gs_end(state_json: str) -> GsStep: ...
def gs_level(seed: int, stage: int, cells: list[int]) -> GsStep: ...
def gs_stars(placed: int, par: int) -> int: ...

# TraceOut
TO_MAX_MOVES: Final[int]
TO_MAX_CONTINUES: Final[int]

class ToReplay:
    status: Literal["playing", "won", "out"]
    stars: int
    mistakes: int
    continues: int
    remaining: int
    free: int | None

def to_validate(level_json: str) -> None: ...
def to_replay(level_json: str, moves: list[tuple[int, int]]) -> ToReplay: ...
