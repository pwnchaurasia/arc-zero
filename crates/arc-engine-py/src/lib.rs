//! Python bindings used by the API server to verify every move.
//!
//! CPU-heavy calls release the GIL so FastAPI can run them in a thread pool.

use engine::brick_blast::{self as bb, bot};
use engine::water_sort as ws;
use pyo3::create_exception;
use pyo3::exceptions::PyValueError;
use pyo3::prelude::*;

create_exception!(
    arc_engine,
    EngineError,
    PyValueError,
    "Raised when input is invalid or a move is illegal."
);

fn err(e: impl std::fmt::Display) -> PyErr {
    EngineError::new_err(e.to_string())
}

// ---------------------------------------------------------------- Water Sort

/// Builds the board for a level seed (colours are 0-based ids).
#[pyfunction]
fn ws_generate(seed: u64, colors: u8, empty: u8) -> PyResult<Vec<Vec<u16>>> {
    let total = usize::from(colors) + usize::from(empty);
    if !(2..=ws::MAX_COLORS).contains(&usize::from(colors)) || total > ws::MAX_BOTTLES {
        return Err(err(format!(
            "unsupported board: {colors} colours + {empty} empty"
        )));
    }
    // Widen so Python receives lists of ints (a Vec<u8> would become `bytes`).
    Ok(ws::Board::generate(seed, colors, empty)
        .bottles
        .into_iter()
        .map(|b| b.into_iter().map(u16::from).collect())
        .collect())
}

/// Replays moves from `board`. Returns whether the result is solved.
/// Raises `EngineError` on the first illegal move.
#[pyfunction]
fn ws_replay(py: Python<'_>, board: Vec<Vec<u8>>, moves: Vec<(u8, u8)>) -> PyResult<bool> {
    py.allow_threads(|| {
        ws::replay(&ws::Board { bottles: board }, &moves)
            .map(|b| b.is_solved())
            .map_err(|e| e.to_string())
    })
    .map_err(err)
}

/// Next move from the player's current position.
/// Returns `("move", (from, to))`, `("dead_end", None)`, `("solved", None)` or `("unknown", None)`.
#[pyfunction]
fn ws_hint(
    py: Python<'_>,
    board: Vec<Vec<u8>>,
    moves: Vec<(u8, u8)>,
    budget: usize,
) -> PyResult<(&'static str, Option<(u8, u8)>)> {
    let outcome = py
        .allow_threads(|| ws::hint(&ws::Board { bottles: board }, &moves, budget))
        .map_err(err)?;
    Ok(match outcome {
        ws::HintOutcome::Move(m) => ("move", Some(m)),
        ws::HintOutcome::DeadEnd => ("dead_end", None),
        ws::HintOutcome::Solved => ("solved", None),
        ws::HintOutcome::Unknown => ("unknown", None),
    })
}

// --------------------------------------------------------------- Brick Blast

fn parse_state(json: &str) -> Result<bb::State, String> {
    let state: bb::State = serde_json::from_str(json).map_err(|e| e.to_string())?;
    state.validate().map_err(|e| e.to_string())?;
    Ok(state)
}

fn to_json(v: &impl serde::Serialize) -> Result<String, String> {
    serde_json::to_string(v).map_err(|e| e.to_string())
}

/// Result of a server-simulated turn.
#[pyclass(frozen, get_all, module = "arc_engine")]
struct TurnResult {
    /// Full state including upcoming rows. Keep server-side only.
    state: String,
    /// What the client may see.
    public_state: String,
    hash: String,
    status: String,
    stars: u8,
    turn: u16,
    /// JSON of the row that entered this turn, if any.
    new_row: Option<String>,
    ticks: u32,
}

/// Starts a run from a level script. Returns the full state JSON.
#[pyfunction]
fn bb_new_run(script_json: &str) -> PyResult<String> {
    let script: bb::LevelScript = serde_json::from_str(script_json).map_err(err)?;
    let state = bb::State::new(&script).map_err(err)?;
    to_json(&state).map_err(err)
}

/// Validates a level script without starting a run.
#[pyfunction]
fn bb_validate_script(script_json: &str) -> PyResult<()> {
    let script: bb::LevelScript = serde_json::from_str(script_json).map_err(err)?;
    script.validate().map_err(err)
}

/// Client-visible state JSON (upcoming rows removed) for a full state.
#[pyfunction]
fn bb_public_state(state_json: &str) -> PyResult<String> {
    let state = parse_state(state_json).map_err(err)?;
    to_json(&state.public()).map_err(err)
}

/// Simulates one full turn on the server.
#[pyfunction]
fn bb_play_turn(py: Python<'_>, state_json: String, aim: u16) -> PyResult<TurnResult> {
    py.allow_threads(move || {
        let state = parse_state(&state_json)?;
        let (next, summary) = bb::play_turn(&state, aim).map_err(|e| e.to_string())?;
        Ok(TurnResult {
            state: to_json(&next)?,
            public_state: to_json(&next.public())?,
            hash: next.hash_hex(),
            status: to_json(&next.status)?.trim_matches('"').to_owned(),
            stars: next.stars(),
            turn: next.turn,
            new_row: summary.new_row.as_ref().map(to_json).transpose()?,
            ticks: summary.ticks,
        })
    })
    .map_err(|e: String| err(e))
}

/// Best aim by one-turn lookahead over `candidates` evenly spaced aims (for hints).
#[pyfunction]
fn bb_best_aim(py: Python<'_>, state_json: String, candidates: u16) -> PyResult<Option<u16>> {
    py.allow_threads(move || {
        let state = parse_state(&state_json)?;
        Ok(bot::best_aim(&state, candidates).map(|(aim, _)| aim))
    })
    .map_err(|e: String| err(e))
}

#[pymodule]
fn arc_engine(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add("EngineError", m.py().get_type::<EngineError>())?;
    m.add("WS_MAX_MOVES", ws::MAX_MOVES)?;
    m.add("BB_AIM_MIN", bb::AIM_MIN)?;
    m.add("BB_AIM_MAX", bb::AIM_MAX)?;
    m.add("BB_TICKS_PER_SECOND", bb::TICKS_PER_SECOND)?;
    m.add_class::<TurnResult>()?;
    m.add_function(wrap_pyfunction!(ws_generate, m)?)?;
    m.add_function(wrap_pyfunction!(ws_replay, m)?)?;
    m.add_function(wrap_pyfunction!(ws_hint, m)?)?;
    m.add_function(wrap_pyfunction!(bb_new_run, m)?)?;
    m.add_function(wrap_pyfunction!(bb_validate_script, m)?)?;
    m.add_function(wrap_pyfunction!(bb_public_state, m)?)?;
    m.add_function(wrap_pyfunction!(bb_play_turn, m)?)?;
    m.add_function(wrap_pyfunction!(bb_best_aim, m)?)?;
    Ok(())
}
