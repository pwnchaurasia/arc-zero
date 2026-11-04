//! GridSnap level pipeline (decision 2026-11-04).
//!
//! A level is a starting board: "stone" blocks to clear (all of them wins) plus, from
//! level 4, coloured clutter that takes up room. Levels 1–3 line the stones up so the
//! first clears are obvious; later stones come in small clusters spread over the board.
//! The tray is dealt at a fixed difficulty stage that rises with the level.
//!
//! Every candidate is played by the greedy bot; only ones it clears are kept, and its
//! shape count becomes the level's par (3 stars at or under it). Of the cleared
//! candidates, the one whose par is closest to the level's target wins.

use arc_engine::gridsnap::{
    bot, cell_count, full_lines, mask_at, Game, Status, COLORS, SHAPES, SIZE, STONE,
};
use arc_engine::rng::Rng;
use rayon::prelude::*;
use serde::Serialize;

use crate::derive_seed;

const CANDIDATES: usize = 24;
/// The bot must clear a level within this many shapes.
const MAX_PLACEMENTS: u32 = 120;
/// Shapes used to lay stones and clutter: up to 4 cells.
const SMALL: u32 = 4;

#[derive(Clone, Debug, Serialize)]
pub struct GsLevel {
    pub level: u16,
    /// The deal's seed: server-only, like the file itself.
    pub seed: u64,
    /// Difficulty stage of the deal, 0–100.
    pub stage: u32,
    /// Starting board, row by row: 0 empty, 1–7 a coloured block, 8 a stone.
    pub cells: Vec<u8>,
    /// Shapes the bot needed: 3 stars at or under this.
    pub par: u32,
}

struct Params {
    stones: usize,
    clutter: usize,
    stage: u32,
    par: f64,
}

fn lerp(a: f64, b: f64, t: f64) -> f64 {
    a + (b - a) * t
}

fn params(level: u16) -> Params {
    if level <= 3 {
        let l = usize::from(level);
        return Params {
            stones: [4, 5, 6][l - 1],
            clutter: 0,
            stage: [0, 0, 5][l - 1],
            par: [2.0, 3.0, 4.0][l - 1],
        };
    }
    let t = (f64::from(level) - 4.0) / 96.0;
    Params {
        stones: lerp(7.0, 22.0, t).round() as usize,
        clutter: lerp(0.0, 12.0, t).round() as usize,
        stage: lerp(10.0, 80.0, t).round() as u32,
        par: lerp(6.0, 30.0, t),
    }
}

/// Drops `value` on every cell of `mask` if they are free and no row or column fills up.
fn try_lay(cells: &mut [u8], mask: u64, value: u8) -> bool {
    let occupied = cells
        .iter()
        .enumerate()
        .filter(|(_, c)| **c != 0)
        .fold(0u64, |m, (i, _)| m | 1 << i);
    if mask & occupied != 0 || full_lines(occupied | mask) != (0, 0) {
        return false;
    }
    for (i, cell) in cells.iter_mut().enumerate() {
        if mask & (1 << i) != 0 {
            *cell = value;
        }
    }
    true
}

/// Lays about `count` cells of `value` as small shapes at random spots.
fn scatter(rng: &mut Rng, cells: &mut [u8], count: usize, value: impl Fn(&mut Rng) -> u8) {
    let small: Vec<u8> = (0..SHAPES.len() as u8)
        .filter(|s| cell_count(*s) <= SMALL)
        .collect();
    let mut laid = 0;
    for _ in 0..400 {
        if laid >= count {
            break;
        }
        let shape = small[rng.below(small.len() as u64) as usize];
        if laid + cell_count(shape) as usize > count + 1 {
            continue;
        }
        let row = rng.below(SIZE as u64) as u8;
        let col = rng.below(SIZE as u64) as u8;
        let Some(mask) = mask_at(shape, row, col) else {
            continue;
        };
        let v = value(rng);
        if try_lay(cells, mask, v) {
            laid += cell_count(shape) as usize;
        }
    }
}

fn board(rng: &mut Rng, level: u16, p: &Params) -> Vec<u8> {
    let mut cells = vec![0u8; SIZE * SIZE];
    if level <= 3 {
        // A run of stones on one row (and on level 3 a column through it): one or
        // two well-placed shapes finish the line.
        let row = 4 + rng.below(4) as usize;
        let run = p.stones.min(5);
        let start = rng.below((SIZE - run + 1) as u64) as usize;
        for c in start..start + run {
            cells[row * SIZE + c] = STONE;
        }
        if p.stones > run {
            let col = (start + run / 2).min(SIZE - 1);
            for r in (0..row).rev().take(p.stones - run) {
                cells[r * SIZE + col] = STONE;
            }
        }
        return cells;
    }
    scatter(rng, &mut cells, p.stones, |_| STONE);
    scatter(rng, &mut cells, p.clutter, |rng| {
        1 + rng.below(u64::from(COLORS)) as u8
    });
    cells
}

fn candidate(level: u16, seed: u64) -> Option<GsLevel> {
    let p = params(level);
    let mut rng = Rng::new(seed);
    let cells = board(&mut rng, level, &p);
    // The deal's own seed, kept within 53 bits like every seed in the levels files.
    let deal = rng.next_u64() & ((1 << 53) - 1);
    let game = Game::level(deal, p.stage, cells.clone()).ok()?;
    let played = bot::play_from(game, MAX_PLACEMENTS);
    (played.board.status == Status::Won).then_some(GsLevel {
        level,
        seed: deal,
        stage: p.stage,
        cells,
        par: played.board.placed,
    })
}

pub fn generate(master: &str, max_level: u16) -> Vec<GsLevel> {
    (1..=max_level)
        .into_par_iter()
        .map(|level| {
            let target = params(level).par;
            let best = (0..CANDIDATES)
                .filter_map(|i| {
                    let seed = derive_seed(master, &["gs", &level.to_string(), &i.to_string()]);
                    candidate(level, seed)
                })
                .min_by(|a, b| {
                    (f64::from(a.par) - target)
                        .abs()
                        .total_cmp(&(f64::from(b.par) - target).abs())
                })
                .unwrap_or_else(|| panic!("gridsnap level {level}: the bot cleared no candidate"));
            eprintln!(
                "  gs level {level}: {} stones, stage {}, par {} (target {target:.0})",
                best.cells.iter().filter(|c| **c == STONE).count(),
                best.stage,
                best.par
            );
            best
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn levels_are_cleared_by_the_bot_and_grow() {
        let easy = (0..CANDIDATES as u64)
            .find_map(|s| candidate(1, s))
            .expect("level 1");
        let hard = (0..CANDIDATES as u64)
            .find_map(|s| candidate(80, s))
            .expect("level 80");
        let stones = |l: &GsLevel| l.cells.iter().filter(|c| **c == STONE).count();
        assert_eq!(stones(&easy), 4);
        assert!(stones(&hard) > stones(&easy));
        assert!(easy.stage < hard.stage);
        // The same board and seed always play out the same way.
        let again = bot::play_from(
            Game::level(hard.seed, hard.stage, hard.cells.clone()).unwrap(),
            MAX_PLACEMENTS,
        );
        assert_eq!(again.board.placed, hard.par);
    }
}
