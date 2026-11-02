//! Water Sort: pour liquid between bottles until each holds a single colour.
//!
//! Rules (see the Water Sort design doc):
//! - Bottles hold `capacity` units (4 to 6, set per level); every colour appears
//!   exactly that many times.
//! - Pour A → B is legal when A is non-empty, B is not full, and B is empty or
//!   B's top colour equals A's top colour.
//! - A pour moves the whole contiguous run of A's top colour, as much as fits.
//! - Hidden levels show only each bottle's top run. A layer is revealed when it
//!   reaches the top and stays revealed. The server keeps the true colours and sends
//!   the client a masked board, with [`HIDDEN`] for layers not seen yet.
//! - The paid assist [`ADD_BOTTLE`] adds one empty bottle.

mod packed;
mod solver;

use std::fmt;

use serde::{Deserialize, Serialize};

use crate::rng::Rng;
use packed::Packed;
pub use solver::{hint, solve, HintOutcome, SolveOutcome};

pub const MIN_CAPACITY: usize = 4;
pub const MAX_CAPACITY: usize = 6;
pub const MAX_BOTTLES: usize = 16;
pub const MAX_COLORS: usize = 12;
/// Upper bound on moves accepted in one replay; bounds server CPU per request.
pub const MAX_MOVES: usize = 500;
/// A layer the player has not seen yet (masked boards only).
pub const HIDDEN: u8 = u8::MAX;
/// The move that adds an empty bottle (a paid assist).
pub const ADD_BOTTLE: Move = (254, 254);
pub const MAX_EXTRA_BOTTLES: usize = 2;

/// `(from, to)` bottle indices, or [`ADD_BOTTLE`].
pub type Move = (u8, u8);

/// Layers seen so far: bit `i` is the layer that started in slot `i`
/// (`bottle * MAX_CAPACITY + position`). Fits: 16 × 6 = 96 slots.
pub type Revealed = u128;

/// Bottles listed left to right; each bottle lists colours bottom → top.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Board {
    pub capacity: u8,
    pub bottles: Vec<Vec<u8>>,
    /// Each layer's starting slot, so "seen" follows a layer as it is poured.
    /// Server-side only; assigned when a replay starts.
    #[serde(skip)]
    ids: Vec<Vec<u8>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MoveError {
    OutOfRange,
    SameBottle,
    SourceEmpty,
    TargetFull,
    ColorMismatch,
    /// A top layer is still hidden; the client must wait for the server to reveal it.
    Hidden,
    TooManyBottles,
}

impl fmt::Display for MoveError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::OutOfRange => "bottle index out of range",
            Self::SameBottle => "cannot pour a bottle into itself",
            Self::SourceEmpty => "source bottle is empty",
            Self::TargetFull => "target bottle is full",
            Self::ColorMismatch => "top colours do not match",
            Self::Hidden => "a top colour is still hidden",
            Self::TooManyBottles => "no more bottles can be added",
        })
    }
}

impl std::error::Error for MoveError {}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BoardError {
    Capacity(u8),
    BottleCount(usize),
    BottleOverflow(usize),
    ColorOutOfRange(u8),
    ColorCount { color: u8, count: usize },
}

impl fmt::Display for BoardError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Capacity(c) => {
                write!(f, "capacity {c} outside {MIN_CAPACITY}..={MAX_CAPACITY}")
            }
            Self::BottleCount(n) => write!(f, "invalid bottle count {n}"),
            Self::BottleOverflow(i) => write!(f, "bottle {i} is over capacity"),
            Self::ColorOutOfRange(c) => write!(f, "colour {c} out of range"),
            Self::ColorCount { color, count } => {
                write!(
                    f,
                    "colour {color} appears {count} times, expected the capacity"
                )
            }
        }
    }
}

impl std::error::Error for BoardError {}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ReplayError {
    TooManyMoves(usize),
    InvalidBoard(BoardError),
    IllegalMove { index: usize, error: MoveError },
}

impl fmt::Display for ReplayError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::TooManyMoves(n) => write!(f, "{n} moves exceeds the limit of {MAX_MOVES}"),
            Self::InvalidBoard(e) => write!(f, "invalid board: {e}"),
            Self::IllegalMove { index, error } => write!(f, "move {index} is illegal: {error}"),
        }
    }
}

impl std::error::Error for ReplayError {}

impl Board {
    #[must_use]
    pub fn new(capacity: u8, bottles: Vec<Vec<u8>>) -> Self {
        Self {
            capacity,
            bottles,
            ids: Vec::new(),
        }
    }

    fn cap(&self) -> usize {
        usize::from(self.capacity)
    }

    /// Builds a random, fully mixed board from a seed.
    ///
    /// The result is not guaranteed solvable; the level generator proves that
    /// with [`solve`] before a seed is ever used for a level.
    #[must_use]
    pub fn generate(seed: u64, colors: u8, empty: u8, capacity: u8) -> Self {
        let colors_n = usize::from(colors);
        let cap = usize::from(capacity);
        assert!(
            (2..=MAX_COLORS).contains(&colors_n)
                && colors_n + usize::from(empty) <= MAX_BOTTLES
                && (MIN_CAPACITY..=MAX_CAPACITY).contains(&cap),
            "unsupported board: {colors} colours + {empty} empty, capacity {capacity}"
        );
        let mut rng = Rng::new(seed);
        let mut units: Vec<u8> = (0..colors)
            .flat_map(|c| std::iter::repeat_n(c, cap))
            .collect();
        loop {
            rng.shuffle(&mut units);
            let mut bottles: Vec<Vec<u8>> = units.chunks(cap).map(<[u8]>::to_vec).collect();
            let already_sorted = bottles.iter().any(|b| b.iter().all(|c| *c == b[0]));
            if !already_sorted {
                bottles.extend((0..empty).map(|_| Vec::new()));
                return Self::new(capacity, bottles);
            }
        }
    }

    /// Checks shape invariants: capacity, bottle count, and exact colour counts.
    pub fn validate(&self) -> Result<(), BoardError> {
        self.check(false)
    }

    /// Like [`validate`](Self::validate) for a client's masked board: hidden layers are
    /// allowed, so colour counts can only be checked as upper bounds.
    pub fn validate_masked(&self) -> Result<(), BoardError> {
        self.check(true)
    }

    fn check(&self, masked: bool) -> Result<(), BoardError> {
        if !(MIN_CAPACITY..=MAX_CAPACITY).contains(&self.cap()) {
            return Err(BoardError::Capacity(self.capacity));
        }
        let n = self.bottles.len();
        if !(2..=MAX_BOTTLES).contains(&n) {
            return Err(BoardError::BottleCount(n));
        }
        let mut counts = [0usize; MAX_COLORS];
        for (i, bottle) in self.bottles.iter().enumerate() {
            if bottle.len() > self.cap() {
                return Err(BoardError::BottleOverflow(i));
            }
            for &c in bottle {
                if masked && c == HIDDEN {
                    continue;
                }
                let slot = counts
                    .get_mut(usize::from(c))
                    .ok_or(BoardError::ColorOutOfRange(c))?;
                *slot += 1;
            }
        }
        for (color, &count) in counts.iter().enumerate() {
            let bad = if masked {
                count > self.cap()
            } else {
                count != 0 && count != self.cap()
            };
            if bad {
                let color = u8::try_from(color).expect("MAX_COLORS fits u8");
                return Err(BoardError::ColorCount { color, count });
            }
        }
        Ok(())
    }

    /// Gives every layer an id: its starting slot (for tracking what has been seen).
    fn assign_ids(&mut self) {
        self.ids = self
            .bottles
            .iter()
            .enumerate()
            .map(|(i, b)| {
                (0..b.len())
                    .map(|j| u8::try_from(i * MAX_CAPACITY + j).expect("96 slots fit u8"))
                    .collect()
            })
            .collect();
    }

    /// Number of units a pour would move, or why it is illegal.
    pub fn can_pour(&self, from: u8, to: u8) -> Result<usize, MoveError> {
        Packed::from_board(self).pour_amount(usize::from(from), usize::from(to))
    }

    /// Applies a pour in place and returns the number of units moved.
    pub fn pour(&mut self, from: u8, to: u8) -> Result<usize, MoveError> {
        let amount = self.can_pour(from, to)?;
        let (f, t) = (usize::from(from), usize::from(to));
        let at = self.bottles[f].len() - amount;
        let moved: Vec<u8> = self.bottles[f].drain(at..).collect();
        self.bottles[t].extend(moved);
        if !self.ids.is_empty() {
            let moved: Vec<u8> = self.ids[f].drain(at..).collect();
            self.ids[t].extend(moved);
        }
        Ok(amount)
    }

    /// Adds an empty bottle (the paid assist).
    pub fn add_bottle(&mut self) -> Result<(), MoveError> {
        if self.bottles.len() >= MAX_BOTTLES {
            return Err(MoveError::TooManyBottles);
        }
        self.bottles.push(Vec::new());
        if !self.ids.is_empty() {
            self.ids.push(Vec::new());
        }
        Ok(())
    }

    /// Applies a pour or [`ADD_BOTTLE`].
    pub fn apply(&mut self, (from, to): Move) -> Result<(), MoveError> {
        if (from, to) == ADD_BOTTLE {
            self.add_bottle()
        } else {
            self.pour(from, to).map(|_| ())
        }
    }

    #[must_use]
    pub fn is_solved(&self) -> bool {
        let cap = self.cap();
        self.bottles
            .iter()
            .all(|b| b.is_empty() || (b.len() == cap && b.iter().all(|c| *c == b[0])))
    }

    /// All legal moves, in a stable order.
    #[must_use]
    pub fn legal_moves(&self) -> Vec<Move> {
        let packed = Packed::from_board(self);
        let mut out = Vec::new();
        packed.useful_moves(&mut out);
        out
    }

    #[must_use]
    pub fn color_count(&self) -> usize {
        let mut seen = [false; MAX_COLORS];
        for &c in self.bottles.iter().flatten() {
            if let Some(s) = seen.get_mut(usize::from(c)) {
                *s = true;
            }
        }
        seen.iter().filter(|s| **s).count()
    }

    /// Marks each bottle's top run (its visible colour) as seen.
    fn reveal_tops(&self, revealed: &mut Revealed) {
        for (bottle, ids) in self.bottles.iter().zip(&self.ids) {
            let Some(&top) = bottle.last() else { continue };
            for (&c, &id) in bottle.iter().zip(ids).rev() {
                if c != top {
                    break;
                }
                *revealed |= 1 << id;
            }
        }
    }

    /// The board as the player may see it: unseen layers become [`HIDDEN`].
    #[must_use]
    pub fn masked(&self, revealed: Revealed) -> Self {
        let bottles = self
            .bottles
            .iter()
            .zip(&self.ids)
            .map(|(b, ids)| {
                b.iter()
                    .zip(ids)
                    .map(|(&c, &id)| if revealed >> id & 1 == 1 { c } else { HIDDEN })
                    .collect()
            })
            .collect();
        Self::new(self.capacity, bottles)
    }
}

/// Replays `moves` from `start`, rejecting any illegal move.
pub fn replay(start: &Board, moves: &[Move]) -> Result<Board, ReplayError> {
    replay_revealing(start, moves, None).map(|(board, _)| board)
}

/// Replays `moves` and tracks which layers have been seen, starting from `revealed`
/// (what this player saw before, e.g. on a path they later undid). With `None`,
/// nothing is tracked. Returns the full board (server-side) and the layers seen.
pub fn replay_revealing(
    start: &Board,
    moves: &[Move],
    revealed: Option<Revealed>,
) -> Result<(Board, Revealed), ReplayError> {
    if moves.len() > MAX_MOVES {
        return Err(ReplayError::TooManyMoves(moves.len()));
    }
    start.validate().map_err(ReplayError::InvalidBoard)?;
    let mut board = start.clone();
    board.assign_ids();
    let mut seen = revealed.unwrap_or(0);
    let track = revealed.is_some();
    if track {
        board.reveal_tops(&mut seen);
    }
    let mut added = 0;
    for (index, &mv) in moves.iter().enumerate() {
        if mv == ADD_BOTTLE {
            added += 1;
            if added > MAX_EXTRA_BOTTLES {
                return Err(ReplayError::IllegalMove {
                    index,
                    error: MoveError::TooManyBottles,
                });
            }
        }
        board
            .apply(mv)
            .map_err(|error| ReplayError::IllegalMove { index, error })?;
        if track {
            board.reveal_tops(&mut seen);
        }
    }
    Ok((board, seen))
}

/// Number of [`ADD_BOTTLE`] moves in a move list.
#[must_use]
pub fn bottles_added(moves: &[Move]) -> usize {
    moves.iter().filter(|m| **m == ADD_BOTTLE).count()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn b(bottles: &[&[u8]]) -> Board {
        Board::new(4, bottles.iter().map(|x| x.to_vec()).collect())
    }

    #[test]
    fn pour_moves_whole_top_run() {
        let mut board = b(&[&[0, 1, 1], &[2, 1], &[0, 0, 2, 2], &[0], &[]]);
        assert_eq!(board.pour(0, 1), Ok(2));
        assert_eq!(board.bottles[0], vec![0]);
        assert_eq!(board.bottles[1], vec![2, 1, 1, 1]);
    }

    #[test]
    fn partial_pour_when_target_lacks_room() {
        let mut board = b(&[&[1, 0, 0, 0], &[1, 1, 1, 0], &[]]);
        assert_eq!(board.pour(0, 1), Err(MoveError::TargetFull));
        let mut board = b(&[&[1, 0, 0, 0], &[1, 1, 0], &[1]]);
        assert_eq!(board.pour(0, 1), Ok(1));
        assert_eq!(board.bottles[0], vec![1, 0, 0]);
    }

    #[test]
    fn illegal_pours_are_rejected() {
        let board = b(&[&[0, 1], &[1, 0], &[], &[0, 1]]);
        assert_eq!(board.can_pour(2, 0), Err(MoveError::SourceEmpty));
        assert_eq!(board.can_pour(0, 1), Err(MoveError::ColorMismatch));
        assert_eq!(board.can_pour(0, 0), Err(MoveError::SameBottle));
        assert_eq!(board.can_pour(0, 9), Err(MoveError::OutOfRange));
    }

    #[test]
    fn solved_detection() {
        assert!(b(&[&[0, 0, 0, 0], &[], &[1, 1, 1, 1]]).is_solved());
        assert!(!b(&[&[0, 0, 0], &[0], &[1, 1, 1, 1]]).is_solved());
    }

    #[test]
    fn validate_catches_bad_boards() {
        assert!(b(&[&[0, 0, 0, 0], &[1, 1, 1, 1], &[]]).validate().is_ok());
        assert_eq!(
            b(&[&[0, 0, 0], &[1, 1, 1, 1], &[]]).validate(),
            Err(BoardError::ColorCount { color: 0, count: 3 })
        );
        assert_eq!(
            b(&[&[0, 0, 0, 0, 0]]).validate(),
            Err(BoardError::BottleCount(1))
        );
        assert_eq!(
            b(&[&[0, 0, 0, 0], &[40, 40, 40, 40]]).validate(),
            Err(BoardError::ColorOutOfRange(40))
        );
        let mut tall = b(&[&[0, 0, 0, 0], &[]]);
        tall.capacity = 7;
        assert_eq!(tall.validate(), Err(BoardError::Capacity(7)));
    }

    #[test]
    fn generate_is_deterministic_and_valid() {
        for capacity in 4..=6 {
            let a = Board::generate(99, 6, 2, capacity);
            assert_eq!(a, Board::generate(99, 6, 2, capacity));
            a.validate().unwrap();
            assert_eq!(a.bottles.len(), 8);
            assert_eq!(a.bottles[0].len(), usize::from(capacity));
            assert!(a.bottles[6].is_empty() && a.bottles[7].is_empty());
            assert!(!a.is_solved());
        }
        assert_ne!(Board::generate(99, 6, 2, 5), Board::generate(100, 6, 2, 5));
    }

    #[test]
    fn taller_bottles_pour_and_solve_by_capacity() {
        let mut board = Board::new(5, vec![vec![0, 0, 0, 0, 1], vec![1, 1, 1, 1, 0], vec![]]);
        board.validate().unwrap();
        board.pour(0, 2).unwrap();
        board.pour(1, 0).unwrap();
        board.pour(2, 1).unwrap();
        assert!(board.is_solved());
    }

    #[test]
    fn replay_reports_first_illegal_move() {
        let board = b(&[&[0, 1, 0, 1], &[1, 0, 1, 0], &[]]);
        let err = replay(&board, &[(0, 2), (0, 2)]).unwrap_err();
        assert_eq!(
            err,
            ReplayError::IllegalMove {
                index: 1,
                error: MoveError::ColorMismatch
            }
        );
        assert!(matches!(
            replay(&board, &vec![(0, 2); MAX_MOVES + 1]),
            Err(ReplayError::TooManyMoves(_))
        ));
    }

    #[test]
    fn extra_bottles_are_capped() {
        let board = b(&[&[0, 1, 0, 1], &[1, 0, 1, 0], &[]]);
        let two = replay(&board, &[ADD_BOTTLE, ADD_BOTTLE]).unwrap();
        assert_eq!(two.bottles.len(), 5);
        assert!(matches!(
            replay(&board, &[ADD_BOTTLE, ADD_BOTTLE, ADD_BOTTLE]),
            Err(ReplayError::IllegalMove {
                index: 2,
                error: MoveError::TooManyBottles
            })
        ));
        assert_eq!(bottles_added(&[ADD_BOTTLE, (0, 2), ADD_BOTTLE]), 2);
    }

    #[test]
    fn hidden_layers_show_only_top_runs_and_stay_seen() {
        let board = b(&[&[1, 0, 2, 2], &[2, 2, 0, 1], &[0, 1, 1, 0], &[]]);
        let (start, seen) = replay_revealing(&board, &[], Some(0)).unwrap();
        let masked = start.masked(seen);
        assert_eq!(masked.bottles[0], vec![HIDDEN, HIDDEN, 2, 2]);
        assert_eq!(masked.bottles[1], vec![HIDDEN, HIDDEN, HIDDEN, 1]);

        // Pouring bottle 0's 2s away reveals the 0 underneath.
        let (after, seen_after) = replay_revealing(&board, &[(0, 3)], Some(seen)).unwrap();
        assert_eq!(after.masked(seen_after).bottles[0], vec![HIDDEN, 0]);

        // Undo (replaying fewer moves) keeps what was seen.
        let (undone, _) = replay_revealing(&board, &[], Some(seen_after)).unwrap();
        assert_eq!(undone.masked(seen_after).bottles[0], vec![HIDDEN, 0, 2, 2]);
    }

    #[test]
    fn masked_boards_pour_but_never_from_or_onto_hidden_tops() {
        let masked = Board::new(4, vec![vec![HIDDEN, 1, 1], vec![HIDDEN], vec![]]);
        masked.validate_masked().unwrap();
        assert!(masked.validate().is_err());
        assert_eq!(masked.can_pour(0, 2), Ok(2));
        assert_eq!(masked.can_pour(1, 2), Err(MoveError::Hidden));
        assert_eq!(masked.can_pour(0, 1), Err(MoveError::Hidden));
    }
}
