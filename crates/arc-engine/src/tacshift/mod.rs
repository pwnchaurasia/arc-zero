//! TacShift: tic-tac-toe in three rule sets (decision 2026-11-17, see the TacShift doc).
//!
//! - Classic: 3x3, three in a row wins, a full board is a draw.
//! - Infinity: 3x3, but each player keeps at most 3 marks. Placing a 4th removes that
//!   player's oldest. A game that runs to `MAX_PLIES` (it can cycle) is a draw.
//! - Ultimate: nine 3x3 boards in a 3x3 grid. The cell you play in sends your opponent
//!   to the matching board; a board that is won or full sends them anywhere ("free
//!   choice"). Three boards in a row wins; if every board closes without that, whoever
//!   owns more boards wins.
//!
//! X always moves first. Against the AI the player is X and the AI is O; the server
//! plays the AI with its own seed, so a win can't be faked.

pub mod ai;

use std::fmt;

use serde::{Deserialize, Serialize};

pub const EMPTY: u8 = 0;
pub const X: u8 = 1;
pub const O: u8 = 2;
/// An ultimate board that filled up without a winner.
pub const DRAWN: u8 = 3;
/// Infinity games can go round in circles; this many moves is a draw.
pub const MAX_PLIES: u16 = 150;
/// Marks each player keeps in Infinity.
pub const KEEP: usize = 3;

/// The 8 ways to make three in a row on a 3x3 grid.
pub const LINES: [[usize; 3]; 8] = [
    [0, 1, 2],
    [3, 4, 5],
    [6, 7, 8],
    [0, 3, 6],
    [1, 4, 7],
    [2, 5, 8],
    [0, 4, 8],
    [2, 4, 6],
];

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    Classic,
    Infinity,
    Ultimate,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Playing,
    XWon,
    OWon,
    Draw,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MoveError {
    NotPlaying,
    NoSuchCell,
    Taken,
    /// Ultimate: that board is closed, or another board is the one to play in.
    WrongBoard,
}

impl fmt::Display for MoveError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::NotPlaying => "the game is over",
            Self::NoSuchCell => "no such cell",
            Self::Taken => "that cell is taken",
            Self::WrongBoard => "that board can't be played now",
        })
    }
}

impl std::error::Error for MoveError {}

/// Three in a row for `who` in a 3x3 grid, if any.
fn line_of(grid: &[u8], who: u8) -> Option<[usize; 3]> {
    LINES
        .iter()
        .copied()
        .find(|l| l.iter().all(|&i| grid[i] == who))
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Game {
    pub mode: Mode,
    /// 9 cells, or 81 in Ultimate (`board * 9 + cell`): EMPTY, X or O.
    pub cells: Vec<u8>,
    /// Infinity: X's and O's marks, oldest first.
    pub queues: [Vec<u8>; 2],
    /// Ultimate: each board's state, EMPTY (open), X, O or DRAWN.
    pub boards: Vec<u8>,
    /// Ultimate: the board the next move must go in; `None` is free choice.
    pub active: Option<u8>,
    /// Whose move it is: X or O.
    pub turn: u8,
    pub status: Status,
    /// The winning line: cells, or boards in Ultimate. Empty otherwise.
    pub line: Vec<u8>,
    pub plies: u16,
}

/// What a move changed besides the new mark.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct Placed {
    /// Infinity: the oldest mark that left the board.
    pub vanished: Option<u8>,
    /// Ultimate: the board this move won or filled up.
    pub closed: Option<u8>,
}

impl Game {
    #[must_use]
    pub fn new(mode: Mode) -> Self {
        let n = if mode == Mode::Ultimate { 81 } else { 9 };
        Self {
            mode,
            cells: vec![EMPTY; n],
            queues: [Vec::new(), Vec::new()],
            boards: if mode == Mode::Ultimate {
                vec![EMPTY; 9]
            } else {
                Vec::new()
            },
            active: None,
            turn: X,
            status: Status::Playing,
            line: Vec::new(),
            plies: 0,
        }
    }

    /// Every cell the player to move may take, lowest first.
    #[must_use]
    pub fn legal_moves(&self) -> Vec<u8> {
        if self.status != Status::Playing {
            return Vec::new();
        }
        (0..self.cells.len() as u8)
            .filter(|&c| self.allowed(c).is_ok())
            .collect()
    }

    fn allowed(&self, cell: u8) -> Result<(), MoveError> {
        if self.status != Status::Playing {
            return Err(MoveError::NotPlaying);
        }
        let c = usize::from(cell);
        if c >= self.cells.len() {
            return Err(MoveError::NoSuchCell);
        }
        if self.cells[c] != EMPTY {
            return Err(MoveError::Taken);
        }
        if self.mode == Mode::Ultimate {
            let board = cell / 9;
            if self.boards[usize::from(board)] != EMPTY || self.active.is_some_and(|a| a != board) {
                return Err(MoveError::WrongBoard);
            }
        }
        Ok(())
    }

    /// The mark the player to move would lose by placing another (Infinity, 3 down).
    #[must_use]
    pub fn next_to_vanish(&self) -> Option<u8> {
        let q = &self.queues[usize::from(self.turn - 1)];
        (self.mode == Mode::Infinity && q.len() == KEEP).then(|| q[0])
    }

    pub fn play(&mut self, cell: u8) -> Result<Placed, MoveError> {
        self.allowed(cell)?;
        let me = self.turn;
        let mut placed = Placed::default();
        self.cells[usize::from(cell)] = me;
        match self.mode {
            Mode::Classic => {
                if let Some(l) = line_of(&self.cells, me) {
                    self.finish_won(me, l.iter().map(|&i| i as u8).collect());
                } else if self.cells.iter().all(|&c| c != EMPTY) {
                    self.status = Status::Draw;
                }
            }
            Mode::Infinity => {
                let q = &mut self.queues[usize::from(me - 1)];
                if q.len() == KEEP {
                    let old = q.remove(0);
                    self.cells[usize::from(old)] = EMPTY;
                    placed.vanished = Some(old);
                }
                q.push(cell);
                if let Some(l) = line_of(&self.cells, me) {
                    self.finish_won(me, l.iter().map(|&i| i as u8).collect());
                }
            }
            Mode::Ultimate => {
                let board = usize::from(cell / 9);
                let sub = &self.cells[board * 9..board * 9 + 9];
                if line_of(sub, me).is_some() {
                    self.boards[board] = me;
                    placed.closed = Some(board as u8);
                } else if sub.iter().all(|&c| c != EMPTY) {
                    self.boards[board] = DRAWN;
                    placed.closed = Some(board as u8);
                }
                if let Some(l) = line_of(&self.boards, me) {
                    self.finish_won(me, l.iter().map(|&i| i as u8).collect());
                } else if self.boards.iter().all(|&b| b != EMPTY) {
                    // Every board closed without three in a row: most boards wins.
                    let owned = |p: u8| self.boards.iter().filter(|&&b| b == p).count();
                    self.status = match owned(X).cmp(&owned(O)) {
                        std::cmp::Ordering::Greater => Status::XWon,
                        std::cmp::Ordering::Less => Status::OWon,
                        std::cmp::Ordering::Equal => Status::Draw,
                    };
                }
                let target = cell % 9;
                self.active = (self.boards[usize::from(target)] == EMPTY).then_some(target);
            }
        }
        self.plies += 1;
        if self.status == Status::Playing && self.plies >= MAX_PLIES {
            self.status = Status::Draw;
        }
        self.turn = if me == X { O } else { X };
        Ok(placed)
    }

    fn finish_won(&mut self, who: u8, line: Vec<u8>) {
        self.status = if who == X { Status::XWon } else { Status::OWon };
        self.line = line;
    }

    #[must_use]
    pub fn winner(&self) -> Option<u8> {
        match self.status {
            Status::XWon => Some(X),
            Status::OWon => Some(O),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn play_all(mode: Mode, cells: &[u8]) -> Game {
        let mut g = Game::new(mode);
        for &c in cells {
            g.play(c).unwrap();
        }
        g
    }

    #[test]
    fn classic_wins_and_draws() {
        let g = play_all(Mode::Classic, &[0, 3, 1, 4, 2]);
        assert_eq!((g.status, g.line.clone()), (Status::XWon, vec![0, 1, 2]));
        assert!(g.legal_moves().is_empty());
        let draw = play_all(Mode::Classic, &[0, 1, 2, 4, 3, 5, 7, 6, 8]);
        assert_eq!(draw.status, Status::Draw);
        let mut g = Game::new(Mode::Classic);
        g.play(4).unwrap();
        assert_eq!(g.play(4), Err(MoveError::Taken));
        assert_eq!(g.play(9), Err(MoveError::NoSuchCell));
    }

    #[test]
    fn infinity_keeps_three_marks_each() {
        let mut g = play_all(Mode::Infinity, &[0, 4, 8, 2, 6, 3]);
        assert_eq!(g.next_to_vanish(), Some(0), "X's oldest mark goes next");
        let placed = g.play(5).unwrap();
        assert_eq!(placed.vanished, Some(0));
        assert_eq!(g.cells[0], EMPTY);
        assert_eq!(g.queues[0], vec![8, 6, 5]);
        // O's oldest (4) leaves as O plays 0.
        g.play(0).unwrap();
        assert_eq!(g.cells[4], EMPTY);
        assert_eq!(g.status, Status::Playing);

        // A win can come from the move that makes a mark vanish: X holds 5, 0, 1 and
        // plays 2, losing 5 and lining up 0, 1, 2.
        let w = play_all(Mode::Infinity, &[5, 3, 0, 4, 1, 8, 2]);
        assert_eq!((w.status, w.line.clone()), (Status::XWon, vec![0, 1, 2]));
        assert_eq!(w.cells[5], EMPTY);
    }

    #[test]
    fn infinity_ends_in_a_draw_after_too_many_moves() {
        let mut g = Game::new(Mode::Infinity);
        // Both players shuffle marks that never line up.
        let cycle = [0, 1, 5, 2, 6, 3, 7, 8];
        let mut i = 0;
        while g.status == Status::Playing {
            let legal = g.legal_moves();
            let c = cycle
                .iter()
                .copied()
                .cycle()
                .skip(i)
                .find(|c| legal.contains(c))
                .unwrap();
            let mut probe = g.clone();
            probe.play(c).unwrap();
            if probe.winner().is_some() {
                // Avoid an accidental win: take any other legal cell that doesn't win.
                let alt = legal
                    .iter()
                    .copied()
                    .find(|&o| {
                        let mut p = g.clone();
                        p.play(o).unwrap();
                        p.winner().is_none()
                    })
                    .unwrap();
                g.play(alt).unwrap();
            } else {
                g.play(c).unwrap();
            }
            i += 1;
            assert!(i <= usize::from(MAX_PLIES));
        }
        assert_eq!((g.status, g.plies), (Status::Draw, MAX_PLIES));
    }

    #[test]
    fn ultimate_sends_you_to_the_matching_board() {
        let mut g = Game::new(Mode::Ultimate);
        g.play(4 * 9 + 2).unwrap(); // X in the centre board, top-right cell
        assert_eq!(g.active, Some(2));
        assert_eq!(g.play(5 * 9), Err(MoveError::WrongBoard));
        g.play(2 * 9 + 4).unwrap(); // O must play in board 2; sends X to board 4
        assert_eq!(g.active, Some(4));
        assert!(g.legal_moves().iter().all(|c| c / 9 == 4));
    }

    #[test]
    fn ultimate_boards_close_and_free_choice_follows() {
        // X holds two of board 0's top row and is sent there.
        let mut h = Game::new(Mode::Ultimate);
        h.cells[0] = X;
        h.cells[1] = X;
        h.turn = X;
        h.active = Some(0);
        let placed = h.play(2).unwrap();
        assert_eq!(placed.closed, Some(0));
        assert_eq!(h.boards[0], X);
        // O is sent to board 2 (open): forced there.
        assert_eq!(h.active, Some(2));
        // Sending a player to a closed board gives free choice.
        h.play(2 * 9).unwrap(); // O plays cell 0 of board 2 -> X to board 0, which is closed
        assert_eq!(h.active, None);
        assert!(h.legal_moves().iter().all(|c| c / 9 != 0));
    }

    #[test]
    fn ultimate_win_by_three_boards_or_by_majority() {
        let mut g = Game::new(Mode::Ultimate);
        g.boards = vec![X, X, EMPTY, O, O, DRAWN, DRAWN, O, X];
        g.cells[2 * 9] = X;
        g.cells[2 * 9 + 1] = X;
        g.active = Some(2);
        g.play(2 * 9 + 2).unwrap();
        assert_eq!((g.status, g.line.clone()), (Status::XWon, vec![0, 1, 2]));

        let mut m = Game::new(Mode::Ultimate);
        m.boards = vec![X, O, X, O, X, O, O, X, EMPTY];
        m.cells[8 * 9] = O;
        m.cells[8 * 9 + 1] = O;
        m.turn = O;
        m.active = Some(8);
        // O wins board 8: no three boards in a row, but O owns 5 of 9.
        m.play(8 * 9 + 2).unwrap();
        assert_eq!(m.status, Status::OWon);
        assert!(m.line.is_empty());
    }
}
