//! Fixed-size, allocation-free board used by the solver.
//!
//! Cells store `colour + 1`; `0` means empty. Each bottle is `CAPACITY` bytes, bottom first.

use super::{Board, Move, MoveError, CAPACITY, MAX_BOTTLES};

pub(super) const KEY_LEN: usize = MAX_BOTTLES * CAPACITY;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(super) struct Packed {
    n: u8,
    cells: [u8; KEY_LEN],
}

impl Packed {
    pub(super) fn from_board(board: &Board) -> Self {
        let mut cells = [0u8; KEY_LEN];
        for (i, bottle) in board.bottles.iter().take(MAX_BOTTLES).enumerate() {
            for (j, &c) in bottle.iter().take(CAPACITY).enumerate() {
                cells[i * CAPACITY + j] = c.saturating_add(1);
            }
        }
        let n = u8::try_from(board.bottles.len().min(MAX_BOTTLES)).expect("MAX_BOTTLES fits u8");
        Self { n, cells }
    }

    pub(super) fn bottles(&self) -> usize {
        usize::from(self.n)
    }

    fn bottle(&self, i: usize) -> &[u8] {
        &self.cells[i * CAPACITY..(i + 1) * CAPACITY]
    }

    fn len(&self, i: usize) -> usize {
        self.bottle(i).iter().take_while(|c| **c != 0).count()
    }

    fn top(&self, i: usize) -> u8 {
        match self.len(i) {
            0 => 0,
            l => self.bottle(i)[l - 1],
        }
    }

    fn top_run(&self, i: usize) -> usize {
        let l = self.len(i);
        if l == 0 {
            return 0;
        }
        let bottle = self.bottle(i);
        let top = bottle[l - 1];
        bottle[..l].iter().rev().take_while(|c| **c == top).count()
    }

    fn is_mono(&self, i: usize) -> bool {
        let l = self.len(i);
        l > 0 && self.top_run(i) == l
    }

    fn is_complete(&self, i: usize) -> bool {
        self.len(i) == CAPACITY && self.is_mono(i)
    }

    pub(super) fn pour_amount(&self, from: usize, to: usize) -> Result<usize, MoveError> {
        let n = self.bottles();
        if from >= n || to >= n {
            return Err(MoveError::OutOfRange);
        }
        if from == to {
            return Err(MoveError::SameBottle);
        }
        let from_len = self.len(from);
        if from_len == 0 {
            return Err(MoveError::SourceEmpty);
        }
        let to_len = self.len(to);
        if to_len == CAPACITY {
            return Err(MoveError::TargetFull);
        }
        if to_len > 0 && self.top(to) != self.top(from) {
            return Err(MoveError::ColorMismatch);
        }
        Ok(self.top_run(from).min(CAPACITY - to_len))
    }

    pub(super) fn apply(&mut self, from: usize, to: usize, amount: usize) {
        let from_len = self.len(from);
        let to_len = self.len(to);
        let color = self.top(from);
        for k in 0..amount {
            self.cells[from * CAPACITY + from_len - 1 - k] = 0;
            self.cells[to * CAPACITY + to_len + k] = color;
        }
    }

    pub(super) fn is_solved(&self) -> bool {
        (0..self.bottles()).all(|i| self.len(i) == 0 || self.is_complete(i))
    }

    /// Admissible, consistent heuristic: total colour segments minus colours present.
    /// A pour merges at most one pair of segments, so each move lowers it by ≤ 1.
    pub(super) fn heuristic(&self) -> u32 {
        let mut segments = 0u32;
        let mut present = 0u32;
        for i in 0..self.bottles() {
            let mut prev = 0u8;
            for &c in &self.bottle(i)[..self.len(i)] {
                if c != prev {
                    segments += 1;
                    prev = c;
                }
                present |= 1 << c;
            }
        }
        segments - present.count_ones()
    }

    /// Canonical key: bottles sorted, so boards that differ only in bottle order collide.
    pub(super) fn key(&self) -> [u8; KEY_LEN] {
        let mut chunks = [[0u8; CAPACITY]; MAX_BOTTLES];
        for (i, chunk) in chunks.iter_mut().enumerate().take(self.bottles()) {
            chunk.copy_from_slice(self.bottle(i));
        }
        chunks[..self.bottles()].sort_unstable();
        let mut key = [0u8; KEY_LEN];
        for (i, chunk) in chunks.iter().enumerate() {
            key[i * CAPACITY..(i + 1) * CAPACITY].copy_from_slice(chunk);
        }
        key
    }

    /// Legal moves minus ones that can never help: pouring out of a finished
    /// bottle, moving a single-colour bottle into an empty one, and pouring into
    /// a second empty bottle when another empty one is already a target.
    pub(super) fn useful_moves(&self, out: &mut Vec<Move>) {
        out.clear();
        let n = self.bottles();
        for from in 0..n {
            if self.len(from) == 0 || self.is_complete(from) {
                continue;
            }
            let mut empty_target_used = false;
            for to in 0..n {
                if self.pour_amount(from, to).is_err() {
                    continue;
                }
                if self.len(to) == 0 {
                    if self.is_mono(from) || empty_target_used {
                        continue;
                    }
                    empty_target_used = true;
                }
                let pair = (u8::try_from(from), u8::try_from(to));
                if let (Ok(f), Ok(t)) = pair {
                    out.push((f, t));
                }
            }
        }
    }
}
