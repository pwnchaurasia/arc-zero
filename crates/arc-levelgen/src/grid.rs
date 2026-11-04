//! GridSnap level pipeline (decision 2026-11-04).
//!
//! A level is a starting board: "stone" blocks to clear (all of them wins) plus, from
//! level 4, coloured clutter that takes up room. Levels 1–3 line the stones up so the
//! first clears are obvious; later stones come in small clusters spread over the board.
//! The tray is dealt at a fixed difficulty stage that rises with the level.
//!
//! Every candidate is played by the greedy bot, then 10 more times by a bot that plays
//! like a person (it sometimes takes a lesser move, which also changes the trays it is
//! dealt). Only levels most of those players clear are kept, so a level never depends
//! on one lucky line of play. The players' median shape count becomes the par (3 stars
//! at or under it). Of the kept candidates, the one whose par is closest to the target
//! wins.

use arc_engine::gridsnap::{
    bot, cell_count, full_lines, mask_at, Game, Status, COLORS, SHAPES, SIZE, STONE,
};
use arc_engine::rng::Rng;
use rayon::prelude::*;
use serde::Serialize;

use crate::derive_seed;

const CANDIDATES: usize = 40;
/// The bot must clear a level within this many shapes.
const MAX_PLACEMENTS: u32 = 120;
/// Shapes used to lay stones and clutter: up to 4 cells.
const SMALL: u32 = 4;
/// Person-like plays per candidate.
const PLAYERS: u32 = 10;
/// Never keep a level fewer than this many of them clear (the fallback when no
/// candidate reaches `required_wins`, so a release can't fail on an unlucky seed).
const MIN_WINS: u32 = 5;

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

/// Of `PLAYERS` person-like plays, how many must clear the level: nearly all early on,
/// most of them at the end.
fn required_wins(level: u16) -> u32 {
    match level {
        0..=30 => 9,
        31..=70 => 8,
        _ => 7,
    }
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
        clutter: lerp(0.0, 9.0, t).round() as usize,
        stage: lerp(10.0, 72.0, t).round() as u32,
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

/// A level the greedy bot clears, with how many person-like players cleared it too.
fn candidate(level: u16, seed: u64) -> Option<(GsLevel, u32)> {
    let p = params(level);
    let mut rng = Rng::new(seed);
    let cells = board(&mut rng, level, &p);
    // The deal's own seed, kept within 53 bits like every seed in the levels files.
    let deal = rng.next_u64() & ((1 << 53) - 1);
    let game = Game::level(deal, p.stage, cells.clone()).ok()?;
    if bot::play_from(game.clone(), MAX_PLACEMENTS).board.status != Status::Won {
        return None;
    }
    let mut wins: Vec<u32> = (0..PLAYERS)
        .map(|k| bot::play_like_a_person(game.clone(), MAX_PLACEMENTS, deal ^ u64::from(k + 1)))
        .filter(|g| g.board.status == Status::Won)
        .map(|g| g.board.placed)
        .collect();
    let won = wins.len() as u32;
    if won < MIN_WINS {
        return None;
    }
    wins.sort_unstable();
    let par = wins[wins.len() / 2];
    Some((
        GsLevel {
            level,
            seed: deal,
            stage: p.stage,
            cells,
            par,
        },
        won,
    ))
}

pub fn generate(master: &str, max_level: u16) -> Vec<GsLevel> {
    (1..=max_level)
        .into_par_iter()
        .map(|level| {
            let target = params(level).par;
            let found: Vec<(GsLevel, u32)> = (0..CANDIDATES)
                .filter_map(|i| {
                    let seed = derive_seed(master, &["gs", &level.to_string(), &i.to_string()]);
                    candidate(level, seed)
                })
                .collect();
            // Of those most players clear, the par nearest the target; failing that, the
            // one the most players clear.
            let closest = found
                .iter()
                .filter(|(_, won)| *won >= required_wins(level))
                .min_by(|(a, _), (b, _)| {
                    (f64::from(a.par) - target)
                        .abs()
                        .total_cmp(&(f64::from(b.par) - target).abs())
                });
            let (best, won) = closest
                .or_else(|| found.iter().max_by_key(|(_, won)| *won))
                .cloned()
                .unwrap_or_else(|| panic!("gridsnap level {level}: no candidate players can clear"));
            eprintln!(
                "  gs level {level}: {} stones, stage {}, par {} (target {target:.0}), {won}/{PLAYERS} players clear it",
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
            .find_map(|s| candidate(1, s).map(|(l, _)| l))
            .expect("level 1");
        let hard = (0..CANDIDATES as u64)
            .find_map(|s| candidate(80, s).map(|(l, _)| l))
            .expect("level 80");
        let stones = |l: &GsLevel| l.cells.iter().filter(|c| **c == STONE).count();
        assert_eq!(stones(&easy), 4);
        assert!(stones(&hard) > stones(&easy));
        assert!(easy.stage < hard.stage);
        // Most person-like players clear it, not just one lucky line.
        let game = Game::level(hard.seed, hard.stage, hard.cells.clone()).unwrap();
        let wins = (0..PLAYERS)
            .filter(|k| {
                let g = bot::play_like_a_person(game.clone(), MAX_PLACEMENTS, u64::from(*k) + 100);
                g.board.status == Status::Won
            })
            .count();
        assert!(wins >= 6, "only {wins} of {PLAYERS} cleared level 80");
    }
}
