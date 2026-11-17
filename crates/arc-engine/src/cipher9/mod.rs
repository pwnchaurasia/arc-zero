//! Cipher9: Sudoku with no lives and no game over.
//!
//! Rules (decision 2026-11-17, see the Cipher9 design doc):
//! - A level is a puzzle with exactly one solution. The solution never leaves the
//!   server; the browser only sees the givens.
//! - A move sets a cell that isn't a given to 1-9, or clears it (0).
//! - A number that isn't the solution's counts as a mistake the moment it's entered,
//!   even if it's changed later. Mistakes only decide the stars.
//! - Won when the grid matches the solution. With one solution that's the same as a
//!   full grid where no number repeats in a row, column or box, which is what the
//!   browser checks before asking the server.

pub mod logic;

use std::fmt;

use serde::{Deserialize, Serialize};

pub const SIZE: usize = 9;
pub const CELLS: usize = SIZE * SIZE;
/// Fewer clues can never have a unique solution.
pub const MIN_CLUES: usize = 17;
/// Every empty cell many times over: generous but bounded.
pub const MAX_MOVES: usize = 2_000;

pub type Grid = [u8; CELLS];

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Level {
    /// 81 digits row by row, `0` for an empty cell. Public.
    pub puzzle: String,
    /// 81 digits. Server-only.
    pub solution: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LevelError(pub String);

impl fmt::Display for LevelError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "invalid level: {}", self.0)
    }
}

impl std::error::Error for LevelError {}

/// Reads 81 digits; `0` (an empty cell) only where `empty_ok`.
pub fn parse_grid(text: &str, empty_ok: bool) -> Result<Grid, LevelError> {
    let bytes = text.as_bytes();
    if bytes.len() != CELLS {
        return Err(LevelError("a grid has 81 digits".into()));
    }
    let mut grid = [0u8; CELLS];
    for (cell, b) in grid.iter_mut().zip(bytes) {
        let d = b.wrapping_sub(b'0');
        if d > 9 || (d == 0 && !empty_ok) {
            return Err(LevelError("grid digits must be 1-9 (0 for empty)".into()));
        }
        *cell = d;
    }
    Ok(grid)
}

#[must_use]
pub fn grid_text(grid: &Grid) -> String {
    grid.iter().map(|d| char::from(b'0' + d)).collect()
}

/// Whether no digit repeats in any row, column or box (empty cells are ignored).
#[must_use]
pub fn consistent(grid: &Grid) -> bool {
    logic::UNITS.iter().all(|unit| {
        let mut seen = 0u16;
        unit.iter().all(|&c| {
            let d = grid[c];
            if d == 0 {
                return true;
            }
            let bit = 1 << d;
            let fresh = seen & bit == 0;
            seen |= bit;
            fresh
        })
    })
}

impl Level {
    /// The puzzle and the solution, checked only for format.
    pub fn grids(&self) -> Result<(Grid, Grid), LevelError> {
        Ok((
            parse_grid(&self.puzzle, true)?,
            parse_grid(&self.solution, false)?,
        ))
    }

    pub fn validate(&self) -> Result<(), LevelError> {
        let bad = |m: &str| Err(LevelError(m.to_owned()));
        let (puzzle, solution) = self.grids()?;
        if !consistent(&solution) {
            return bad("the solution breaks the rules");
        }
        if puzzle.iter().zip(&solution).any(|(p, s)| *p != 0 && p != s) {
            return bad("a given doesn't match the solution");
        }
        if puzzle.iter().filter(|d| **d != 0).count() < MIN_CLUES {
            return bad("too few clues");
        }
        if logic::count_solutions(&puzzle, 2) != 1 {
            return bad("the puzzle must have exactly one solution");
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Playing,
    Won,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MoveError {
    NoSuchCell,
    Given,
    BadDigit,
    NotPlaying,
    TooManyMoves,
}

impl fmt::Display for MoveError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::NoSuchCell => "no such cell",
            Self::Given => "that cell is a given",
            Self::BadDigit => "digits are 0-9",
            Self::NotPlaying => "the puzzle is already solved",
            Self::TooManyMoves => "too many moves",
        })
    }
}

impl std::error::Error for MoveError {}

#[derive(Clone, Debug)]
pub struct Game {
    puzzle: Grid,
    solution: Grid,
    grid: Grid,
    mistakes: u16,
    moves: usize,
}

impl Game {
    pub fn new(level: &Level) -> Result<Self, LevelError> {
        let (puzzle, solution) = level.grids()?;
        Ok(Self {
            puzzle,
            solution,
            grid: puzzle,
            mistakes: 0,
            moves: 0,
        })
    }

    /// Sets `cell` to `digit` (0 clears it). Returns whether the number is the solution's.
    pub fn set(&mut self, cell: usize, digit: u8) -> Result<bool, MoveError> {
        if cell >= CELLS {
            return Err(MoveError::NoSuchCell);
        }
        if digit > 9 {
            return Err(MoveError::BadDigit);
        }
        if self.puzzle[cell] != 0 {
            return Err(MoveError::Given);
        }
        if self.status() != Status::Playing {
            return Err(MoveError::NotPlaying);
        }
        if self.moves >= MAX_MOVES {
            return Err(MoveError::TooManyMoves);
        }
        self.moves += 1;
        let right = digit == self.solution[cell];
        // Entering the number already there changes nothing, so it can't be a new mistake.
        if digit != 0 && !right && self.grid[cell] != digit {
            self.mistakes += 1;
        }
        self.grid[cell] = digit;
        Ok(right)
    }

    #[must_use]
    pub fn status(&self) -> Status {
        if self.grid == self.solution {
            Status::Won
        } else {
            Status::Playing
        }
    }

    #[must_use]
    pub fn grid(&self) -> &Grid {
        &self.grid
    }

    #[must_use]
    pub fn mistakes(&self) -> u16 {
        self.mistakes
    }

    /// Cells holding a number that isn't the solution's.
    #[must_use]
    pub fn wrong_cells(&self) -> Vec<usize> {
        (0..CELLS)
            .filter(|&c| self.grid[c] != 0 && self.grid[c] != self.solution[c])
            .collect()
    }

    /// 3 without mistakes, 2 with one or two, 1 otherwise.
    #[must_use]
    pub fn stars(&self) -> u8 {
        match self.mistakes {
            0 => 3,
            1 | 2 => 2,
            _ => 1,
        }
    }

    /// The next step a person could find, ignoring numbers that are wrong.
    #[must_use]
    pub fn hint(&self) -> Option<logic::Hint> {
        let mut known = self.grid;
        for c in self.wrong_cells() {
            known[c] = 0;
        }
        logic::hint(&known, &self.solution)
    }
}

/// Replays `moves` (`(cell, digit)`) from the start. Fails with the first illegal move's index.
pub fn replay(level: &Level, moves: &[(u8, u8)]) -> Result<Game, (usize, MoveError)> {
    if moves.len() > MAX_MOVES {
        return Err((MAX_MOVES, MoveError::TooManyMoves));
    }
    let mut game = Game::new(level).map_err(|_| (0, MoveError::NoSuchCell))?;
    for (i, &(cell, digit)) in moves.iter().enumerate() {
        game.set(usize::from(cell), digit).map_err(|e| (i, e))?;
    }
    Ok(game)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub const PUZZLE: &str =
        "530070000600195000098000060800060003400803001700020006060000280000419005000080079";
    pub const SOLUTION: &str =
        "534678912672195348198342567859761423426853791713924856961537284287419635345286179";

    pub fn level() -> Level {
        Level {
            puzzle: PUZZLE.into(),
            solution: SOLUTION.into(),
        }
    }

    /// Every empty cell filled with the solution's number.
    pub fn solving_moves() -> Vec<(u8, u8)> {
        let (p, s) = level().grids().unwrap();
        (0..CELLS)
            .filter(|&c| p[c] == 0)
            .map(|c| (c as u8, s[c]))
            .collect()
    }

    #[test]
    fn levels_are_validated() {
        assert!(level().validate().is_ok());
        let mut wrong_given = level();
        wrong_given.puzzle.replace_range(0..1, "4");
        assert!(wrong_given.validate().is_err());
        let mut broken = level();
        broken.solution.replace_range(0..2, "35");
        assert!(broken.validate().is_err());
        // Clearing givens until two solutions fit.
        let open = Level {
            puzzle: "0".repeat(CELLS),
            ..level()
        };
        assert!(open.validate().is_err());
        let short = Level {
            puzzle: PUZZLE[..80].into(),
            ..level()
        };
        assert!(short.validate().is_err());
    }

    #[test]
    fn filling_in_the_solution_wins_with_three_stars() {
        let game = replay(&level(), &solving_moves()).unwrap();
        assert_eq!(game.status(), Status::Won);
        assert_eq!((game.mistakes(), game.stars()), (0, 3));
    }

    #[test]
    fn wrong_numbers_cost_stars_even_when_fixed() {
        let mut g = Game::new(&level()).unwrap();
        // Cell 2 is a 4 in the solution.
        assert_eq!(g.set(2, 1), Ok(false));
        assert_eq!(
            g.set(2, 1),
            Ok(false),
            "the same number again is no new mistake"
        );
        assert_eq!(g.wrong_cells(), vec![2]);
        assert_eq!(g.set(2, 0), Ok(false));
        assert_eq!(g.set(2, 4), Ok(true));
        assert!(g.wrong_cells().is_empty());
        g.set(3, 9).unwrap();
        g.set(3, 8).unwrap();
        assert_eq!((g.mistakes(), g.stars()), (3, 1));
    }

    #[test]
    fn illegal_moves_are_rejected() {
        let mut g = Game::new(&level()).unwrap();
        assert_eq!(g.set(0, 1), Err(MoveError::Given));
        assert_eq!(g.set(81, 1), Err(MoveError::NoSuchCell));
        assert_eq!(g.set(2, 10), Err(MoveError::BadDigit));
        let mut moves = solving_moves();
        moves.push((2, 0));
        assert_eq!(
            replay(&level(), &moves).unwrap_err(),
            (moves.len() - 1, MoveError::NotPlaying)
        );
    }

    #[test]
    fn hints_ignore_wrong_numbers() {
        let mut g = Game::new(&level()).unwrap();
        g.set(2, 1).unwrap();
        let hint = g.hint().unwrap();
        let (_, s) = level().grids().unwrap();
        assert_eq!(hint.digit, s[hint.cell]);
    }

    #[test]
    fn consistency_spots_repeats() {
        let (p, _) = level().grids().unwrap();
        assert!(consistent(&p));
        let mut twice = p;
        twice[2] = 5; // row 0 already has a 5
        assert!(!consistent(&twice));
    }
}
