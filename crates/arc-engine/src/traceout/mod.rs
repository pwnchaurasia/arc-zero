//! TraceOut: tap a line to send it out of the board along its arrow.
//!
//! Rules (see the TraceOut design doc):
//! - A line is a path of orthogonally adjacent cells, tail first; its arrow
//!   points from the second-to-last cell to the last (the head).
//! - A tapped line leaves when every cell from its head to the board edge, in
//!   the arrow's direction, is free of every remaining line (its own body
//!   included). Otherwise it bounces back and the player loses a droplet.
//! - Out of droplets: the level stops, unless a continue (paid) refills them.
//! - Won when every line has left.
//!
//! Removing a line only ever frees cells, so a level is solvable exactly when
//! repeatedly removing any free line clears the board ([`Level::solvable`]).

use std::fmt;

use serde::{Deserialize, Serialize};

pub const MIN_SIDE: u8 = 4;
pub const MAX_SIDE: u8 = 40;
pub const MAX_LINES: usize = 200;
pub const MAX_LINE_LEN: usize = 48;
pub const LIVES: u8 = 3;
pub const MAX_CONTINUES: u8 = 5;
/// Every line leaves once, plus mistakes and continues; generous but bounded.
pub const MAX_MOVES: usize = MAX_LINES * 3 + 64;

pub const OP_TAP: u8 = 0;
pub const OP_CONTINUE: u8 = 1;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Line {
    /// `[x, y]` per cell, tail first, head last.
    pub cells: Vec<[u8; 2]>,
}

impl Line {
    #[must_use]
    pub fn head(&self) -> [u8; 2] {
        self.cells.last().copied().unwrap_or([0, 0])
    }

    /// The arrow's direction, `(dx, dy)`.
    #[must_use]
    pub fn dir(&self) -> (i16, i16) {
        let n = self.cells.len();
        if n < 2 {
            return (0, 0);
        }
        let [hx, hy] = self.cells[n - 1];
        let [px, py] = self.cells[n - 2];
        (i16::from(hx) - i16::from(px), i16::from(hy) - i16::from(py))
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Level {
    pub width: u8,
    pub height: u8,
    pub lines: Vec<Line>,
    /// The picture the lines form on silhouette levels ("heart", "diamond", ...).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub theme: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LevelError(pub String);

impl fmt::Display for LevelError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "invalid level: {}", self.0)
    }
}

impl std::error::Error for LevelError {}

impl Level {
    pub fn validate(&self) -> Result<(), LevelError> {
        let bad = |m: &str| Err(LevelError(m.to_owned()));
        let sides = MIN_SIDE..=MAX_SIDE;
        if !sides.contains(&self.width) || !sides.contains(&self.height) {
            return bad("board size");
        }
        if self.lines.is_empty() || self.lines.len() > MAX_LINES {
            return bad("line count");
        }
        if self.theme.as_ref().is_some_and(|t| t.len() > 24) {
            return bad("theme");
        }
        let mut used = vec![false; usize::from(self.width) * usize::from(self.height)];
        for line in &self.lines {
            if !(2..=MAX_LINE_LEN).contains(&line.cells.len()) {
                return bad("line length");
            }
            for (i, &[x, y]) in line.cells.iter().enumerate() {
                if x >= self.width || y >= self.height {
                    return bad("cell off the board");
                }
                let idx = usize::from(y) * usize::from(self.width) + usize::from(x);
                if std::mem::replace(&mut used[idx], true) {
                    return bad("lines overlap");
                }
                if i > 0 {
                    let [px, py] = line.cells[i - 1];
                    if px.abs_diff(x) + py.abs_diff(y) != 1 {
                        return bad("line cells must touch side by side");
                    }
                }
            }
        }
        if !self.solvable() {
            return bad("not solvable");
        }
        Ok(())
    }

    /// Whether every line can leave in some order (removing a line never blocks another).
    #[must_use]
    pub fn solvable(&self) -> bool {
        self.depth().is_some()
    }

    /// Rounds needed when every free line leaves at once each round: a measure
    /// of how long the "clear this first" chains are. `None` if unsolvable.
    #[must_use]
    pub fn depth(&self) -> Option<usize> {
        let Ok(mut game) = Game::new(self) else {
            return None;
        };
        let mut rounds = 0;
        while game.remaining() > 0 {
            let free = game.free_lines();
            if free.is_empty() {
                return None;
            }
            for i in free {
                game.remove(i);
            }
            rounds += 1;
        }
        Some(rounds)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Playing,
    Won,
    /// Out of droplets: only a continue helps.
    Out,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    Exited,
    /// Bounced off this line; a droplet was lost.
    Blocked {
        by: usize,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MoveError {
    NoSuchLine,
    AlreadyGone,
    NotPlaying,
    StillHasLives,
    TooManyContinues,
    TooManyMoves,
    UnknownOp,
}

impl fmt::Display for MoveError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::NoSuchLine => "no such line",
            Self::AlreadyGone => "that line has already left",
            Self::NotPlaying => "the level is not in play",
            Self::StillHasLives => "droplets left: nothing to continue",
            Self::TooManyContinues => "no more continues",
            Self::TooManyMoves => "too many moves",
            Self::UnknownOp => "unknown move",
        })
    }
}

impl std::error::Error for MoveError {}

#[derive(Clone, Debug)]
pub struct Game {
    level: Level,
    /// Line index + 1 per cell, 0 when free.
    grid: Vec<u16>,
    present: Vec<bool>,
    remaining: usize,
    lives: u8,
    mistakes: u16,
    continues: u8,
    moves: usize,
}

impl Game {
    pub fn new(level: &Level) -> Result<Self, LevelError> {
        let (w, h) = (usize::from(level.width), usize::from(level.height));
        let mut grid = vec![0u16; w * h];
        for (i, line) in level.lines.iter().enumerate() {
            let id = u16::try_from(i + 1).map_err(|_| LevelError("line count".into()))?;
            for &[x, y] in &line.cells {
                let idx = usize::from(y) * w + usize::from(x);
                let slot = grid
                    .get_mut(idx)
                    .ok_or_else(|| LevelError("cell off the board".into()))?;
                *slot = id;
            }
        }
        Ok(Self {
            level: level.clone(),
            grid,
            present: vec![true; level.lines.len()],
            remaining: level.lines.len(),
            lives: LIVES,
            mistakes: 0,
            continues: 0,
            moves: 0,
        })
    }

    #[must_use]
    pub fn level(&self) -> &Level {
        &self.level
    }

    /// The first remaining line in the way of line `i`'s exit, or `None` if it can leave.
    #[must_use]
    pub fn blocker(&self, i: usize) -> Option<usize> {
        let line = &self.level.lines[i];
        let (dx, dy) = line.dir();
        let [hx, hy] = line.head();
        let (mut x, mut y) = (i16::from(hx), i16::from(hy));
        let (w, h) = (i16::from(self.level.width), i16::from(self.level.height));
        loop {
            x += dx;
            y += dy;
            if x < 0 || y < 0 || x >= w || y >= h || (dx, dy) == (0, 0) {
                return None;
            }
            #[allow(clippy::cast_sign_loss)]
            let id = self.grid[y as usize * w as usize + x as usize];
            if id != 0 {
                return Some(usize::from(id - 1));
            }
        }
    }

    /// Lines that can leave right now, lowest index first.
    #[must_use]
    pub fn free_lines(&self) -> Vec<usize> {
        (0..self.present.len())
            .filter(|i| self.present[*i] && self.blocker(*i).is_none())
            .collect()
    }

    fn remove(&mut self, i: usize) {
        for &[x, y] in &self.level.lines[i].cells {
            self.grid[usize::from(y) * usize::from(self.level.width) + usize::from(x)] = 0;
        }
        self.present[i] = false;
        self.remaining -= 1;
    }

    fn count_move(&mut self) -> Result<(), MoveError> {
        if self.moves >= MAX_MOVES {
            return Err(MoveError::TooManyMoves);
        }
        self.moves += 1;
        Ok(())
    }

    pub fn tap(&mut self, i: usize) -> Result<Outcome, MoveError> {
        if i >= self.present.len() {
            return Err(MoveError::NoSuchLine);
        }
        if self.status() != Status::Playing {
            return Err(MoveError::NotPlaying);
        }
        if !self.present[i] {
            return Err(MoveError::AlreadyGone);
        }
        self.count_move()?;
        match self.blocker(i) {
            None => {
                self.remove(i);
                Ok(Outcome::Exited)
            }
            Some(by) => {
                self.lives -= 1;
                self.mistakes += 1;
                Ok(Outcome::Blocked { by })
            }
        }
    }

    /// Refills the droplets after running out (paid; the server checks the purchase).
    pub fn revive(&mut self) -> Result<(), MoveError> {
        if self.status() != Status::Out {
            return Err(MoveError::StillHasLives);
        }
        if self.continues >= MAX_CONTINUES {
            return Err(MoveError::TooManyContinues);
        }
        self.count_move()?;
        self.continues += 1;
        self.lives = LIVES;
        Ok(())
    }

    pub fn apply(&mut self, (op, line): (u8, u8)) -> Result<Option<Outcome>, MoveError> {
        match op {
            OP_TAP => self.tap(usize::from(line)).map(Some),
            OP_CONTINUE => self.revive().map(|()| None),
            _ => Err(MoveError::UnknownOp),
        }
    }

    #[must_use]
    pub fn status(&self) -> Status {
        if self.remaining == 0 {
            Status::Won
        } else if self.lives == 0 {
            Status::Out
        } else {
            Status::Playing
        }
    }

    #[must_use]
    pub fn present(&self, i: usize) -> bool {
        self.present.get(i).copied().unwrap_or(false)
    }

    #[must_use]
    pub fn remaining(&self) -> usize {
        self.remaining
    }

    #[must_use]
    pub fn lives(&self) -> u8 {
        self.lives
    }

    #[must_use]
    pub fn mistakes(&self) -> u16 {
        self.mistakes
    }

    #[must_use]
    pub fn continues(&self) -> u8 {
        self.continues
    }

    /// 3 with no mistakes, 2 with one, 1 otherwise.
    #[must_use]
    pub fn stars(&self) -> u8 {
        match self.mistakes {
            0 => 3,
            1 => 2,
            _ => 1,
        }
    }
}

/// Replays `moves` from the start. Fails with the index of the first illegal move.
pub fn replay(level: &Level, moves: &[(u8, u8)]) -> Result<Game, (usize, MoveError)> {
    if moves.len() > MAX_MOVES {
        return Err((MAX_MOVES, MoveError::TooManyMoves));
    }
    let mut game = Game::new(level).map_err(|_| (0, MoveError::NotPlaying))?;
    for (i, m) in moves.iter().enumerate() {
        game.apply(*m).map_err(|e| (i, e))?;
    }
    Ok(game)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Line 0 points up and is blocked by line 1 (a bar across its path), which points right.
    fn level() -> Level {
        Level {
            width: 5,
            height: 5,
            lines: vec![
                Line {
                    cells: vec![[2, 4], [2, 3]],
                },
                Line {
                    cells: vec![[1, 1], [2, 1], [3, 1]],
                },
                Line {
                    cells: vec![[0, 4], [0, 3]],
                },
            ],
            theme: None,
        }
    }

    #[test]
    fn a_free_line_leaves_and_a_blocked_one_costs_a_droplet() {
        let mut g = Game::new(&level()).unwrap();
        assert_eq!(g.blocker(0), Some(1));
        assert_eq!(g.tap(0), Ok(Outcome::Blocked { by: 1 }));
        assert_eq!((g.lives(), g.mistakes()), (2, 1));
        assert_eq!(g.tap(1), Ok(Outcome::Exited));
        assert_eq!(g.tap(1), Err(MoveError::AlreadyGone));
        assert_eq!(g.tap(0), Ok(Outcome::Exited));
        assert_eq!(g.tap(2), Ok(Outcome::Exited));
        assert_eq!(g.status(), Status::Won);
        assert_eq!(g.stars(), 2);
    }

    #[test]
    fn out_of_droplets_needs_a_continue() {
        let mut g = Game::new(&level()).unwrap();
        for _ in 0..3 {
            g.tap(0).unwrap();
        }
        assert_eq!(g.status(), Status::Out);
        assert_eq!(g.tap(1), Err(MoveError::NotPlaying));
        g.revive().unwrap();
        assert_eq!(g.revive(), Err(MoveError::StillHasLives));
        assert_eq!(g.lives(), LIVES);
        assert_eq!(g.stars(), 1);
        let won = replay(
            &level(),
            &[(0, 0), (0, 0), (0, 0), (1, 0), (0, 1), (0, 0), (0, 2)],
        )
        .unwrap();
        assert_eq!((won.status(), won.continues()), (Status::Won, 1));
    }

    #[test]
    fn levels_are_validated() {
        assert!(level().validate().is_ok());
        assert_eq!(level().depth(), Some(2));
        let mut broken = level();
        broken.lines[1].cells[1] = [2, 3]; // overlaps line 0
        assert!(broken.validate().is_err());
        let mut gap = level();
        gap.lines[1].cells[2] = [4, 1];
        assert!(gap.validate().is_err());
        // Two lines pointing into each other can never leave.
        let deadlock = Level {
            width: 4,
            height: 4,
            lines: vec![
                Line {
                    cells: vec![[0, 1], [1, 1]],
                },
                Line {
                    cells: vec![[3, 1], [2, 1]],
                },
            ],
            theme: None,
        };
        assert!(!deadlock.solvable());
        // A line pointing back into its own body is stuck.
        let curl = Level {
            width: 4,
            height: 4,
            lines: vec![Line {
                cells: vec![[1, 2], [1, 1], [2, 1], [2, 2], [2, 3]],
            }],
            theme: None,
        };
        assert!(curl.solvable(), "pointing down and out is fine");
        let mut inward = curl.clone();
        // Head [2, 2] points left, into its own body at [1, 2].
        inward.lines[0].cells = vec![[1, 3], [1, 2], [1, 1], [2, 1], [3, 1], [3, 2], [2, 2]];
        assert!(!inward.solvable());
    }

    #[test]
    fn replays_reject_bad_moves() {
        assert_eq!(
            replay(&level(), &[(0, 9)]).unwrap_err(),
            (0, MoveError::NoSuchLine)
        );
        assert_eq!(
            replay(&level(), &[(1, 0)]).unwrap_err(),
            (0, MoveError::StillHasLives)
        );
        assert_eq!(
            replay(&level(), &[(7, 0)]).unwrap_err(),
            (0, MoveError::UnknownOp)
        );
    }
}
