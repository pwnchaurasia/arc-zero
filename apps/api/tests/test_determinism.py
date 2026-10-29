"""The Python extension must agree with native Rust and WASM on every golden vector."""

from __future__ import annotations

import json
from pathlib import Path

import arc_engine

GOLDEN = Path(__file__).resolve().parents[3] / "crates/arc-engine/tests/golden/brick_blast.json"


def test_python_engine_matches_golden_vectors() -> None:
    vectors = json.loads(GOLDEN.read_text())
    assert vectors
    for i, v in enumerate(vectors):
        result = arc_engine.bb_play_turn(json.dumps(v["state"]), v["aim"])
        assert result.hash == v["hash"], f"vector {i} diverged"
