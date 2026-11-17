//! Cipher9 (Sudoku) level pipeline (decision 2026-11-17).
//!
//! Each level is a random full grid with clues taken away in mirrored pairs, keeping
//! only removals that leave exactly one solution and that the tier's techniques can
//! still solve. A level is kept only when its hardest technique is the one its tier
//! teaches, so difficulty comes from the logic needed, not just the number of clues:
//!
//! | Levels | Tier     | Clues  | Hardest technique needed        |
//! |--------|----------|--------|---------------------------------|
//! | 1-20   | Warmup   | 48-38  | naked singles (1-3 extra clues) |
//! | 21-45  | Casual   | 37-32  | hidden singles                  |
//! | 46-75  | Tactical | 31-27  | naked pairs or locked candidates|
//! | 76-100 | Master   | 26-22  | X-Wing or XY-Wing               |

use arc_engine::cipher9::logic::{count_solutions, grade, Technique, PEERS};
use arc_engine::cipher9::{grid_text, Grid, Level, CELLS};
use arc_engine::rng::Rng;
use rayon::prelude::*;
use serde::Serialize;

use crate::derive_seed;

const MAX_ATTEMPTS: u32 = 4_000;
/// A level may keep a few more clues than its target when no more can go without
/// breaking uniqueness or the tier; more than this and the grid is tried again.
const CLUE_SLACK: usize = 3;

#[derive(Clone, Debug, Serialize)]
pub struct C9Level {
    pub level: u16,
    pub tier: &'static str,
    pub technique: &'static str,
    pub clues: usize,
    pub data: Level,
}

struct Tier {
    name: &'static str,
    /// The hardest technique a level must need: one of these.
    needs: &'static [Technique],
    clues: usize,
}

fn lerp(a: f64, b: f64, t: f64) -> f64 {
    a + (b - a) * t.clamp(0.0, 1.0)
}

fn tier(level: u16) -> Tier {
    let (name, needs, first, last, from, to): (_, &'static [Technique], _, _, _, _) = match level {
        0..=20 => ("warmup", &[Technique::NakedSingle], 44.0, 38.0, 4, 20),
        21..=45 => ("casual", &[Technique::HiddenSingle], 37.0, 32.0, 21, 45),
        46..=75 => (
            "tactical",
            &[Technique::NakedPair, Technique::LockedCandidates],
            31.0,
            27.0,
            46,
            75,
        ),
        _ => (
            "master",
            &[Technique::XWing, Technique::XyWing],
            26.0,
            22.0,
            76,
            100,
        ),
    };
    // Levels 1-3 are a gentle start: extra clues.
    let clues = match level {
        1 => 48,
        2 => 46,
        3 => 45,
        _ => {
            let t = f64::from(level.saturating_sub(from)) / f64::from(to - from);
            lerp(first, last, t).round() as usize
        }
    };
    Tier { name, needs, clues }
}

/// A random full grid.
fn full_grid(rng: &mut Rng) -> Grid {
    fn fill(g: &mut Grid, cell: usize, rng: &mut Rng) -> bool {
        if cell == CELLS {
            return true;
        }
        let mut digits: [u8; 9] = [1, 2, 3, 4, 5, 6, 7, 8, 9];
        rng.shuffle(&mut digits);
        for d in digits {
            if PEERS[cell].iter().all(|&p| g[p] != d) {
                g[cell] = d;
                if fill(g, cell + 1, rng) {
                    return true;
                }
            }
        }
        g[cell] = 0;
        false
    }
    let mut g = [0u8; CELLS];
    assert!(fill(&mut g, 0, rng), "an empty grid always fills");
    g
}

/// A puzzle from one seed, or `None` if it doesn't fit the tier.
fn candidate(level: u16, seed: u64) -> Option<C9Level> {
    let tier = tier(level);
    let hardest_allowed = *tier.needs.last().expect("every tier needs a technique");
    let mut rng = Rng::new(seed);
    let solution = full_grid(&mut rng);
    let mut puzzle = solution;
    // Mirrored pairs (cell, 80 - cell); the centre is its own mirror.
    let mut order: Vec<usize> = (0..=CELLS / 2).collect();
    rng.shuffle(&mut order);
    let mut clues = CELLS;
    for a in order {
        if clues <= tier.clues {
            break;
        }
        let b = CELLS - 1 - a;
        let kept = (puzzle[a], puzzle[b]);
        puzzle[a] = 0;
        puzzle[b] = 0;
        let fits = count_solutions(&puzzle, 2) == 1
            && grade(&puzzle).is_some_and(|t| t <= hardest_allowed);
        if fits {
            clues -= if a == b { 1 } else { 2 };
        } else {
            (puzzle[a], puzzle[b]) = kept;
        }
    }
    let hardest = grade(&puzzle)?;
    if !tier.needs.contains(&hardest) || clues > tier.clues + CLUE_SLACK {
        return None;
    }
    Some(C9Level {
        level,
        tier: tier.name,
        technique: hardest.id(),
        clues,
        data: Level {
            puzzle: grid_text(&puzzle),
            solution: grid_text(&solution),
        },
    })
}

fn build_level(master: &str, level: u16) -> C9Level {
    for attempt in 0..MAX_ATTEMPTS {
        let seed = derive_seed(master, &["c9", &level.to_string(), &attempt.to_string()]);
        if let Some(found) = candidate(level, seed) {
            eprintln!(
                "  c9 {level:>3}: {} · {} · {} clues (attempt {})",
                found.tier,
                found.technique,
                found.clues,
                attempt + 1
            );
            return found;
        }
    }
    panic!("cipher9 level {level}: no puzzle fits its tier in {MAX_ATTEMPTS} attempts");
}

pub fn generate(master: &str, max_level: u16) -> Vec<C9Level> {
    let mut levels: Vec<C9Level> = (1..=max_level)
        .into_par_iter()
        .map(|level| build_level(master, level))
        .collect();
    levels.sort_by_key(|l| l.level);
    levels
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tiers_follow_the_table() {
        assert_eq!(tier(1).clues, 48);
        assert_eq!((tier(4).clues, tier(20).clues), (44, 38));
        assert_eq!(
            (tier(21).name, tier(21).clues, tier(45).clues),
            ("casual", 37, 32)
        );
        assert_eq!((tier(46).name, tier(75).clues), ("tactical", 27));
        assert_eq!(
            (tier(76).name, tier(76).clues, tier(100).clues),
            ("master", 26, 22)
        );
    }

    #[test]
    fn levels_are_unique_and_need_their_tier() {
        for level in [1, 30, 60] {
            let l = build_level("test-seed-not-secret-0123456789abcdef", level);
            l.data.validate().unwrap();
            let t = tier(level);
            assert!(t.needs.iter().any(|n| n.id() == l.technique));
            assert!(l.clues <= t.clues + CLUE_SLACK);
        }
    }
}
