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

def ws_generate(seed: int, colors: int, empty: int) -> list[list[int]]: ...
def ws_replay(board: list[list[int]], moves: list[tuple[int, int]]) -> bool: ...
def ws_hint(
    board: list[list[int]], moves: list[tuple[int, int]], budget: int
) -> tuple[Literal["move", "dead_end", "solved", "unknown"], tuple[int, int] | None]: ...
def bb_new_run(script_json: str) -> str: ...
def bb_validate_script(script_json: str) -> None: ...
def bb_public_state(state_json: str) -> str: ...
def bb_play_turn(state_json: str, aim: int) -> TurnResult: ...
def bb_best_aim(state_json: str, candidates: int) -> int | None: ...
