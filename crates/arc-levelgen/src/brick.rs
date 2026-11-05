//! Brick Blast level pipeline (design doc §6).
//!
//! Each level is generated from tuned parameters, then played by the greedy
//! bot. Only levels the bot clears with room to spare are kept; if a level is
//! too hard, block HP is scaled down until it becomes finishable.

use arc_engine::brick_blast::bot::play_level;
use arc_engine::brick_blast::{
    Cell, LevelScript, PowerKind, Row, Shape, COLS, EMPTY_ROW, MAX_BALLS, MAX_HP, MAX_SCRIPT_ROWS,
};
use arc_engine::rng::Rng;
use rayon::prelude::*;
use serde::Serialize;
use std::time::Instant;

use crate::derive_seed;

const BOT_AIMS: u16 = 31;
/// No block is ever weaker than this, on any level (design decision 2026-10-30).
const MIN_BLOCK_HP: u16 = 50;
/// Balls at the start and the end of the original curve (old levels 4 and 100).
const START_BALLS_FIRST: f64 = 33.0;
const START_BALLS_LAST: f64 = 60.0;
/// Difficulty on the original curve (0 = old level 4, 1 = old level 100) at level 4,
/// level 10 and level 100 (decision 2026-11-02: old level 70 becomes level 10, then
/// keep climbing past the old level 100).
const CURVE_AT_4: f64 = 0.375;
const CURVE_AT_10: f64 = 0.6875;
const CURVE_AT_100: f64 = 1.6;
/// Levels 1-3 are a gentle introduction (design decision 2026-11-02).
const INTRO_LEVELS: u16 = 3;
const INTRO_BALLS: f64 = 40.0;
/// Extra starting balls from level 5 on (decision 2026-11-03), layouts unchanged.
const BONUS_BALLS_FROM: u16 = 5;
const BONUS_BALLS: u16 = 10;
/// From this level the player starts with a set number of balls, 5 more each level, up to
/// MAX_BALLS at level 98 (decision 2026-11-05: too many blocks, too few balls).
const BALL_RAMP_FROM: u16 = 17;
const BALL_RAMP_START: u16 = 95;
const BALL_RAMP_STEP: u16 = 5;
const MAX_ATTEMPTS: u32 = 16;
/// Balls added after every two layouts the bot could not finish.
const BALLS_PER_RETRY: u16 = 8;
/// Double Damage, Pierce and Bomb appear from this level (decision 2026-11-04).
const NEW_POWERS_FROM: u16 = 11;
/// A power-up is trapped when its open area (cells without a block) reaches neither the
/// row above nor the row below and holds fewer than `OPEN_AREA` cells: blocks seal it in.
const OPEN_REACH: usize = 1;
const OPEN_AREA: usize = 3;

/// Which power-ups a layout gets. Layouts are chosen (and checked by the bot) with the
/// power-ups from before 2026-11-04, so blocks and balls stay exactly as they were; the
/// final level then gets the current ones. Both use the same random draws.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Powers {
    Original,
    Current,
}

#[derive(Clone, Debug, Serialize)]
pub struct BbLevel {
    pub level: u16,
    pub script: LevelScript,
    pub total_hp: u32,
    pub bot_turns: u16,
    pub bot_closest: u8,
    pub difficulty: f64,
}

/// The balls a player starts with on a layout chosen with `chosen` balls.
fn player_balls(level: u16, chosen: u16) -> u16 {
    let balls = if level >= BALL_RAMP_FROM {
        chosen.max(BALL_RAMP_START + BALL_RAMP_STEP * (level - BALL_RAMP_FROM))
    } else if level >= BONUS_BALLS_FROM {
        chosen + BONUS_BALLS
    } else {
        chosen
    };
    balls.min(MAX_BALLS)
}

fn lerp(a: f64, b: f64, t: f64) -> f64 {
    a + (b - a) * t.clamp(0.0, 1.0)
}

fn to_u16(v: f64) -> u16 {
    v.round().clamp(0.0, f64::from(u16::MAX)) as u16
}

/// Power-ups available at an (equivalent) level. Decision 2026-11-02: +2 balls and the
/// old x3/x5 splits are gone; scatter and next-shot boosts (x2, rarer x3) are in.
fn power_pool(level: u16, actual_level: u16, powers: Powers) -> Vec<(PowerKind, u32)> {
    let mut pool = vec![
        (PowerKind::PlusBalls3, 4),
        (PowerKind::PlusBalls5, 2),
        (PowerKind::LaserH, 2),
        (PowerKind::LaserV, 2),
    ];
    if level >= 7 {
        pool.extend([(PowerKind::Scatter, 2), (PowerKind::Boost2, 1)]);
    }
    if level >= 27 {
        pool.push((PowerKind::LaserX, 1));
    }
    if level >= 40 {
        pool.push((PowerKind::Boost3, 1));
    }
    if powers == Powers::Current && actual_level >= NEW_POWERS_FROM {
        pool.extend([
            (PowerKind::DoubleDamage, 2),
            (PowerKind::Bomb, 2),
            (PowerKind::Pierce, 1),
        ]);
    }
    pool
}

/// Whether the power-up at `seq[row][col]` sits in a closed pocket of blocks. `seq` is
/// bottom-up (index 0 lowest); the stack's bottom and top rows are always open.
fn trapped(seq: &[Row], row: usize, col: usize) -> bool {
    let open = |r: usize, c: usize| !matches!(seq[r][c], Cell::Block { .. });
    let mut seen = vec![[false; COLS]; seq.len()];
    let mut stack = vec![(row, col)];
    seen[row][col] = true;
    let mut area = 0;
    while let Some((r, c)) = stack.pop() {
        area += 1;
        if r == 0 || r + 1 == seq.len() || r.abs_diff(row) >= OPEN_REACH || area >= OPEN_AREA {
            return false;
        }
        for (nr, nc) in [(r - 1, c), (r + 1, c), (r, c.wrapping_sub(1)), (r, c + 1)] {
            if nc < COLS && !seen[nr][nc] && open(nr, nc) {
                seen[nr][nc] = true;
                stack.push((nr, nc));
            }
        }
    }
    true
}

/// Moves every trapped power-up to the nearest empty cell a ball can reach: in its own
/// row if possible, else the row below or above. Blocks never move.
fn free_trapped_power_ups(seq: &mut [Row]) -> (u32, u32) {
    let (mut moved, mut stuck) = (0, 0);
    for row in 0..seq.len() {
        for col in 0..COLS {
            if !matches!(seq[row][col], Cell::Power { .. }) || !trapped(seq, row, col) {
                continue;
            }
            let rows = [
                Some(row),
                row.checked_sub(1),
                Some(row + 1).filter(|&r| r < seq.len()),
            ];
            let spot = rows.into_iter().flatten().find_map(|r| {
                (0..COLS)
                    .filter(|&c| seq[r][c] == Cell::Empty && !trapped(seq, r, c))
                    .min_by_key(|&c| (c.abs_diff(col), c))
                    .map(|c| (r, c))
            });
            if let Some((r, c)) = spot {
                seq[r][c] = seq[row][col];
                seq[row][col] = Cell::Empty;
                moved += 1;
            } else {
                stuck += 1;
            }
        }
    }
    (moved, stuck)
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
/// Where a level sits on the original difficulty curve (may go past 1).
fn curve(level: u16) -> f64 {
    let l = f64::from(level);
    if level <= 10 {
        CURVE_AT_4 + (CURVE_AT_10 - CURVE_AT_4) * (l - 4.0).max(0.0) / 6.0
    } else {
        CURVE_AT_10 + (CURVE_AT_100 - CURVE_AT_10) * (l - 10.0) / 90.0
    }
}

/// The original-curve level this level plays like; drives power-ups, shapes and margins.
fn equivalent_level(level: u16) -> u16 {
    if level <= INTRO_LEVELS {
        level
    } else {
        to_u16(4.0 + 96.0 * curve(level))
    }
}

/// Like `lerp`, but continues past `b` for levels beyond the original curve.
fn extend(a: f64, b: f64, t: f64) -> f64 {
    a + (b - a) * t.max(0.0)
}

/// `extra_balls` is added when the bot could not finish a layout, so a level gets
/// easier by giving the player more balls, never by dropping blocks below MIN_BLOCK_HP.
fn build_script(level: u16, seed: u64, extra_balls: u16, powers: Powers) -> LevelScript {
    let mut rng = Rng::new(seed);
    let intro = level <= INTRO_LEVELS;
    let t = curve(level);
    let eq = equivalent_level(level);

    let base_balls = if intro {
        INTRO_BALLS
    } else {
        extend(START_BALLS_FIRST, START_BALLS_LAST, t)
    };
    let start_balls = to_u16(base_balls)
        .saturating_add(extra_balls)
        .min(MAX_BALLS);
    let total_rows = if intro {
        3 + usize::from(level)
    } else {
        usize::from(to_u16(extend(6.0, 28.0, t))).min(MAX_SCRIPT_ROWS)
    };
    let start_count = if intro {
        2
    } else {
        (3 + usize::from(eq) / 25).min(6).min(total_rows - 1)
    };
    // Block HP range: 50-60 in the intro, ~72-102 on level 4, ~93-127 on level 10,
    // up to 140-150 by level 100.
    let (hp_lo, hp_hi) = if intro {
        (f64::from(MIN_BLOCK_HP), 60.0)
    } else {
        (
            extend(55.0, 110.0, t).min(140.0),
            extend(78.0, f64::from(MAX_HP), t).min(f64::from(MAX_HP)),
        )
    };
    let (min_blocks, max_blocks) = if intro {
        (2, 3)
    } else {
        (
            i64::from(to_u16(extend(2.0, 4.0, t)).min(5)),
            i64::from(to_u16(extend(4.0, 8.0, t)).min(8)),
        )
    };
    let tri_chance = if eq < 7 {
        0
    } else {
        u64::from(to_u16(lerp(10.0, 40.0, (f64::from(eq) - 7.0) / 93.0)))
    };
    let pool = power_pool(eq, level, powers);
    let shapes = [Shape::TriBl, Shape::TriBr, Shape::TriTl, Shape::TriTr];

    // Rows in the order they reach the player: index 0 is lowest on the board at the start.
    let mut seq: Vec<Row> = Vec::with_capacity(total_rows);
    for i in 0..total_rows {
        let mut row = EMPTY_ROW;
        let mut cols: Vec<usize> = (0..COLS).collect();
        rng.shuffle(&mut cols);
        let blocks = usize::try_from(rng.range(min_blocks, max_blocks)).unwrap_or(2);
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
        let powers = if eq >= 51 && rng.chance(1, 3) { 2 } else { 1 };
        for &c in cols[blocks..].iter().take(powers) {
            if rng.chance(7, 10) {
                row[c] = Cell::Power {
                    kind: pick_power(&mut rng, &pool),
                };
            }
        }
        seq.push(row);
    }

    if powers == Powers::Current {
        let (moved, stuck) = free_trapped_power_ups(&mut seq);
        if moved + stuck > 0 {
            eprintln!("  bb {level:>3}: {moved} trapped power-up(s) moved, {stuck} could not be");
        }
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
    if level <= 20 {
        3
    } else if level <= 60 {
        2
    } else {
        1
    }
}

/// Builds one level: the first layout the bot can finish with the required margin.
///
/// Work is bounded for every seed: after each pair of failed layouts the player gets
/// more balls (blocks are never weakened), so a finishable layout turns up quickly.
/// Every 10th level from 20 is a breather built with the settings of a level 8 lower.
/// Level 10 is not: it is where the old level 70 now sits (decision 2026-11-02).
fn build_level(master: &str, level: u16) -> BbLevel {
    let started = Instant::now();
    eprintln!("  bb {level:>3}: started");
    let breather = level.is_multiple_of(10) && (20..100).contains(&level);
    let settings_level = if breather { level - 8 } else { level };
    let mut extra_balls = 0u16;
    for attempt in 0..MAX_ATTEMPTS {
        if attempt > 0 && attempt % 2 == 0 {
            extra_balls += BALLS_PER_RETRY;
        }
        let seed = derive_seed(master, &["bb", &level.to_string(), &attempt.to_string()]);
        let script = build_script(settings_level, seed, extra_balls, Powers::Original);
        let attempt_started = Instant::now();
        let Ok(run) = play_level(&script, BOT_AIMS) else {
            continue;
        };
        if !run.won || run.closest < required_margin(equivalent_level(level)) {
            eprintln!(
                "  bb {level:>3}: layout {} rejected (won {}, closest {}, {} turns, {} balls, {:.1?})",
                attempt + 1,
                run.won,
                run.closest,
                run.turns,
                script.start_balls,
                attempt_started.elapsed()
            );
            continue;
        }
        // The layout is chosen exactly as before; the player then gets their balls and
        // today's power-ups (same blocks). The bot must still win; the old power-ups are
        // the fallback. Levels with hundreds of balls are slow to play, so try these first.
        let balls = player_balls(level, script.start_balls);
        let mut current = build_script(settings_level, seed, extra_balls, Powers::Current);
        current.start_balls = balls;
        let (script, run) = match play_level(&current, BOT_AIMS) {
            Ok(again) if again.won => (current, again),
            _ => {
                let mut old = script;
                old.start_balls = balls;
                match play_level(&old, BOT_AIMS) {
                    Ok(again) if again.won => {
                        eprintln!(
                            "  bb {level:>3}: bot lost with the new power-ups; keeping the old ones"
                        );
                        (old, again)
                    }
                    _ => continue,
                }
            }
        };
        let total_hp = script.total_hp();
        let difficulty = f64::from(run.turns)
            + 4.0 * f64::from(11u8.saturating_sub(run.closest))
            + f64::from(total_hp) / (f64::from(script.start_balls) * 25.0);
        eprintln!(
            "  bb {level:>3}: found after {} layout(s), +{extra_balls} balls, {:.1?}",
            attempt + 1,
            started.elapsed()
        );
        return BbLevel {
            level,
            script,
            total_hp,
            bot_turns: run.turns,
            bot_closest: run.closest,
            difficulty,
        };
    }
    panic!("brick blast level {level}: no finishable layout in {MAX_ATTEMPTS} attempts");
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn balls_climb_by_5_a_level_from_95_at_level_17() {
        assert_eq!(player_balls(4, 45), 45);
        assert_eq!(player_balls(16, 53), 63);
        assert_eq!(player_balls(17, 53), 95);
        assert_eq!(player_balls(18, 54), 100);
        assert_eq!(player_balls(97, 80), 495);
        assert_eq!(player_balls(98, 80), MAX_BALLS);
        assert_eq!(player_balls(100, 86), MAX_BALLS);
    }
}
