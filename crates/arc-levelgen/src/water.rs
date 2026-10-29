//! Water Sort level pipeline (design doc §4.2).

use arc_engine::rng::Rng;
use arc_engine::water_sort::{replay, solve, Board, SolveOutcome};
use rayon::prelude::*;
use serde::Serialize;

use crate::derive_seed;

const EMPTY_BOTTLES: u8 = 2;
const CANDIDATES_PER_LEVEL: usize = 4;
const OPTIMAL_BUDGET: usize = 600_000;
const FALLBACK_BUDGET: usize = 2_000_000;
const TRAP_SAMPLES: usize = 24;
const TRAP_BUDGET: usize = 30_000;

/// `(first level, last level, colours)`.
const TIERS: [(u16, u16, u8); 7] = [
    (1, 3, 3),
    (4, 10, 4),
    (11, 25, 5),
    (26, 45, 6),
    (46, 65, 7),
    (66, 85, 8),
    (86, 100, 9),
];

#[derive(Clone, Debug, Serialize)]
pub struct WsLevel {
    pub level: u16,
    pub seed: u64,
    pub colors: u8,
    pub empty: u8,
    /// Shortest known solution; exact when `min_moves_exact`.
    pub min_moves: u16,
    pub min_moves_exact: bool,
    pub trap_ratio: f64,
    pub difficulty: f64,
}

struct Candidate {
    seed: u64,
    min_moves: u16,
    exact: bool,
    trap_ratio: f64,
    difficulty: f64,
}

/// Fraction of positions reachable by random play from which the board can no longer be solved.
fn trap_ratio(board: &Board, seed: u64, max_depth: u16) -> f64 {
    let mut rng = Rng::new(seed);
    let (mut traps, mut known) = (0u32, 0u32);
    for _ in 0..TRAP_SAMPLES {
        let mut b = board.clone();
        let depth = rng.range(1, i64::from(max_depth.max(1)));
        for _ in 0..depth {
            let moves = b.legal_moves();
            if moves.is_empty() {
                break;
            }
            let pick = moves[usize::try_from(rng.below(moves.len() as u64)).unwrap_or(0)];
            if b.pour(pick.0, pick.1).is_err() {
                break;
            }
        }
        match solve(&b, TRAP_BUDGET, 3) {
            SolveOutcome::Solved { .. } => known += 1,
            SolveOutcome::Unsolvable { .. } => {
                known += 1;
                traps += 1;
            }
            SolveOutcome::BudgetExceeded { .. } => {}
        }
    }
    if known == 0 {
        0.0
    } else {
        f64::from(traps) / f64::from(known)
    }
}

fn evaluate(seed: u64, colors: u8) -> Option<Candidate> {
    let board = Board::generate(seed, colors, EMPTY_BOTTLES);
    let (moves, exact) = match solve(&board, OPTIMAL_BUDGET, 1) {
        SolveOutcome::Solved { moves, .. } => (moves, true),
        SolveOutcome::Unsolvable { .. } => return None,
        SolveOutcome::BudgetExceeded { .. } => match solve(&board, FALLBACK_BUDGET, 2) {
            SolveOutcome::Solved { moves, .. } => (moves, false),
            _ => return None,
        },
    };
    // Belt and braces: the solution must replay with the public rules.
    if !replay(&board, &moves).is_ok_and(|b| b.is_solved()) {
        return None;
    }
    let min_moves = u16::try_from(moves.len()).ok()?;
    // Trivial boards are boring at any tier.
    if min_moves < u16::from(colors) + 1 {
        return None;
    }
    let trap_ratio = trap_ratio(&board, seed ^ 0x5eed, min_moves);
    let difficulty = f64::from(min_moves) + 30.0 * trap_ratio + 2.0 * f64::from(colors);
    Some(Candidate {
        seed,
        min_moves,
        exact,
        trap_ratio,
        difficulty,
    })
}

/// Picks one candidate per level so difficulty rises through the tier,
/// with an easier "breather" on every 10th level.
fn assign(tier_levels: &[u16], mut pool: Vec<Candidate>, colors: u8) -> Vec<WsLevel> {
    pool.sort_by(|a, b| {
        a.difficulty
            .total_cmp(&b.difficulty)
            .then(a.seed.cmp(&b.seed))
    });
    let n = tier_levels.len();
    let mut used = vec![false; pool.len()];
    let mut out = Vec::with_capacity(n);
    for (i, &level) in tier_levels.iter().enumerate() {
        let q = if level.is_multiple_of(10) && level != 100 {
            0.1
        } else {
            0.15 + 0.75 * (i as f64 + 0.5) / n as f64
        };
        let target = ((pool.len() - 1) as f64 * q).round() as usize;
        // Nearest unused candidate to the target quantile.
        let idx = (0..pool.len())
            .filter(|j| !used[*j])
            .min_by_key(|j| j.abs_diff(target))
            .expect("pool has at least one candidate per level");
        used[idx] = true;
        let c = &pool[idx];
        out.push(WsLevel {
            level,
            seed: c.seed,
            colors,
            empty: EMPTY_BOTTLES,
            min_moves: c.min_moves,
            min_moves_exact: c.exact,
            trap_ratio: c.trap_ratio,
            difficulty: c.difficulty,
        });
    }
    out
}

pub fn generate(master: &str, max_level: u16) -> Vec<WsLevel> {
    let mut levels = Vec::new();
    for (tier_idx, &(first, last, colors)) in TIERS.iter().enumerate() {
        if first > max_level {
            break;
        }
        let tier_levels: Vec<u16> = (first..=last.min(max_level)).collect();
        let wanted = tier_levels.len() * CANDIDATES_PER_LEVEL;
        let mut pool: Vec<Candidate> = Vec::new();
        let mut batch = 0usize;
        while pool.len() < wanted.max(tier_levels.len() + 4) {
            let start = batch * wanted;
            let found: Vec<Candidate> = (start..start + wanted)
                .into_par_iter()
                .filter_map(|i| {
                    let seed = derive_seed(master, &["ws", &tier_idx.to_string(), &i.to_string()]);
                    evaluate(seed, colors)
                })
                .collect();
            pool.extend(found);
            batch += 1;
            assert!(
                batch < 20,
                "tier {tier_idx}: could not find enough solvable boards"
            );
        }
        eprintln!(
            "  ws tier {first}-{last} ({colors} colours): {} candidates",
            pool.len()
        );
        levels.extend(assign(&tier_levels, pool, colors));
    }
    levels
}
