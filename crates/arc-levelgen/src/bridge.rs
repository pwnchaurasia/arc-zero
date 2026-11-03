//! Dead Bridge Assault level pipeline (design doc §3-4).
//!
//! Each level is built from tuned parameters, then played by the bot. A search finds the
//! level's ceiling: the strongest horde (size and toughness together) a sharp player
//! still holds. The level is then set at a rising share of that ceiling: a quarter in
//! the intro, about half at level 4, the full ceiling at level 100. The bot replays the
//! final level, so every level is proven beatable.

use arc_engine::dead_bridge::bot::play;
use arc_engine::dead_bridge::{
    AssistKind, CageSpec, CrateSpec, Reward, Script, Spawn, Status, ZKind, BRIDGE_W, TPS,
};
use arc_engine::rng::Rng;
use rayon::prelude::*;
use serde::Serialize;

use crate::derive_seed;

/// Levels 1-3 are a gentle introduction (decision 2026-11-02, every game).
const INTRO_LEVELS: u16 = 3;
const SEEDS_TO_TRY: u32 = 6;
const SEARCH_STEPS: u32 = 9;
/// Horde strength range the search covers (1.0 = the level's base parameters).
const STRENGTH: (f64, f64) = (0.1, 6.0);

#[derive(Clone, Debug, Serialize)]
pub struct DbLevel {
    pub level: u16,
    pub script: Script,
    /// Base health the bot had left, out of `script.base_hp`.
    pub bot_hp: i32,
    pub bot_seconds: u32,
    /// Horde strength the search settled on (1.0 = the level's base parameters).
    pub strength: f64,
}

fn lerp(a: f64, b: f64, t: f64) -> f64 {
    a + (b - a) * t.clamp(0.0, 1.0)
}

fn to_u32(v: f64) -> u32 {
    v.round().clamp(0.0, f64::from(u32::MAX)) as u32
}

struct Params {
    seconds: f64,
    zombies: u32,
    walker_hp: f64,
    runner_pct: u64,
    brute_pct: u64,
    boss_hp: f64,
    cage_hp: f64,
    cages: usize,
    crates: usize,
    base_hp: u16,
    /// Share of base health the bot must keep (shrinks as levels get harder).
    margin: f64,
    /// Share of the ceiling this level is set at.
    share: f64,
}

fn params(level: u16) -> Params {
    if level <= INTRO_LEVELS {
        let l = f64::from(level);
        return Params {
            seconds: 45.0 + 5.0 * l,
            zombies: 22 + 6 * u32::from(level),
            walker_hp: 30.0,
            runner_pct: 0,
            brute_pct: 0,
            boss_hp: 500.0 + 100.0 * l,
            cage_hp: 90.0,
            cages: 3,
            crates: 4,
            base_hp: 25,
            margin: 0.6,
            share: 0.25,
        };
    }
    let t = f64::from(level - INTRO_LEVELS - 1) / f64::from(99 - INTRO_LEVELS);
    Params {
        seconds: lerp(60.0, 82.0, t),
        zombies: to_u32(lerp(70.0, 300.0, t)),
        walker_hp: lerp(45.0, 190.0, t),
        runner_pct: to_u32(lerp(10.0, 30.0, t)).into(),
        brute_pct: if level >= 8 {
            to_u32(lerp(3.0, 16.0, t)).into()
        } else {
            0
        },
        boss_hp: lerp(1_500.0, 9_000.0, t),
        cage_hp: lerp(160.0, 650.0, t),
        cages: if level >= 40 { 5 } else { 4 },
        crates: if level >= 60 { 2 } else { 3 },
        base_hp: 20,
        margin: lerp(0.3, 0.1, t),
        share: lerp(0.45, 1.0, t),
    }
}

/// `strength` scales the horde's size and toughness together.
fn build(level: u16, seed: u64, strength: f64) -> Script {
    let mut p = params(level);
    p.zombies = to_u32(f64::from(p.zombies) * strength.sqrt()).max(8);
    let ease = strength.sqrt();
    let mut rng = Rng::new(seed);
    let total = to_u32(p.seconds * f64::from(TPS));
    let waves = vec![0, total * 34 / 100, total * 68 / 100];
    let mut spawns = Vec::with_capacity(p.zombies as usize + 1);
    // Zombies arrive in clumps within each wave, so lanes matter.
    let per_wave = p.zombies / 3;
    for (w, &start) in waves.iter().enumerate() {
        let end = waves.get(w + 1).copied().unwrap_or(total);
        let count = if w == 2 {
            p.zombies - 2 * per_wave
        } else {
            per_wave
        };
        let mut placed = 0;
        while placed < count {
            let clump = u32::try_from(rng.range(2, 6))
                .unwrap_or(3)
                .min(count - placed);
            let tick = start
                + u32::try_from(rng.below(u64::from((end - start).max(1)) * 9 / 10)).unwrap_or(0);
            let x =
                i32::try_from(rng.range(700, i64::from(BRIDGE_W - 700))).unwrap_or(BRIDGE_W / 2);
            for k in 0..clump {
                let roll = rng.below(100);
                let kind = if roll < p.brute_pct {
                    ZKind::Brute
                } else if roll < p.brute_pct + p.runner_pct {
                    ZKind::Runner
                } else {
                    ZKind::Walker
                };
                let mult = match kind {
                    ZKind::Runner => 0.6,
                    ZKind::Brute => 4.0,
                    _ => 1.0,
                };
                let jitter = i32::try_from(rng.range(-450, 450)).unwrap_or(0);
                spawns.push(Spawn {
                    tick: tick + k * 8,
                    kind,
                    x: (x + jitter).clamp(500, BRIDGE_W - 500),
                    hp: to_u32(p.walker_hp * mult * ease).max(1),
                });
            }
            placed += clump;
        }
    }
    spawns.push(Spawn {
        tick: total,
        kind: ZKind::Boss,
        x: BRIDGE_W / 2,
        hp: to_u32(p.boss_hp * ease).max(1),
    });
    spawns.sort_by_key(|s| s.tick);

    // Cages: the first is always a better gun, then turrets, the tank, a repair, an assist.
    let mut rewards = vec![
        Reward::Weapon,
        Reward::TurretLeft,
        Reward::Tank,
        Reward::TurretRight,
        Reward::Repair,
    ];
    if level >= 20 {
        rewards.insert(3, Reward::Weapon);
    }
    let mut cages = Vec::new();
    for (i, reward) in rewards.into_iter().take(p.cages).enumerate() {
        let n = u32::try_from(i).unwrap_or(0);
        let left = i % 2 == 0;
        cages.push(CageSpec {
            tick: 60 + n * total / (u32::try_from(p.cages).unwrap_or(4) + 1),
            x: if left { 1_400 } else { BRIDGE_W - 1_400 },
            stop_y: to_u32(rng.range(4_500, 7_500) as f64) as i32,
            hp: to_u32(p.cage_hp * ease * (1.0 + 0.2 * f64::from(n))).max(40),
            reward,
        });
    }
    let mut crates = Vec::new();
    for i in 0..p.crates {
        let kind = AssistKind::ALL[usize::try_from(rng.below(5)).unwrap_or(0)];
        let n = u32::try_from(i).unwrap_or(0);
        crates.push(CrateSpec {
            tick: 150 + n * total / (u32::try_from(p.crates).unwrap_or(3) + 1),
            x: i32::try_from(rng.range(1_200, i64::from(BRIDGE_W - 1_200))).unwrap_or(BRIDGE_W / 2),
            kind,
            hp: to_u32(lerp(30.0, 120.0, f64::from(level) / 100.0)),
        });
    }
    Script {
        seed: rng.next_u64(),
        base_hp: p.base_hp,
        waves,
        spawns,
        cages,
        crates,
    }
}

/// The ceiling search uses a sharp player and a thin margin.
const CEILING_MARGIN: f64 = 0.1;

fn holds(level: u16, seed: u64, strength: f64, margin: f64) -> Option<DbLevel> {
    let script = build(level, seed, strength);
    let run = play(&script, 0);
    let needed = (f64::from(script.base_hp) * margin).ceil() as i32;
    (run.status == Status::Won && run.base_hp >= needed).then_some(DbLevel {
        level,
        bot_hp: run.base_hp,
        bot_seconds: run.ticks / TPS,
        strength,
        script,
    })
}

fn build_level(master: &str, level: u16) -> DbLevel {
    let p = params(level);
    for attempt in 0..SEEDS_TO_TRY {
        let seed = derive_seed(master, &["db", &level.to_string(), &attempt.to_string()]);
        if holds(level, seed, STRENGTH.0, CEILING_MARGIN).is_none() {
            continue;
        }
        // Binary search for the ceiling: the strongest horde still held.
        let (mut lo, mut hi) = STRENGTH;
        for _ in 0..SEARCH_STEPS {
            let mid = (lo + hi) / 2.0;
            if holds(level, seed, mid, CEILING_MARGIN).is_some() {
                lo = mid;
            } else {
                hi = mid;
            }
        }
        // Set the level at its share of the ceiling; it must hold with this level's
        // (larger) margin, or step down until it does.
        let mut strength = (lo * p.share).max(STRENGTH.0);
        loop {
            if let Some(found) = holds(level, seed, strength, p.margin) {
                return found;
            }
            if strength <= STRENGTH.0 {
                break;
            }
            strength = (strength * 0.85).max(STRENGTH.0);
        }
    }
    panic!("dead bridge level {level}: even the weakest horde broke through for every seed");
}

pub fn generate(master: &str, max_level: u16) -> Vec<DbLevel> {
    let mut levels: Vec<DbLevel> = (1..=max_level)
        .into_par_iter()
        .map(|level| build_level(master, level))
        .collect();
    levels.sort_by_key(|l| l.level);
    for l in &levels {
        eprintln!(
            "  db {:>3}: strength {:.2}, {:>3} zombies, boss {:>5} hp, bot kept {:>2}/{} hp in {}s",
            l.level,
            l.strength,
            l.script.spawns.len(),
            l.script.spawns.last().map_or(0, |s| s.hp),
            l.bot_hp,
            l.script.base_hp,
            l.bot_seconds
        );
    }
    levels
}
