//! Python bindings used by the API server to verify every move.
//!
//! CPU-heavy calls release the GIL so FastAPI can run them in a thread pool.

use engine::brick_blast::{self as bb, bot};
use engine::dead_bridge as db;
use engine::gridsnap as gs;
use engine::metro_jam as mj;
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

// Widen so Python receives lists of ints (a Vec<u8> would become `bytes`).
fn widen(bottles: Vec<Vec<u8>>) -> Vec<Vec<u16>> {
    bottles
        .into_iter()
        .map(|b| b.into_iter().map(u16::from).collect())
        .collect()
}

/// Builds the board for a level seed (colours are 0-based ids).
#[pyfunction]
fn ws_generate(seed: u64, colors: u8, empty: u8, capacity: u8) -> PyResult<Vec<Vec<u16>>> {
    let total = usize::from(colors) + usize::from(empty);
    if !(2..=ws::MAX_COLORS).contains(&usize::from(colors))
        || total > ws::MAX_BOTTLES
        || !(ws::MIN_CAPACITY..=ws::MAX_CAPACITY).contains(&usize::from(capacity))
    {
        return Err(err(format!(
            "unsupported board: {colors} colours + {empty} empty, capacity {capacity}"
        )));
    }
    Ok(widen(
        ws::Board::generate(seed, colors, empty, capacity).bottles,
    ))
}

/// Replays moves from `board`. Returns whether the result is solved.
/// Raises `EngineError` on the first illegal move.
#[pyfunction]
fn ws_replay(
    py: Python<'_>,
    board: Vec<Vec<u8>>,
    capacity: u8,
    moves: Vec<(u8, u8)>,
) -> PyResult<bool> {
    py.allow_threads(|| {
        ws::replay(&ws::Board::new(capacity, board), &moves)
            .map(|b| b.is_solved())
            .map_err(|e| e.to_string())
    })
    .map_err(err)
}

/// What the player may see after `moves`: the masked board (hidden layers are 255)
/// and the layers seen so far, as hex (pass it back next time so undo never re-hides).
/// For levels without hidden colours, everything is visible.
#[pyfunction]
fn ws_view(
    board: Vec<Vec<u8>>,
    capacity: u8,
    moves: Vec<(u8, u8)>,
    hidden: bool,
    seen_hex: &str,
) -> PyResult<(Vec<Vec<u16>>, String)> {
    let start = ws::Board::new(capacity, board);
    if !hidden {
        let full = ws::replay(&start, &moves).map_err(err)?;
        return Ok((widen(full.bottles), String::new()));
    }
    let seen = if seen_hex.is_empty() {
        0
    } else {
        u128::from_str_radix(seen_hex, 16).map_err(err)?
    };
    let (full, seen) = ws::replay_revealing(&start, &moves, Some(seen)).map_err(err)?;
    Ok((widen(full.masked(seen).bottles), format!("{seen:x}")))
}

/// Number of extra bottles a move list adds (each must have been paid for).
#[pyfunction]
fn ws_bottles_added(moves: Vec<(u8, u8)>) -> usize {
    ws::bottles_added(&moves)
}

/// Next move from the player's current position.
/// Returns `("move", (from, to))`, `("dead_end", None)`, `("solved", None)` or `("unknown", None)`.
#[pyfunction]
fn ws_hint(
    py: Python<'_>,
    board: Vec<Vec<u8>>,
    capacity: u8,
    moves: Vec<(u8, u8)>,
    budget: usize,
) -> PyResult<(&'static str, Option<(u8, u8)>)> {
    let outcome = py
        .allow_threads(|| ws::hint(&ws::Board::new(capacity, board), &moves, budget))
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

/// Applies a paid assist between shots: "bonus_balls", "laser" (with `col`) or "hammer".
/// Returns the new full state, its public view, hash and status.
#[pyfunction]
fn bb_apply_assist(state_json: &str, assist: &str, col: u8) -> PyResult<TurnResult> {
    let mut state = parse_state(state_json).map_err(err)?;
    let assist: bb::Assist =
        serde_json::from_value(serde_json::Value::String(assist.to_owned())).map_err(err)?;
    state.apply_assist(assist, col).map_err(err)?;
    let status = to_json(&state.status)
        .map_err(err)?
        .trim_matches('"')
        .to_owned();
    Ok(TurnResult {
        public_state: to_json(&state.public()).map_err(err)?,
        hash: state.hash_hex(),
        stars: state.stars(),
        turn: state.turn,
        state: to_json(&state).map_err(err)?,
        status,
        new_row: None,
        ticks: 0,
    })
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

// ----------------------------------------------------------------- MetroJam

fn parse_level(json: &str) -> Result<mj::Level, String> {
    let level: mj::Level = serde_json::from_str(json).map_err(|e| e.to_string())?;
    level.validate(true).map_err(|e| e.to_string())?;
    Ok(level)
}

/// Validates a full server-side level.
#[pyfunction]
fn mj_validate(level_json: &str) -> PyResult<()> {
    parse_level(level_json).map(|_| ()).map_err(err)
}

/// The level JSON a client may see at the start (far end of the queue cut off).
#[pyfunction]
fn mj_public(level_json: &str) -> PyResult<String> {
    to_json(&parse_level(level_json).map_err(err)?.public()).map_err(err)
}

/// Result of replaying a MetroJam move list on the full level.
#[pyclass(frozen, get_all, module = "arc_engine")]
struct MjReplay {
    won: bool,
    stuck: bool,
    boarded: usize,
    /// `[airlifts, shuffles, extra bays]` used by the move list.
    assists: [u16; 3],
    /// The original queue up to what the player may now see.
    revealed: Vec<u16>,
}

/// Replays `moves`. Raises `EngineError` on the first illegal move.
#[pyfunction]
fn mj_replay(py: Python<'_>, level_json: String, moves: Vec<(u8, u8)>) -> PyResult<MjReplay> {
    py.allow_threads(move || {
        let level = parse_level(&level_json)?;
        let game = mj::replay(&level, &moves).map_err(|e| e.to_string())?;
        let end = (game.boarded() + usize::from(level.visible)).min(level.queue.len());
        Ok(MjReplay {
            won: game.is_won(),
            stuck: game.is_stuck(),
            boarded: game.boarded(),
            assists: mj::assists_used(&moves),
            revealed: level.queue[..end].iter().map(|c| u16::from(*c)).collect(),
        })
    })
    .map_err(|e: String| err(e))
}

// ------------------------------------------------------- Dead Bridge Assault

/// Validates a level script.
#[pyfunction]
fn db_validate(script_json: &str) -> PyResult<()> {
    let script: db::Script = serde_json::from_str(script_json).map_err(err)?;
    script.validate().map_err(err)
}

/// Result of replaying a level from the player's inputs.
#[pyclass(frozen, get_all, module = "arc_engine")]
struct DbReplay {
    /// "won" or "lost".
    status: &'static str,
    stars: u8,
    base_hp: i32,
    ticks: u32,
    kills: u32,
    /// Assist charges bought with coins, per kind (must have been paid for).
    bought: [u8; 7],
}

/// Replays a whole level from its input log. Raises `EngineError` on a bad log or input.
#[pyfunction]
fn db_replay(py: Python<'_>, script_json: String, log: Vec<u8>) -> PyResult<DbReplay> {
    py.allow_threads(move || {
        let script: db::Script = serde_json::from_str(&script_json).map_err(|e| e.to_string())?;
        let sim = db::replay(&script, &db::InputLog(log)).map_err(|e| e.to_string())?;
        Ok(DbReplay {
            status: if sim.status() == db::Status::Won {
                "won"
            } else {
                "lost"
            },
            stars: sim.stars(),
            base_hp: sim.base_hp(),
            ticks: sim.tick(),
            kills: sim.kills(),
            bought: sim.bought(),
        })
    })
    .map_err(|e: String| err(e))
}

// ------------------------------------------------------------------ GridSnap

/// The board after a GridSnap action, plus what the action did.
#[pyclass(frozen, get_all, module = "arc_engine")]
struct GsStep {
    /// Full game including the deal's seed. Keep server-side only.
    state: String,
    /// What the player may see.
    view: String,
    /// "playing", "stuck" or "ended".
    status: String,
    score: u32,
    lines: u32,
    placed: u32,
    /// Points the placement scored (0 for assists).
    points: u32,
}

fn gs_parse(state_json: &str) -> Result<gs::Game, String> {
    let game: gs::Game = serde_json::from_str(state_json).map_err(|e| e.to_string())?;
    game.validate().map_err(|e| e.to_string())?;
    Ok(game)
}

fn gs_step(game: &gs::Game, points: u32) -> Result<GsStep, String> {
    Ok(GsStep {
        state: to_json(game)?,
        view: to_json(&game.board)?,
        status: to_json(&game.board.status)?.trim_matches('"').to_owned(),
        score: game.board.score,
        lines: game.board.lines,
        placed: game.board.placed,
        points,
    })
}

/// Starts a run: deals the first tray from `seed`.
#[pyfunction]
fn gs_new(seed: u64) -> PyResult<GsStep> {
    gs_step(&gs::Game::new(seed), 0).map_err(err)
}

/// Places the piece in `slot` with its top-left at `(row, col)`; deals when the tray empties.
#[pyfunction]
fn gs_place(state_json: &str, slot: usize, row: u8, col: u8) -> PyResult<GsStep> {
    let mut game = gs_parse(state_json).map_err(err)?;
    let placed = game.place(slot, row, col).map_err(err)?;
    gs_step(&game, placed.points).map_err(err)
}

/// Applies a paid assist: "reshuffle", or "bomb" at `(row, col)`.
#[pyfunction]
fn gs_assist(state_json: &str, kind: &str, row: u8, col: u8) -> PyResult<GsStep> {
    let mut game = gs_parse(state_json).map_err(err)?;
    let assist = match kind {
        "reshuffle" => gs::Assist::Reshuffle,
        "bomb" => gs::Assist::Bomb { row, col },
        _ => return Err(err(format!("unknown assist {kind}"))),
    };
    game.assist(assist).map_err(err)?;
    gs_step(&game, 0).map_err(err)
}

/// Ends the run.
#[pyfunction]
fn gs_end(state_json: &str) -> PyResult<GsStep> {
    let mut game = gs_parse(state_json).map_err(err)?;
    game.end();
    gs_step(&game, 0).map_err(err)
}

#[pymodule]
fn arc_engine(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add("EngineError", m.py().get_type::<EngineError>())?;
    m.add("WS_MAX_MOVES", ws::MAX_MOVES)?;
    m.add("BB_AIM_MIN", bb::AIM_MIN)?;
    m.add("BB_AIM_MAX", bb::AIM_MAX)?;
    m.add("BB_TICKS_PER_SECOND", bb::TICKS_PER_SECOND)?;
    m.add("MJ_MAX_MOVES", mj::MAX_MOVES)?;
    m.add_class::<TurnResult>()?;
    m.add_class::<MjReplay>()?;
    m.add_class::<DbReplay>()?;
    m.add_class::<GsStep>()?;
    m.add_function(wrap_pyfunction!(gs_new, m)?)?;
    m.add_function(wrap_pyfunction!(gs_place, m)?)?;
    m.add_function(wrap_pyfunction!(gs_assist, m)?)?;
    m.add_function(wrap_pyfunction!(gs_end, m)?)?;
    m.add("GS_MAX_RESHUFFLES", gs::MAX_RESHUFFLES)?;
    m.add("GS_MAX_BOMBS", gs::MAX_BOMBS)?;
    // Each shape's rows, bit `c` = column `c` (tests use it to find free spots).
    let shapes: Vec<Vec<u16>> = gs::SHAPES
        .iter()
        .map(|s| s.rows.iter().map(|r| u16::from(*r)).collect())
        .collect();
    m.add("GS_SHAPES", shapes)?;
    m.add_function(wrap_pyfunction!(db_validate, m)?)?;
    m.add_function(wrap_pyfunction!(db_replay, m)?)?;
    m.add("DB_TPS", db::TPS)?;
    m.add("DB_MAX_LOG_BYTES", db::MAX_LOG_BYTES)?;
    m.add_function(wrap_pyfunction!(mj_validate, m)?)?;
    m.add_function(wrap_pyfunction!(mj_public, m)?)?;
    m.add_function(wrap_pyfunction!(mj_replay, m)?)?;
    m.add_function(wrap_pyfunction!(ws_generate, m)?)?;
    m.add_function(wrap_pyfunction!(ws_replay, m)?)?;
    m.add_function(wrap_pyfunction!(ws_hint, m)?)?;
    m.add_function(wrap_pyfunction!(ws_view, m)?)?;
    m.add_function(wrap_pyfunction!(ws_bottles_added, m)?)?;
    m.add("WS_ADD_BOTTLE", ws::ADD_BOTTLE)?;
    m.add("WS_MAX_EXTRA_BOTTLES", ws::MAX_EXTRA_BOTTLES)?;
    m.add_function(wrap_pyfunction!(bb_new_run, m)?)?;
    m.add_function(wrap_pyfunction!(bb_validate_script, m)?)?;
    m.add_function(wrap_pyfunction!(bb_public_state, m)?)?;
    m.add_function(wrap_pyfunction!(bb_play_turn, m)?)?;
    m.add_function(wrap_pyfunction!(bb_best_aim, m)?)?;
    m.add_function(wrap_pyfunction!(bb_apply_assist, m)?)?;
    Ok(())
}
