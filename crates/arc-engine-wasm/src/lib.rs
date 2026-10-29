//! Browser bindings. The client uses these to animate and pre-check moves;
//! the server re-runs every move with the same engine and has the final say.
//!
//! Hot paths return flat `Int32Array`s instead of JSON to avoid per-frame allocation churn.

use arc_engine::brick_blast::{self as bb, Cell, Event};
use arc_engine::water_sort as ws;
use sha2::{Digest, Sha256};
use wasm_bindgen::prelude::*;

fn js_err(e: impl std::fmt::Display) -> JsError {
    JsError::new(&e.to_string())
}

// ---------------------------------------------------------------- Water Sort

#[wasm_bindgen]
pub struct WaterSort {
    board: ws::Board,
}

#[wasm_bindgen]
impl WaterSort {
    #[wasm_bindgen(constructor)]
    pub fn new(board_json: &str) -> Result<WaterSort, JsError> {
        let board: ws::Board = serde_json::from_str(board_json).map_err(js_err)?;
        board.validate().map_err(js_err)?;
        Ok(Self { board })
    }

    /// Units a pour would move, or -1 if illegal.
    #[wasm_bindgen(js_name = canPour)]
    #[must_use]
    pub fn can_pour(&self, from: u8, to: u8) -> i32 {
        self.board
            .can_pour(from, to)
            .map_or(-1, |n| i32::try_from(n).unwrap_or(-1))
    }

    pub fn pour(&mut self, from: u8, to: u8) -> Result<u32, JsError> {
        let n = self.board.pour(from, to).map_err(js_err)?;
        Ok(u32::try_from(n).unwrap_or(0))
    }

    #[wasm_bindgen(js_name = isSolved)]
    #[must_use]
    pub fn is_solved(&self) -> bool {
        self.board.is_solved()
    }

    /// False when no legal pour exists at all (the player must undo or restart).
    #[wasm_bindgen(js_name = hasMoves)]
    #[must_use]
    pub fn has_moves(&self) -> bool {
        let n = u8::try_from(self.board.bottles.len()).unwrap_or(0);
        (0..n).any(|f| (0..n).any(|t| self.board.can_pour(f, t).is_ok()))
    }

    #[wasm_bindgen(js_name = toJson)]
    #[must_use]
    pub fn to_json(&self) -> String {
        serde_json::to_string(&self.board).unwrap_or_default()
    }
}

// --------------------------------------------------------------- Brick Blast

fn encode_cell(cell: &Cell, out: &mut Vec<i32>) {
    match *cell {
        Cell::Empty => out.extend([0, 0, 0]),
        Cell::Block { shape, hp } => out.extend([1, shape as i32, i32::from(hp)]),
        Cell::Power { kind } => out.extend([2, kind as i32, 0]),
    }
}

fn encode_grid(grid: &[bb::Row]) -> Vec<i32> {
    let mut out = Vec::with_capacity(bb::ROWS * bb::COLS * 3);
    for cell in grid.iter().flatten() {
        encode_cell(cell, &mut out);
    }
    out
}

fn parse_state(json: &str) -> Result<bb::State, JsError> {
    let state: bb::State = serde_json::from_str(json).map_err(js_err)?;
    state.validate().map_err(js_err)?;
    Ok(state)
}

/// A turn being animated in the browser.
#[wasm_bindgen]
pub struct BrickTurn {
    turn: bb::Turn,
}

#[wasm_bindgen]
impl BrickTurn {
    #[wasm_bindgen(constructor)]
    pub fn new(state_json: &str, aim: u16) -> Result<BrickTurn, JsError> {
        let state = parse_state(state_json)?;
        let turn = bb::Turn::new(&state, aim).map_err(js_err)?;
        Ok(Self { turn })
    }

    /// Advances one tick; returns true when the turn is over.
    pub fn step(&mut self) -> bool {
        self.turn.step()
    }

    #[must_use]
    pub fn tick(&self) -> u32 {
        self.turn.tick()
    }

    #[wasm_bindgen(js_name = isDone)]
    #[must_use]
    pub fn is_done(&self) -> bool {
        self.turn.is_done()
    }

    /// Balls not yet launched.
    #[must_use]
    pub fn waiting(&self) -> u16 {
        self.turn.waiting()
    }

    /// Flat `[id, x, y, isClone]` per live ball.
    #[must_use]
    pub fn balls(&self) -> Vec<i32> {
        let balls = self.turn.balls();
        let mut out = Vec::with_capacity(balls.len() * 4);
        for b in balls {
            out.extend([
                i32::try_from(b.id).unwrap_or(i32::MAX),
                b.x,
                b.y,
                i32::from(b.is_clone()),
            ]);
        }
        out
    }

    /// Flat `[tag, kind, hp]` per cell, row-major. tag: 0 empty, 1 block, 2 power-up.
    #[must_use]
    pub fn cells(&self) -> Vec<i32> {
        encode_grid(self.turn.grid())
    }

    /// Flat `[kind, a, b]` per event since the last call.
    /// kind: 0 hit(cell, hp) 1 blast(cell) 2 laser(cell, power) 3 split(cell)
    /// 4 collect(cell, amount) 5 land(x)
    #[wasm_bindgen(js_name = takeEvents)]
    pub fn take_events(&mut self) -> Vec<i32> {
        let mut out = Vec::new();
        for e in self.turn.take_events() {
            out.extend(match e {
                Event::Hit { cell, hp } => [0, i32::from(cell), i32::from(hp)],
                Event::Blast { cell } => [1, i32::from(cell), 0],
                Event::Laser { cell, kind } => [2, i32::from(cell), kind as i32],
                Event::Split { cell } => [3, i32::from(cell), 0],
                Event::Collect { cell, amount } => [4, i32::from(cell), i32::from(amount)],
                Event::Land { x } => [5, x, 0],
            });
        }
        out
    }

    /// Adds the row the server says entered this turn (JSON array of 9 cells).
    #[wasm_bindgen(js_name = provideRow)]
    pub fn provide_row(&mut self, row_json: &str) -> Result<(), JsError> {
        let row: bb::Row = serde_json::from_str(row_json).map_err(js_err)?;
        self.turn.provide_row(row);
        Ok(())
    }

    /// Finishes the turn and returns `{"state": State, "hash": string}` as JSON.
    pub fn finish(self) -> Result<String, JsError> {
        let (state, _) = self.turn.finish().map_err(js_err)?;
        let hash = state.hash_hex();
        serde_json::to_string(&serde_json::json!({ "state": state, "hash": hash })).map_err(js_err)
    }
}

/// Flat `[x0, y0, x1, y1, ...]`: launch point then bounce points for the aim guide.
#[wasm_bindgen(js_name = bbAimPath)]
pub fn bb_aim_path(state_json: &str, aim: u16, bounces: usize) -> Result<Vec<i32>, JsError> {
    let state = parse_state(state_json)?;
    Ok(bb::aim_path(&state, aim, bounces)
        .into_iter()
        .flat_map(|(x, y)| [x, y])
        .collect())
}

/// Flat `[tag, kind, hp]` per cell for a state (used when no turn is running).
#[wasm_bindgen(js_name = bbCells)]
pub fn bb_cells(state_json: &str) -> Result<Vec<i32>, JsError> {
    Ok(encode_grid(&parse_state(state_json)?.grid))
}

#[wasm_bindgen(js_name = bbStateHash)]
pub fn bb_state_hash(state_json: &str) -> Result<String, JsError> {
    Ok(parse_state(state_json)?.hash_hex())
}

/// Board geometry and timing constants, so the renderer never hard-codes them.
#[wasm_bindgen(js_name = bbConstants)]
#[must_use]
pub fn bb_constants() -> String {
    serde_json::json!({
        "cols": bb::COLS,
        "rows": bb::ROWS,
        "playRows": bb::PLAY_ROWS,
        "cell": bb::CELL,
        "boardW": bb::BOARD_W,
        "floorY": bb::FLOOR_Y,
        "ballR": bb::BALL_R,
        "blockInset": bb::BLOCK_INSET,
        "powerR": bb::POWER_R,
        "ticksPerSecond": bb::TICKS_PER_SECOND,
        "aimMin": bb::AIM_MIN,
        "aimMax": bb::AIM_MAX,
        "maxHp": bb::MAX_HP,
    })
    .to_string()
}

// ------------------------------------------------------------ Proof of work

fn leading_zero_bits(digest: &[u8]) -> u32 {
    let mut bits = 0;
    for byte in digest {
        if *byte == 0 {
            bits += 8;
        } else {
            return bits + byte.leading_zeros();
        }
    }
    bits
}

/// Searches nonces `start..start+count` for `sha256("{challenge}:{nonce}")`
/// with at least `difficulty` leading zero bits. Returns the nonce or -1.
///
/// Called in chunks from a Web Worker so the UI stays responsive.
#[wasm_bindgen(js_name = powSolve)]
#[must_use]
pub fn pow_solve(challenge: &str, difficulty: u32, start: u32, count: u32) -> f64 {
    let prefix = format!("{challenge}:");
    for nonce in start..start.saturating_add(count) {
        let mut hasher = Sha256::new();
        hasher.update(prefix.as_bytes());
        hasher.update(nonce.to_string().as_bytes());
        if leading_zero_bits(&hasher.finalize()) >= difficulty {
            return f64::from(nonce);
        }
    }
    -1.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pow_finds_valid_nonce() {
        let nonce = pow_solve("abc", 8, 0, 100_000);
        assert!(nonce >= 0.0);
        let digest = Sha256::digest(format!("abc:{nonce}").as_bytes());
        assert!(leading_zero_bits(&digest) >= 8);
    }

    #[test]
    fn leading_zeros_counts_bits() {
        assert_eq!(leading_zero_bits(&[0, 0b0001_0000]), 11);
        assert_eq!(leading_zero_bits(&[0xff]), 0);
    }
}
