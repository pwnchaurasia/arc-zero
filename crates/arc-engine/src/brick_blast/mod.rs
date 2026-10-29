//! Brick Blast: aim once, fire a stack of balls, break numbered blocks before
//! they reach the ground.
//!
//! The board is a fixed logical grid (see the Brick Blast design doc §2), so
//! screen size never changes the game. All physics is fixed-point integer
//! maths with a fixed timestep, so the browser and the server always agree.

pub mod bot;
mod geom;
mod sim;
mod trig_table;

use std::fmt;

use serde::{Deserialize, Serialize};

use crate::hash::Fnv64;
pub use sim::{aim_path, play_turn, Ball, Event, Turn, TurnError, TurnSummary};

pub const COLS: usize = 9;
/// Rows that may hold blocks: 0 (top) ..= 10.
pub const PLAY_ROWS: usize = 11;
/// Grid rows including the ground row; a block shifted into it ends the game.
pub const ROWS: usize = PLAY_ROWS + 1;
pub const GROUND_ROW: usize = ROWS - 1;

/// Fixed-point units per grid cell.
pub const CELL: i32 = 1 << 14;
pub const BOARD_W: i32 = COLS as i32 * CELL;
pub const FLOOR_Y: i32 = ROWS as i32 * CELL;
pub const BALL_R: i32 = CELL * 3 / 25;
/// Gap between a block's edge and its cell edge.
pub const BLOCK_INSET: i32 = CELL / 25;
/// Touch radius of a power-up, centred in its cell.
pub const POWER_R: i32 = CELL * 3 / 10;

pub const TICKS_PER_SECOND: u32 = 120;
pub const SUBSTEPS: u32 = 2;
/// Ball speed in units per substep.
pub const SPEED: i32 = 768;
/// Minimum |vy| after any bounce (≈ SPEED·sin 8°), so balls cannot skim sideways forever.
pub const MIN_VY: i32 = 106;
pub const LAUNCH_INTERVAL: u32 = 4;
pub const MAX_TICKS_PER_TURN: u32 = 20 * TICKS_PER_SECOND;
pub const CLONE_LIFETIME: u32 = 5 * TICKS_PER_SECOND;

/// Aim in tenths of a degree, measured counter-clockwise from the +x axis.
pub const AIM_MIN: u16 = 80;
pub const AIM_MAX: u16 = 1720;

pub const MAX_HP: u16 = 150;
pub const MAX_BALLS: u16 = 500;
pub const MAX_ACTIVE_BALLS: usize = 2000;
pub const MAX_TURNS: u16 = 200;
pub const MAX_SCRIPT_ROWS: usize = 64;

/// Block outline. Triangles are named by the corner holding their right angle.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Shape {
    Square,
    TriBl,
    TriBr,
    TriTl,
    TriTr,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PowerKind {
    LaserH,
    LaserV,
    LaserX,
    BallUp3,
    BallUp5,
    PlusBalls2,
    PlusBalls3,
    PlusBalls5,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum Cell {
    Empty,
    Block { shape: Shape, hp: u16 },
    Power { kind: PowerKind },
}

pub type Row = [Cell; COLS];

pub const EMPTY_ROW: Row = [Cell::Empty; COLS];

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Playing,
    Won,
    Lost,
}

/// A level as authored by the generator. Server-only: never sent to clients.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LevelScript {
    pub start_balls: u16,
    /// Rows already on the board, top first (index 0 lands in grid row 0).
    pub start_rows: Vec<Row>,
    /// Rows that enter from the top, one per turn, in order.
    pub row_queue: Vec<Row>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct State {
    /// `ROWS` rows, row 0 at the top.
    pub grid: Vec<Row>,
    pub balls: u16,
    pub launch_x: i32,
    pub turn: u16,
    pub status: Status,
    pub rows_remaining: u16,
    /// Fewest free rows ever seen between the lowest block and the ground (for stars).
    pub closest: u8,
    /// Upcoming rows. Only the server holds these; clients receive one row per turn.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub queue: Vec<Row>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum StateError {
    GridShape,
    Hp(u16),
    Balls(u16),
    LaunchX(i32),
    Queue,
    TooManyRows(usize),
}

impl fmt::Display for StateError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::GridShape => write!(f, "grid must have {ROWS} rows"),
            Self::Hp(hp) => write!(f, "block hp {hp} outside 1..={MAX_HP}"),
            Self::Balls(n) => write!(f, "ball count {n} outside 1..={MAX_BALLS}"),
            Self::LaunchX(x) => write!(f, "launch x {x} outside the board"),
            Self::Queue => write!(f, "queue longer than rows_remaining"),
            Self::TooManyRows(n) => write!(f, "{n} rows exceeds {MAX_SCRIPT_ROWS}"),
        }
    }
}

impl std::error::Error for StateError {}

fn check_row(row: &Row) -> Result<(), StateError> {
    for cell in row {
        if let Cell::Block { hp, .. } = cell {
            if !(1..=MAX_HP).contains(hp) {
                return Err(StateError::Hp(*hp));
            }
        }
    }
    Ok(())
}

/// Free rows between the lowest block and the ground row.
fn free_rows(grid: &[Row]) -> u8 {
    let lowest = grid
        .iter()
        .take(PLAY_ROWS)
        .rposition(|row| row.iter().any(|c| matches!(c, Cell::Block { .. })));
    let free = lowest.map_or(PLAY_ROWS, |r| PLAY_ROWS - 1 - r);
    u8::try_from(free).expect("PLAY_ROWS fits u8")
}

impl LevelScript {
    pub fn validate(&self) -> Result<(), StateError> {
        if !(1..=MAX_BALLS).contains(&self.start_balls) {
            return Err(StateError::Balls(self.start_balls));
        }
        if self.start_rows.len() >= PLAY_ROWS {
            return Err(StateError::GridShape);
        }
        if self.row_queue.len() > MAX_SCRIPT_ROWS {
            return Err(StateError::TooManyRows(self.row_queue.len()));
        }
        self.start_rows
            .iter()
            .chain(&self.row_queue)
            .try_for_each(check_row)
    }

    /// Total HP of every block in the level.
    #[must_use]
    pub fn total_hp(&self) -> u32 {
        self.start_rows
            .iter()
            .chain(&self.row_queue)
            .flatten()
            .map(|c| match c {
                Cell::Block { hp, .. } => u32::from(*hp),
                _ => 0,
            })
            .sum()
    }
}

impl State {
    /// Starts a run of a level.
    pub fn new(script: &LevelScript) -> Result<Self, StateError> {
        script.validate()?;
        let mut grid = vec![EMPTY_ROW; ROWS];
        grid[..script.start_rows.len()].copy_from_slice(&script.start_rows);
        let rows_remaining = u16::try_from(script.row_queue.len())
            .map_err(|_| StateError::TooManyRows(usize::MAX))?;
        let closest = free_rows(&grid);
        Ok(Self {
            grid,
            balls: script.start_balls,
            launch_x: BOARD_W / 2,
            turn: 0,
            status: Status::Playing,
            rows_remaining,
            closest,
            queue: script.row_queue.clone(),
        })
    }

    pub fn validate(&self) -> Result<(), StateError> {
        if self.grid.len() != ROWS {
            return Err(StateError::GridShape);
        }
        if !(1..=MAX_BALLS).contains(&self.balls) {
            return Err(StateError::Balls(self.balls));
        }
        if !(BALL_R..=BOARD_W - BALL_R).contains(&self.launch_x) {
            return Err(StateError::LaunchX(self.launch_x));
        }
        if self.queue.len() > usize::from(self.rows_remaining)
            || usize::from(self.rows_remaining) > MAX_SCRIPT_ROWS
        {
            return Err(StateError::Queue);
        }
        self.grid.iter().chain(&self.queue).try_for_each(check_row)
    }

    /// The state a client may see: identical except upcoming rows are removed.
    #[must_use]
    pub fn public(&self) -> Self {
        Self {
            queue: Vec::new(),
            ..self.clone()
        }
    }

    #[must_use]
    pub fn block_count(&self) -> usize {
        self.grid
            .iter()
            .flatten()
            .filter(|c| matches!(c, Cell::Block { .. }))
            .count()
    }

    #[must_use]
    pub fn total_hp(&self) -> u32 {
        self.grid
            .iter()
            .flatten()
            .map(|c| match c {
                Cell::Block { hp, .. } => u32::from(*hp),
                _ => 0,
            })
            .sum()
    }

    /// Lowest grid row holding a block, if any.
    #[must_use]
    pub fn lowest_block_row(&self) -> Option<usize> {
        self.grid
            .iter()
            .rposition(|row| row.iter().any(|c| matches!(c, Cell::Block { .. })))
    }

    /// Stars for a won run, from the closest call during play.
    #[must_use]
    pub fn stars(&self) -> u8 {
        match (self.status, self.closest) {
            (Status::Won, c) if c >= 4 => 3,
            (Status::Won, c) if c >= 2 => 2,
            (Status::Won, _) => 1,
            _ => 0,
        }
    }

    /// Fingerprint of everything visible to the client (upcoming rows excluded).
    #[must_use]
    pub fn hash_hex(&self) -> String {
        let mut h = Fnv64::default();
        for cell in self.grid.iter().flatten() {
            match cell {
                Cell::Empty => h.write_u8(0),
                Cell::Block { shape, hp } => {
                    h.write_u8(1);
                    h.write_u8(*shape as u8);
                    h.write_u16(*hp);
                }
                Cell::Power { kind } => {
                    h.write_u8(2);
                    h.write_u8(*kind as u8);
                }
            }
        }
        h.write_u16(self.balls);
        h.write_i32(self.launch_x);
        h.write_u16(self.turn);
        h.write_u8(self.status as u8);
        h.write_u16(self.rows_remaining);
        h.write_u8(self.closest);
        h.hex()
    }
}

pub(crate) fn cell_index(row: usize, col: usize) -> u8 {
    u8::try_from(row * COLS + col).expect("grid fits u8")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn block(hp: u16) -> Cell {
        Cell::Block {
            shape: Shape::Square,
            hp,
        }
    }

    fn script() -> LevelScript {
        let mut row = EMPTY_ROW;
        row[4] = block(3);
        LevelScript {
            start_balls: 5,
            start_rows: vec![row],
            row_queue: vec![row, EMPTY_ROW],
        }
    }

    #[test]
    fn new_run_places_rows_and_hides_queue_in_public() {
        let s = State::new(&script()).unwrap();
        assert_eq!(s.grid.len(), ROWS);
        assert_eq!(s.rows_remaining, 2);
        assert_eq!(s.public().queue.len(), 0);
        assert_eq!(s.hash_hex(), s.public().hash_hex());
        assert_eq!(s.closest, 10);
    }

    #[test]
    fn invalid_scripts_are_rejected() {
        let mut bad = script();
        bad.start_rows[0][0] = block(0);
        assert_eq!(State::new(&bad), Err(StateError::Hp(0)));
        let mut bad = script();
        bad.start_balls = 0;
        assert_eq!(State::new(&bad), Err(StateError::Balls(0)));
    }

    #[test]
    fn min_vy_matches_trig_table() {
        let derived = i64::from(SPEED) * i64::from(trig_table::SIN[usize::from(AIM_MIN)])
            / trig_table::TRIG_SCALE;
        assert_eq!(i64::from(MIN_VY), derived);
    }

    #[test]
    fn json_round_trip() {
        let s = State::new(&script()).unwrap();
        let json = serde_json::to_string(&s).unwrap();
        let back: State = serde_json::from_str(&json).unwrap();
        assert_eq!(s, back);
    }
}
