//! GridSnap: drag block shapes onto an 8 × 8 board; full rows and columns clear.
//!
//! Rules (see the GridSnap design doc):
//! - The tray holds 3 shapes, placed in any order. A new tray is dealt only
//!   when all 3 are placed. Shapes never rotate.
//! - Placing scores 1 per cell. Lines cleared at once score 100 / 300 / 600 /
//!   1,000 / 1,500 / 2,100. A combo stays alive while a clear comes within
//!   [`COMBO_WINDOW`] placements of the previous one; each clear after the
//!   first in a combo adds 150 × its place in the chain (capped at
//!   [`MAX_COMBO_STEP`]).
//! - When no shape left in the tray fits anywhere, the run is stuck: the player
//!   can buy a reshuffle or a bomb, or end the run.
//!
//! The deal is the only randomness. It lives on the server ([`Game`] holds the
//! seed); the browser only ever sees a [`Board`], so it can't see future trays.
//! Each tray comes from its own generator, `seed` mixed with the deal number,
//! so a stored game needs no generator state.

pub mod bot;

use serde::{Deserialize, Serialize};

use crate::error::EngineError;
use crate::rng::Rng;

pub const SIZE: usize = 8;
pub const TRAY: usize = 3;
/// Colours a piece can have (cells store colour + 1; 0 is empty).
pub const COLORS: u8 = 7;
/// A combo survives this many placements without a clear.
pub const COMBO_WINDOW: u8 = 1;
pub const COMBO_BONUS: u32 = 150;
/// The combo bonus stops growing after this many steps.
pub const MAX_COMBO_STEP: u32 = 8;
/// Points for clearing 0..=6 lines in one placement.
pub const LINE_POINTS: [u32; 7] = [0, 100, 300, 600, 1_000, 1_500, 2_100];
/// Paid assists one run may use.
pub const MAX_RESHUFFLES: u8 = 3;
pub const MAX_BOMBS: u8 = 3;
/// A hard cap so a run's state stays bounded.
pub const MAX_PLACEMENTS: u32 = 50_000;
/// Score at which the deal reaches its hardest mix.
pub const HARD_SCORE: u32 = 8_000;
/// Chance (%) that a tray is checked to be placeable as a whole, at score 0
/// and at [`HARD_SCORE`] and above. Unchecked trays may end the run.
pub const HELP_START: u64 = 100;
pub const HELP_END: u64 = 55;

/// One shape: its rows top to bottom, bit `c` set when column `c` is filled.
pub struct ShapeDef {
    pub rows: &'static [u8],
    /// Deal weight at score 0 and at [`HARD_SCORE`].
    pub weight: (u32, u32),
    /// Small shapes and straight lines; the rest are "complex".
    pub simple: bool,
}

const fn s(rows: &'static [u8], easy: u32, hard: u32, simple: bool) -> ShapeDef {
    ShapeDef {
        rows,
        weight: (easy, hard),
        simple,
    }
}

pub const SHAPES: [ShapeDef; 37] = [
    // Dots, bars and the small square.
    s(&[0b1], 6, 2, true),
    s(&[0b11], 8, 4, true),
    s(&[1, 1], 8, 4, true),
    s(&[0b111], 8, 6, true),
    s(&[1, 1, 1], 8, 6, true),
    s(&[0b1111], 6, 7, true),
    s(&[1, 1, 1, 1], 6, 7, true),
    s(&[0b11111], 3, 7, true),
    s(&[1, 1, 1, 1, 1], 3, 7, true),
    s(&[0b11, 0b11], 8, 6, true),
    // Rectangles and the big square.
    s(&[0b111, 0b111], 3, 6, false),
    s(&[0b11, 0b11, 0b11], 3, 6, false),
    s(&[0b111, 0b111, 0b111], 2, 6, false),
    // Small corners.
    s(&[0b11, 0b01], 6, 4, false),
    s(&[0b11, 0b10], 6, 4, false),
    s(&[0b01, 0b11], 6, 4, false),
    s(&[0b10, 0b11], 6, 4, false),
    // Big corners.
    s(&[0b111, 0b001, 0b001], 2, 5, false),
    s(&[0b111, 0b100, 0b100], 2, 5, false),
    s(&[0b001, 0b001, 0b111], 2, 5, false),
    s(&[0b100, 0b100, 0b111], 2, 5, false),
    // L and J.
    s(&[0b01, 0b01, 0b11], 4, 4, false),
    s(&[0b111, 0b001], 4, 4, false),
    s(&[0b11, 0b10, 0b10], 4, 4, false),
    s(&[0b100, 0b111], 4, 4, false),
    s(&[0b10, 0b10, 0b11], 4, 4, false),
    s(&[0b111, 0b100], 4, 4, false),
    s(&[0b11, 0b01, 0b01], 4, 4, false),
    s(&[0b001, 0b111], 4, 4, false),
    // T.
    s(&[0b111, 0b010], 4, 5, false),
    s(&[0b010, 0b111], 4, 5, false),
    s(&[0b01, 0b11, 0b01], 4, 5, false),
    s(&[0b10, 0b11, 0b10], 4, 5, false),
    // S and Z.
    s(&[0b110, 0b011], 3, 5, false),
    s(&[0b01, 0b11, 0b10], 3, 5, false),
    s(&[0b011, 0b110], 3, 5, false),
    s(&[0b10, 0b11, 0b01], 3, 5, false),
];

/// Board mask of `shape` with its top-left corner at `(row, col)`, if it lies on the board.
#[must_use]
pub fn mask_at(shape: u8, row: u8, col: u8) -> Option<u64> {
    let def = SHAPES.get(usize::from(shape))?;
    let (row, col) = (usize::from(row), usize::from(col));
    if row + def.rows.len() > SIZE || col + width(shape) > SIZE {
        return None;
    }
    let mut mask = 0u64;
    for (r, bits) in def.rows.iter().enumerate() {
        mask |= u64::from(*bits) << ((row + r) * SIZE + col);
    }
    Some(mask)
}

#[must_use]
pub fn width(shape: u8) -> usize {
    SHAPES.get(usize::from(shape)).map_or(0, |d| {
        d.rows
            .iter()
            .map(|b| 8 - b.leading_zeros() as usize)
            .max()
            .unwrap_or(0)
    })
}

#[must_use]
pub fn height(shape: u8) -> usize {
    SHAPES.get(usize::from(shape)).map_or(0, |d| d.rows.len())
}

#[must_use]
pub fn cell_count(shape: u8) -> u32 {
    SHAPES
        .get(usize::from(shape))
        .map_or(0, |d| d.rows.iter().map(|b| b.count_ones()).sum())
}

const ROW: u64 = 0xFF;
const COL: u64 = 0x0101_0101_0101_0101;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Piece {
    pub shape: u8,
    pub color: u8,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Playing,
    /// No shape in the tray fits: an assist or ending the run are the only moves.
    Stuck,
    Ended,
}

/// What one placement did, for scoring and animation.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Placed {
    /// Bit `r` / `c` set for each cleared row / column.
    pub rows: u8,
    pub cols: u8,
    pub points: u32,
    /// Place in the combo chain (0 = this placement cleared nothing).
    pub combo: u16,
}

/// Everything the player may see. The browser applies placements to this
/// directly; the server applies them to a [`Game`] and deals new trays.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Board {
    /// 64 cells, row by row: 0 empty, else colour + 1.
    pub cells: Vec<u8>,
    pub tray: [Option<Piece>; TRAY],
    pub score: u32,
    pub lines: u32,
    pub placed: u32,
    /// Clears in the current combo chain.
    pub combo: u16,
    /// Placements since the last clear.
    pub since_clear: u8,
    pub status: Status,
    pub reshuffles: u8,
    pub bombs: u8,
}

impl Board {
    fn empty() -> Self {
        Self {
            cells: vec![0; SIZE * SIZE],
            tray: [None; TRAY],
            score: 0,
            lines: 0,
            placed: 0,
            combo: 0,
            since_clear: 0,
            status: Status::Playing,
            reshuffles: 0,
            bombs: 0,
        }
    }

    pub fn validate(&self) -> Result<(), EngineError> {
        let bad = |m: &str| Err(EngineError::InvalidInput(m.to_owned()));
        if self.cells.len() != SIZE * SIZE || self.cells.iter().any(|c| *c > COLORS) {
            return bad("cells");
        }
        if self
            .tray
            .iter()
            .flatten()
            .any(|p| usize::from(p.shape) >= SHAPES.len() || p.color >= COLORS)
        {
            return bad("tray");
        }
        Ok(())
    }

    #[must_use]
    pub fn occupied(&self) -> u64 {
        self.cells
            .iter()
            .enumerate()
            .filter(|(_, c)| **c != 0)
            .fold(0, |m, (i, _)| m | 1 << i)
    }

    /// Whether the piece in `slot` can go at `(row, col)`.
    #[must_use]
    pub fn can_place(&self, slot: usize, row: u8, col: u8) -> bool {
        self.status == Status::Playing
            && self
                .tray
                .get(slot)
                .copied()
                .flatten()
                .and_then(|p| mask_at(p.shape, row, col))
                .is_some_and(|m| m & self.occupied() == 0)
    }

    /// Whether `shape` fits anywhere on the board.
    #[must_use]
    pub fn fits(&self, shape: u8) -> bool {
        fits_on(self.occupied(), shape)
    }

    /// Rows and columns that placing `slot` at `(row, col)` would clear.
    #[must_use]
    pub fn would_clear(&self, slot: usize, row: u8, col: u8) -> (u8, u8) {
        if !self.can_place(slot, row, col) {
            return (0, 0);
        }
        let Some(p) = self.tray[slot] else {
            return (0, 0);
        };
        let filled = self.occupied() | mask_at(p.shape, row, col).unwrap_or(0);
        full_lines(filled)
    }

    /// Places the piece in `slot` with its top-left at `(row, col)`, clears
    /// full lines and scores. Does not deal: see [`Game::place`].
    pub fn place(&mut self, slot: usize, row: u8, col: u8) -> Result<Placed, EngineError> {
        if self.status != Status::Playing {
            return Err(EngineError::GameOver);
        }
        if self.placed >= MAX_PLACEMENTS {
            return Err(EngineError::LimitExceeded("placements".into()));
        }
        let piece = self
            .tray
            .get(slot)
            .copied()
            .flatten()
            .ok_or_else(|| EngineError::InvalidInput("empty tray slot".into()))?;
        let mask = mask_at(piece.shape, row, col)
            .ok_or_else(|| EngineError::IllegalMove("off the board".into()))?;
        if mask & self.occupied() != 0 {
            return Err(EngineError::IllegalMove("cells taken".into()));
        }
        for i in 0..SIZE * SIZE {
            if mask & (1 << i) != 0 {
                self.cells[i] = piece.color + 1;
            }
        }
        self.tray[slot] = None;
        self.placed += 1;

        let (rows, cols) = full_lines(self.occupied());
        let mut clear = 0u64;
        for i in 0..SIZE {
            if rows & (1 << i) != 0 {
                clear |= ROW << (i * SIZE);
            }
            if cols & (1 << i) != 0 {
                clear |= COL << i;
            }
        }
        for i in 0..SIZE * SIZE {
            if clear & (1 << i) != 0 {
                self.cells[i] = 0;
            }
        }
        let lines = rows.count_ones() + cols.count_ones();
        let mut points = cell_count(piece.shape);
        let mut combo = 0;
        if lines > 0 {
            self.combo = if self.combo > 0 { self.combo + 1 } else { 1 };
            self.since_clear = 0;
            combo = self.combo;
            points += LINE_POINTS[lines.min(6) as usize];
            points += COMBO_BONUS * u32::from(self.combo - 1).min(MAX_COMBO_STEP);
            self.lines += lines;
        } else {
            self.since_clear = self.since_clear.saturating_add(1);
            if self.since_clear >= COMBO_WINDOW {
                self.combo = 0;
            }
        }
        self.score = self.score.saturating_add(points);
        Ok(Placed {
            rows,
            cols,
            points,
            combo,
        })
    }

    fn tray_empty(&self) -> bool {
        self.tray.iter().all(Option::is_none)
    }

    fn refresh_status(&mut self) {
        if self.status == Status::Ended {
            return;
        }
        let occupied = self.occupied();
        let any = self
            .tray
            .iter()
            .flatten()
            .any(|p| fits_on(occupied, p.shape));
        self.status = if any { Status::Playing } else { Status::Stuck };
    }
}

/// The board after dropping `mask` on it and clearing full lines.
#[must_use]
pub fn drop_mask(occupied: u64, mask: u64) -> u64 {
    let filled = occupied | mask;
    let (rows, cols) = full_lines(filled);
    let mut clear = 0u64;
    for i in 0..SIZE {
        if rows & (1 << i) != 0 {
            clear |= ROW << (i * SIZE);
        }
        if cols & (1 << i) != 0 {
            clear |= COL << i;
        }
    }
    filled & !clear
}

/// How open a board is for future shapes (higher is better): free cells, room
/// for the big shapes, few lone holes and a short outline. Used by the deal's
/// placeability check and by the bot.
#[must_use]
pub fn openness(occupied: u64) -> i64 {
    let filled = |r: i64, c: i64| -> bool {
        if !(0..8).contains(&r) || !(0..8).contains(&c) {
            return true;
        }
        occupied & (1u64 << (r * 8 + c)) != 0
    };
    let (mut holes, mut edges) = (0i64, 0i64);
    for r in 0..8 {
        for c in 0..8 {
            if filled(r, c) {
                continue;
            }
            let walls = [(r - 1, c), (r + 1, c), (r, c - 1), (r, c + 1)]
                .iter()
                .filter(|(rr, cc)| filled(*rr, *cc))
                .count();
            edges += i64::try_from(walls).unwrap_or(0);
            if walls >= 3 {
                holes += 1;
            }
        }
    }
    // 3×3, both 5-bars, both 3×2 rectangles.
    let room = [12u8, 7, 8, 10, 11]
        .iter()
        .filter(|s| fits_on(occupied, **s))
        .count();
    i64::from(occupied.count_zeros()) * 2 + 30 * i64::try_from(room).unwrap_or(0)
        - 40 * holes
        - 4 * edges
}

/// Every spot where `shape` fits, as board masks.
fn spots(occupied: u64, shape: u8) -> impl Iterator<Item = u64> {
    let (w, h) = (width(shape), height(shape));
    (0..=SIZE.saturating_sub(h)).flat_map(move |row| {
        (0..=SIZE.saturating_sub(w)).filter_map(move |col| {
            let m = mask_at(shape, u8::try_from(row).ok()?, u8::try_from(col).ok()?)?;
            (m & occupied == 0).then_some(m)
        })
    })
}

/// Whether a careful player can place all of `shapes`: some order, placing
/// each at its most open spot, fits them all.
#[must_use]
pub fn placeable(occupied: u64, shapes: &[u8]) -> bool {
    const ORDERS: [[usize; 3]; 6] = [
        [0, 1, 2],
        [0, 2, 1],
        [1, 0, 2],
        [1, 2, 0],
        [2, 0, 1],
        [2, 1, 0],
    ];
    ORDERS.iter().any(|order| {
        let mut board = occupied;
        order.iter().filter(|i| **i < shapes.len()).all(|i| {
            let best = spots(board, shapes[*i])
                .map(|m| drop_mask(board, m))
                .max_by_key(|b| openness(*b));
            best.map(|b| board = b).is_some()
        })
    })
}

fn fits_on(occupied: u64, shape: u8) -> bool {
    let (w, h) = (width(shape), height(shape));
    if w == 0 {
        return false;
    }
    for row in 0..=(SIZE - h) {
        for col in 0..=(SIZE - w) {
            #[allow(clippy::cast_possible_truncation)]
            let m = mask_at(shape, row as u8, col as u8).unwrap_or(u64::MAX);
            if m & occupied == 0 {
                return true;
            }
        }
    }
    false
}

/// Full rows and columns of a board mask, as bit sets.
#[must_use]
pub fn full_lines(filled: u64) -> (u8, u8) {
    let (mut rows, mut cols) = (0u8, 0u8);
    for i in 0..SIZE {
        if filled & (ROW << (i * SIZE)) == ROW << (i * SIZE) {
            rows |= 1 << i;
        }
        if filled & (COL << i) == COL << i {
            cols |= 1 << i;
        }
    }
    (rows, cols)
}

/// A paid assist.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Assist {
    /// New shapes for every slot still holding one.
    Reshuffle,
    /// Clears the 3 × 3 area around `(row, col)` (kept on the board). No points.
    Bomb { row: u8, col: u8 },
}

/// A whole run as the server holds it: the board plus the deal's seed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Game {
    pub seed: u64,
    /// Trays dealt so far (each one's generator is seeded from this).
    pub deals: u32,
    #[serde(flatten)]
    pub board: Board,
}

const RESHUFFLE_STREAM: u64 = 1 << 40;

fn stream(seed: u64, n: u64) -> Rng {
    Rng::new(seed ^ n.wrapping_mul(0x9E37_79B9_7F4A_7C15))
}

impl Game {
    #[must_use]
    pub fn new(seed: u64) -> Self {
        let mut game = Self {
            seed,
            deals: 0,
            board: Board::empty(),
        };
        game.deal();
        game
    }

    pub fn validate(&self) -> Result<(), EngineError> {
        self.board.validate()
    }

    /// 0 at score 0, 100 at [`HARD_SCORE`] and above.
    #[must_use]
    pub fn stage(&self) -> u32 {
        (self.board.score.min(HARD_SCORE) * 100) / HARD_SCORE
    }

    fn weight(def: &ShapeDef, stage: u32) -> u32 {
        let (easy, hard) = def.weight;
        (easy * (100 - stage) + hard * stage) / 100
    }

    /// A weighted pick among shapes accepted by `keep`; `None` if there are none.
    fn pick(rng: &mut Rng, stage: u32, keep: impl Fn(u8) -> bool) -> Option<u8> {
        #[allow(clippy::cast_possible_truncation)]
        let options: Vec<(u8, u32)> = (0..SHAPES.len() as u8)
            .filter(|s| keep(*s))
            .map(|s| (s, Self::weight(&SHAPES[usize::from(s)], stage).max(1)))
            .collect();
        let total: u32 = options.iter().map(|(_, w)| w).sum();
        if total == 0 {
            return None;
        }
        let mut roll = u32::try_from(rng.below(u64::from(total))).unwrap_or(0);
        for (shape, w) in options {
            if roll < w {
                return Some(shape);
            }
            roll -= w;
        }
        None
    }

    /// `n` shapes: one from those that fit (when `helped`), then one simple
    /// and one complex shape.
    fn candidates(rng: &mut Rng, stage: u32, occupied: u64, n: usize, helped: bool) -> Vec<u8> {
        let mut shapes = Vec::with_capacity(n);
        let fitting = if helped {
            Self::pick(rng, stage, |s| fits_on(occupied, s))
        } else {
            None
        };
        shapes.push(fitting.unwrap_or_else(|| Self::pick(rng, stage, |_| true).unwrap_or(0)));
        while shapes.len() < n {
            let simple = shapes.len() == 1;
            shapes.push(
                Self::pick(rng, stage, |s| SHAPES[usize::from(s)].simple == simple).unwrap_or(0),
            );
        }
        shapes
    }

    /// `n` shapes for the tray. With the stage's help chance (always when
    /// `rescue`) the tray is redrawn until the whole tray can be placed.
    fn draw(&self, rng: &mut Rng, n: usize, rescue: bool) -> Vec<Piece> {
        const REDRAWS: usize = 12;
        let stage = self.stage();
        let occupied = self.board.occupied();
        let help = HELP_START - (HELP_START - HELP_END) * u64::from(stage) / 100;
        let helped = rescue || rng.chance(help, 100);
        let mut shapes = Self::candidates(rng, stage, occupied, n, helped);
        if helped {
            for _ in 0..REDRAWS {
                if placeable(occupied, &shapes) {
                    break;
                }
                shapes = Self::candidates(rng, stage, occupied, n, true);
            }
        }
        rng.shuffle(&mut shapes);
        shapes
            .into_iter()
            .map(|shape| Piece {
                shape,
                color: u8::try_from(rng.below(u64::from(COLORS))).unwrap_or(0),
            })
            .collect()
    }

    fn deal(&mut self) {
        let mut rng = stream(self.seed, u64::from(self.deals));
        self.deals += 1;
        let pieces = self.draw(&mut rng, TRAY, false);
        for (slot, piece) in self.board.tray.iter_mut().zip(pieces) {
            *slot = Some(piece);
        }
        self.board.refresh_status();
    }

    /// Places a piece, then deals a new tray if that was the last one.
    pub fn place(&mut self, slot: usize, row: u8, col: u8) -> Result<Placed, EngineError> {
        let placed = self.board.place(slot, row, col)?;
        if self.board.tray_empty() {
            self.deal();
        } else {
            self.board.refresh_status();
        }
        Ok(placed)
    }

    pub fn assist(&mut self, assist: Assist) -> Result<(), EngineError> {
        if self.board.status == Status::Ended {
            return Err(EngineError::GameOver);
        }
        match assist {
            Assist::Reshuffle => {
                if self.board.reshuffles >= MAX_RESHUFFLES {
                    return Err(EngineError::LimitExceeded("reshuffles".into()));
                }
                let slots: Vec<usize> = (0..TRAY)
                    .filter(|i| self.board.tray[*i].is_some())
                    .collect();
                let mut rng = stream(
                    self.seed,
                    RESHUFFLE_STREAM + u64::from(self.board.reshuffles),
                );
                let pieces = self.draw(&mut rng, slots.len(), true);
                for (slot, piece) in slots.into_iter().zip(pieces) {
                    self.board.tray[slot] = Some(piece);
                }
                self.board.reshuffles += 1;
            }
            Assist::Bomb { row, col } => {
                if self.board.bombs >= MAX_BOMBS {
                    return Err(EngineError::LimitExceeded("bombs".into()));
                }
                if usize::from(row) >= SIZE || usize::from(col) >= SIZE {
                    return Err(EngineError::InvalidInput("bomb off the board".into()));
                }
                let r0 = usize::from(row).clamp(1, SIZE - 2) - 1;
                let c0 = usize::from(col).clamp(1, SIZE - 2) - 1;
                for r in r0..r0 + 3 {
                    for c in c0..c0 + 3 {
                        self.board.cells[r * SIZE + c] = 0;
                    }
                }
                self.board.bombs += 1;
            }
        }
        self.board.status = Status::Playing;
        self.board.refresh_status();
        Ok(())
    }

    /// Ends the run (the player gave up, or was stuck and chose not to pay).
    pub fn end(&mut self) {
        self.board.status = Status::Ended;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn board_with(tray: [Option<u8>; 3]) -> Board {
        let mut b = Board::empty();
        b.tray = tray.map(|s| s.map(|shape| Piece { shape, color: 0 }));
        b
    }

    #[test]
    fn shapes_are_well_formed_and_distinct() {
        let mut seen = std::collections::BTreeSet::new();
        #[allow(clippy::cast_possible_truncation)]
        for s in 0..SHAPES.len() as u8 {
            let m = mask_at(s, 0, 0).expect("fits at the origin");
            assert!(
                m & ROW != 0 && m & COL != 0,
                "shape {s} must touch the top and left"
            );
            assert!(seen.insert(m), "shape {s} is a duplicate");
            assert!(width(s) <= 5 && height(s) <= 5);
        }
    }

    #[test]
    fn a_row_clears_and_scores() {
        let mut b = board_with([Some(7), Some(5), None]);
        // Fill row 0 except the last 5 cells... then place the 1×5 bar.
        for c in 0..3 {
            b.cells[c] = 1;
        }
        let p = b.place(0, 0, 3).unwrap();
        assert_eq!((p.rows, p.cols), (1, 0));
        assert_eq!(p.points, 5 + 100);
        assert_eq!(p.combo, 1);
        assert!(b.cells[..8].iter().all(|c| *c == 0));
        assert_eq!(b.lines, 1);
    }

    #[test]
    fn rows_and_columns_clear_together() {
        let mut b = board_with([Some(0), None, None]);
        for i in 0..SIZE {
            b.cells[i] = 1; // row 0
            b.cells[i * SIZE] = 1; // column 0
        }
        b.cells[0] = 0;
        let p = b.place(0, 0, 0).unwrap();
        assert_eq!((p.rows, p.cols), (1, 1));
        assert_eq!(p.points, 1 + 300);
        assert_eq!(b.occupied(), 0);
    }

    #[test]
    fn combos_need_back_to_back_clears() {
        let mut b = board_with([Some(0), Some(0), Some(0)]);
        let fill_row = |b: &mut Board, r: usize| {
            for c in 1..SIZE {
                b.cells[r * SIZE + c] = 1;
            }
        };
        fill_row(&mut b, 0);
        assert_eq!(b.place(0, 0, 0).unwrap().combo, 1);
        fill_row(&mut b, 1);
        let p = b.place(1, 1, 0).unwrap();
        assert_eq!(p.combo, 2);
        assert_eq!(p.points, 1 + 100 + COMBO_BONUS);
        b.place(2, 7, 7).unwrap(); // no clear: the chain ends
        assert_eq!(b.combo, 0);
        b.tray = [Some(Piece { shape: 0, color: 0 }); 3];
        fill_row(&mut b, 2);
        assert_eq!(b.place(0, 2, 0).unwrap().combo, 1);
    }

    #[test]
    fn the_combo_bonus_is_capped() {
        let mut b = board_with([Some(0), None, None]);
        b.combo = 40;
        for c in 1..SIZE {
            b.cells[c] = 1;
        }
        let p = b.place(0, 0, 0).unwrap();
        assert_eq!(p.points, 1 + 100 + COMBO_BONUS * MAX_COMBO_STEP);
    }

    #[test]
    fn illegal_placements_are_refused() {
        let mut b = board_with([Some(12), None, None]);
        assert!(b.place(0, 6, 0).is_err(), "3×3 off the bottom");
        assert!(b.place(1, 0, 0).is_err(), "empty slot");
        b.cells[0] = 1;
        assert!(b.place(0, 0, 0).is_err(), "overlap");
        assert!(b.place(0, 0, 1).is_ok());
    }

    #[test]
    fn the_server_deals_when_the_tray_empties() {
        let mut g = Game::new(42);
        assert_eq!(g.deals, 1);
        let mut placed = 0;
        while placed < 3 {
            let slot = (0..TRAY).find(|s| g.board.tray[*s].is_some()).unwrap();
            let shape = g.board.tray[slot].unwrap().shape;
            let spot = (0..SIZE as u8)
                .flat_map(|r| (0..SIZE as u8).map(move |c| (r, c)))
                .find(|(r, c)| g.board.can_place(slot, *r, *c));
            let Some((r, c)) = spot else {
                panic!("shape {shape} has no room on a near-empty board");
            };
            g.place(slot, r, c).unwrap();
            placed += 1;
        }
        assert_eq!(g.deals, 2);
        assert!(g.board.tray.iter().all(Option::is_some));
    }

    #[test]
    fn deals_are_deterministic() {
        let a = bot::play(7, 400);
        let b = bot::play(7, 400);
        assert_eq!(a, b);
        assert_ne!(Game::new(7).board.tray, Game::new(8).board.tray);
    }

    #[test]
    fn stuck_then_rescued_by_a_bomb() {
        let mut g = Game::new(1);
        g.board.cells = vec![1; SIZE * SIZE];
        g.board.tray = [
            Some(Piece {
                shape: 12,
                color: 0,
            }),
            None,
            None,
        ];
        g.board.refresh_status();
        assert_eq!(g.board.status, Status::Stuck);
        assert!(g.place(0, 0, 0).is_err());
        g.assist(Assist::Bomb { row: 0, col: 0 }).unwrap();
        assert_eq!(g.board.status, Status::Playing);
        assert!(g.place(0, 0, 0).is_ok());
    }

    #[test]
    fn a_reshuffle_always_fits_something() {
        let mut g = Game::new(3);
        g.board.cells = vec![1; SIZE * SIZE];
        g.board.cells[9] = 0;
        g.board.tray = [
            Some(Piece {
                shape: 12,
                color: 0,
            }),
            Some(Piece { shape: 7, color: 0 }),
            None,
        ];
        g.board.refresh_status();
        assert_eq!(g.board.status, Status::Stuck);
        g.assist(Assist::Reshuffle).unwrap();
        assert_eq!(g.board.status, Status::Playing);
        assert!(
            g.board.tray[2].is_none(),
            "only filled slots are reshuffled"
        );
        for _ in 1..MAX_RESHUFFLES {
            g.assist(Assist::Reshuffle).unwrap();
        }
        assert!(g.assist(Assist::Reshuffle).is_err());
    }

    #[test]
    fn json_round_trip_keeps_the_seed_server_side() {
        let g = Game::new(99);
        let full = serde_json::to_string(&g).unwrap();
        let back: Game = serde_json::from_str(&full).unwrap();
        assert_eq!(back, g);
        let public = serde_json::to_string(&g.board).unwrap();
        assert!(!public.contains("seed") && !public.contains("deals"));
    }
}
