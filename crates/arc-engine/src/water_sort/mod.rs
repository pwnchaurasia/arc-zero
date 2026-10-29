//! Water Sort: pour liquid between bottles until each holds a single colour.
//!
//! Rules (see the Water Sort design doc):
//! - Each bottle holds [`CAPACITY`] units; every colour appears exactly that many times.
//! - Pour A → B is legal when A is non-empty, B is not full, and B is empty or
//!   B's top colour equals A's top colour.
//! - A pour moves the whole contiguous run of A's top colour, as much as fits.

mod packed;
mod solver;

use std::fmt;

use serde::{Deserialize, Serialize};

use crate::rng::Rng;
use packed::Packed;
pub use solver::{hint, solve, HintOutcome, SolveOutcome};

pub const CAPACITY: usize = 4;
pub const MAX_BOTTLES: usize = 16;
pub const MAX_COLORS: usize = 12;
/// Upper bound on moves accepted in one replay; bounds server CPU per request.
pub const MAX_MOVES: usize = 500;

/// `(from, to)` bottle indices.
pub type Move = (u8, u8);

/// Bottles listed left to right; each bottle lists colours bottom → top.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Board {
    pub bottles: Vec<Vec<u8>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MoveError {
    OutOfRange,
    SameBottle,
    SourceEmpty,
    TargetFull,
    ColorMismatch,
}

impl fmt::Display for MoveError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::OutOfRange => "bottle index out of range",
            Self::SameBottle => "cannot pour a bottle into itself",
            Self::SourceEmpty => "source bottle is empty",
            Self::TargetFull => "target bottle is full",
            Self::ColorMismatch => "top colours do not match",
        })
    }
}

impl std::error::Error for MoveError {}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BoardError {
    BottleCount(usize),
    BottleOverflow(usize),
    ColorOutOfRange(u8),
    ColorCount { color: u8, count: usize },
}

impl fmt::Display for BoardError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::BottleCount(n) => write!(f, "invalid bottle count {n}"),
            Self::BottleOverflow(i) => write!(f, "bottle {i} holds more than {CAPACITY} units"),
            Self::ColorOutOfRange(c) => write!(f, "colour {c} out of range"),
            Self::ColorCount { color, count } => {
                write!(
                    f,
                    "colour {color} appears {count} times, expected {CAPACITY}"
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
    /// Builds a random, fully mixed board from a seed.
    ///
    /// The result is not guaranteed solvable; the level generator proves that
    /// with [`solve`] before a seed is ever used for a level.
    #[must_use]
    pub fn generate(seed: u64, colors: u8, empty: u8) -> Self {
        let colors_n = usize::from(colors);
        assert!(
            (2..=MAX_COLORS).contains(&colors_n) && colors_n + usize::from(empty) <= MAX_BOTTLES,
            "unsupported board size: {colors} colours + {empty} empty"
        );
        let mut rng = Rng::new(seed);
        let mut units: Vec<u8> = (0..colors)
            .flat_map(|c| std::iter::repeat_n(c, CAPACITY))
            .collect();
        loop {
            rng.shuffle(&mut units);
            let mut bottles: Vec<Vec<u8>> = units.chunks(CAPACITY).map(<[u8]>::to_vec).collect();
            let already_sorted = bottles.iter().any(|b| b.iter().all(|c| *c == b[0]));
            if !already_sorted {
                bottles.extend((0..empty).map(|_| Vec::new()));
                return Self { bottles };
            }
        }
    }

    /// Checks shape invariants: bottle count, capacity, and exact colour counts.
    pub fn validate(&self) -> Result<(), BoardError> {
        let n = self.bottles.len();
        if !(2..=MAX_BOTTLES).contains(&n) {
            return Err(BoardError::BottleCount(n));
        }
        let mut counts = [0usize; MAX_COLORS];
        for (i, bottle) in self.bottles.iter().enumerate() {
            if bottle.len() > CAPACITY {
                return Err(BoardError::BottleOverflow(i));
            }
            for &c in bottle {
                let slot = counts
                    .get_mut(usize::from(c))
                    .ok_or(BoardError::ColorOutOfRange(c))?;
                *slot += 1;
            }
        }
        for (color, &count) in counts.iter().enumerate() {
            if count != 0 && count != CAPACITY {
                let color = u8::try_from(color).expect("MAX_COLORS fits u8");
                return Err(BoardError::ColorCount { color, count });
            }
        }
        Ok(())
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
        Ok(amount)
    }

    #[must_use]
    pub fn is_solved(&self) -> bool {
        self.bottles
            .iter()
            .all(|b| b.is_empty() || (b.len() == CAPACITY && b.iter().all(|c| *c == b[0])))
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
}

/// Replays `moves` from `start`, rejecting any illegal move.
pub fn replay(start: &Board, moves: &[Move]) -> Result<Board, ReplayError> {
    if moves.len() > MAX_MOVES {
        return Err(ReplayError::TooManyMoves(moves.len()));
    }
    start.validate().map_err(ReplayError::InvalidBoard)?;
    let mut board = start.clone();
    for (index, &(from, to)) in moves.iter().enumerate() {
        board
            .pour(from, to)
            .map_err(|error| ReplayError::IllegalMove { index, error })?;
    }
    Ok(board)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn b(bottles: &[&[u8]]) -> Board {
        Board {
            bottles: bottles.iter().map(|x| x.to_vec()).collect(),
        }
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
    }

    #[test]
    fn generate_is_deterministic_and_valid() {
        let a = Board::generate(99, 6, 2);
        assert_eq!(a, Board::generate(99, 6, 2));
        assert_ne!(a, Board::generate(100, 6, 2));
        a.validate().unwrap();
        assert_eq!(a.bottles.len(), 8);
        assert!(a.bottles[6].is_empty() && a.bottles[7].is_empty());
        assert!(!a.is_solved());
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
}
