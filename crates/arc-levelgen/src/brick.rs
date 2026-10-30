//! Brick Blast level pipeline (design doc §6).
//!
//! Each level is generated from tuned parameters, then played by the greedy
//! bot. Only levels the bot clears with room to spare are kept; if a level is
//! too hard, block HP is scaled down until it becomes finishable.

use arc_engine::brick_blast::bot::play_level;
use arc_engine::brick_blast::{
    Cell, LevelScript, PowerKind, Row, Shape, COLS, EMPTY_ROW, MAX_BALLS, MAX_HP,
};
use arc_engine::rng::Rng;
use rayon::prelude::*;
use serde::Serialize;

use crate::derive_seed;

const BOT_AIMS: u16 = 31;
/// No block is ever weaker than this, on any level (design decision 2026-10-30).
const MIN_BLOCK_HP: u16 = 50;
/// Balls on level 1 and level 100; levels in between interpolate.
const START_BALLS_FIRST: f64 = 30.0;
const START_BALLS_LAST: f64 = 60.0;
const MAX_ATTEMPTS: u32 = 24;
const WINNERS_WANTED: usize = 3;

#[derive(Clone, Debug, Serialize)]
pub struct BbLevel {
    pub level: u16,
    pub script: LevelScript,
    pub total_hp: u32,
    pub bot_turns: u16,
    pub bot_closest: u8,
    pub difficulty: f64,
}

fn lerp(a: f64, b: f64, t: f64) -> f64 {
    a + (b - a) * t.clamp(0.0, 1.0)
}

fn to_u16(v: f64) -> u16 {
    v.round().clamp(0.0, f64::from(u16::MAX)) as u16
}

fn power_pool(level: u16) -> Vec<(PowerKind, u32)> {
    let mut pool = vec![(PowerKind::PlusBalls2, 4), (PowerKind::PlusBalls3, 3)];
    if level >= 4 {
        pool.extend([(PowerKind::LaserH, 2), (PowerKind::LaserV, 2)]);
    }
    if level >= 16 {
        pool.extend([(PowerKind::BallUp3, 2), (PowerKind::PlusBalls5, 1)]);
    }
    if level >= 36 {
        pool.push((PowerKind::LaserX, 1));
    }
    if level >= 86 {
        pool.push((PowerKind::BallUp5, 1));
    }
    pool
}

fn pick_power(rng: &mut Rng, pool: &[(PowerKind, u32)]) -> PowerKind {
    let total: u32 = pool.iter().map(|(_, w)| w).sum();
    let mut roll = u32::try_from(rng.below(u64::from(total))).unwrap_or(0);
    for &(kind, w) in pool {
        if roll < w {
            return kind;
        }
        roll -= w;
    }
    pool[0].0
}

/// `extra_balls` is added when the bot could not finish a layout, so a level gets
/// easier by giving the player more balls, never by dropping blocks below MIN_BLOCK_HP.
fn build_script(level: u16, seed: u64, extra_balls: u16) -> LevelScript {
    let mut rng = Rng::new(seed);
    let t = f64::from(level - 1) / 99.0;
    let tutorial = level <= 3;

    let start_balls = to_u16(lerp(START_BALLS_FIRST, START_BALLS_LAST, t))
        .saturating_add(extra_balls)
        .min(MAX_BALLS);
    let total_rows = usize::from(to_u16(lerp(4.0, 24.0, t)));
    let start_count = (2 + usize::from(level) / 30).min(5).min(total_rows - 1);
    // Block HP range: 50-70 on level 1, rising to 90-150 on level 100.
    let hp_lo = lerp(f64::from(MIN_BLOCK_HP), 90.0, t);
    let hp_hi = lerp(70.0, f64::from(MAX_HP), t);
    let max_blocks = i64::from(to_u16(lerp(4.0, 7.0, t)));
    let tri_chance = if level < 16 {
        0
    } else {
        u64::from(to_u16(lerp(10.0, 35.0, (f64::from(level) - 16.0) / 84.0)))
    };
    let pool = if tutorial {
        vec![(PowerKind::PlusBalls2, 1), (PowerKind::PlusBalls3, 1)]
    } else {
        power_pool(level)
    };
    let shapes = [Shape::TriBl, Shape::TriBr, Shape::TriTl, Shape::TriTr];

    // Rows in the order they reach the player: index 0 is lowest on the board at the start.
    let mut seq: Vec<Row> = Vec::with_capacity(total_rows);
    for i in 0..total_rows {
        let mut row = EMPTY_ROW;
        let mut cols: Vec<usize> = (0..COLS).collect();
        rng.shuffle(&mut cols);
        let blocks = usize::try_from(rng.range(2, max_blocks)).unwrap_or(2);
        // Later rows are tougher than earlier ones (within the level's HP range).
        let row_factor = 0.8 + 0.2 * i as f64 / (total_rows.max(2) - 1) as f64;
        for &c in &cols[..blocks] {
            let hp_min = (hp_lo * row_factor).max(f64::from(MIN_BLOCK_HP));
            let hp_max = (hp_hi * row_factor).max(hp_min);
            let hp = rng.range(i64::from(to_u16(hp_min)), i64::from(to_u16(hp_max)));
            let hp = u16::try_from(hp)
                .unwrap_or(MIN_BLOCK_HP)
                .clamp(MIN_BLOCK_HP, MAX_HP);
            let shape = if rng.chance(tri_chance, 100) {
                shapes[usize::try_from(rng.below(4)).unwrap_or(0)]
            } else {
                Shape::Square
            };
            row[c] = Cell::Block { shape, hp };
        }
        let powers = if level >= 60 && rng.chance(1, 3) {
            2
        } else {
            1
        };
        for &c in cols[blocks..].iter().take(powers) {
            if rng.chance(7, 10) {
                row[c] = Cell::Power {
                    kind: pick_power(&mut rng, &pool),
                };
            }
        }
        seq.push(row);
    }

    let mut start_rows: Vec<Row> = seq[..start_count].to_vec();
    start_rows.reverse();
    LevelScript {
        start_balls,
        start_rows,
        row_queue: seq[start_count..].to_vec(),
    }
}

fn required_margin(level: u16) -> u8 {
    if level <= 30 {
        3
    } else if level <= 70 {
        2
    } else {
        1
    }
}

fn build_level(master: &str, level: u16) -> BbLevel {
    let mut winners: Vec<BbLevel> = Vec::new();
    let mut extra_balls = 0u16;
    for attempt in 0..MAX_ATTEMPTS {
        if attempt > 0 && attempt % 4 == 0 && winners.is_empty() {
            extra_balls += 10;
        }
        let seed = derive_seed(master, &["bb", &level.to_string(), &attempt.to_string()]);
        let script = build_script(level, seed, extra_balls);
        let Ok(run) = play_level(&script, BOT_AIMS) else {
            continue;
        };
        if !run.won || run.closest < required_margin(level) {
            continue;
        }
        let total_hp = script.total_hp();
        let difficulty = f64::from(run.turns)
            + 4.0 * f64::from(11u8.saturating_sub(run.closest))
            + f64::from(total_hp) / (f64::from(script.start_balls) * 25.0);
        winners.push(BbLevel {
            level,
            script,
            total_hp,
            bot_turns: run.turns,
            bot_closest: run.closest,
            difficulty,
        });
        if winners.len() >= WINNERS_WANTED {
            break;
        }
    }
    assert!(
        !winners.is_empty(),
        "brick blast level {level}: no finishable layout found"
    );
    winners.sort_by(|a, b| a.difficulty.total_cmp(&b.difficulty));
    let pick = if level.is_multiple_of(10) && level != 100 {
        0
    } else {
        winners.len() / 2
    };
    winners.swap_remove(pick)
}

pub fn generate(master: &str, max_level: u16) -> Vec<BbLevel> {
    let mut levels: Vec<BbLevel> = (1..=max_level)
        .into_par_iter()
        .map(|level| build_level(master, level))
        .collect();
    levels.sort_by_key(|l| l.level);
    for l in &levels {
        eprintln!(
            "  bb {:>3}: balls {:>2} rows {:>2} hp {:>5} bot turns {:>2} closest {}",
            l.level,
            l.script.start_balls,
            l.script.start_rows.len() + l.script.row_queue.len(),
            l.total_hp,
            l.bot_turns,
            l.bot_closest
        );
    }
    levels
}
