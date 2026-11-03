//! Dead Bridge Assault level pipeline (design doc, "Built" section).
//!
//! Each level is built from tuned parameters, then played by the bot. A search finds the
//! level's ceiling: the strongest horde (size and toughness together) a sharp player
//! still holds. The level is then set at a rising share of that ceiling: a third in the
//! intro, the old level-25 share at level 4 (decision 2026-11-03), the full ceiling at
//! level 100. The bot replays the final level, so every level is proven beatable.

use arc_engine::dead_bridge::bot::play;
use arc_engine::dead_bridge::{
    AssistKind, CageSpec, CrateSpec, Gun, Reward, Script, Spawn, Status, ZKind, BRIDGE_W, TPS,
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
/// The ceiling search uses a sharp player and a thin margin.
const CEILING_MARGIN: f64 = 0.1;
/// The smallest boss, as a share of its tuned health.
const BOSS_FLOOR: f64 = 0.3;

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
    waves: u32,
    /// Zombies per second, on average across the level.
    rate: f64,
    walker_hp: f64,
    runner_pct: u64,
    brute_pct: u64,
    boss_hp: f64,
    cage_hp: f64,
    /// Seconds between cages and between crates.
    cage_every: f64,
    crate_every: f64,
    base_hp: u16,
    /// Share of base health the bot must keep.
    margin: f64,
    /// Share of the ceiling this level is set at.
    share: f64,
}

fn params(level: u16) -> Params {
    if level <= INTRO_LEVELS {
        let l = f64::from(level);
        return Params {
            seconds: 70.0 + 5.0 * l,
            waves: 3,
            rate: 0.7 + 0.1 * l,
            walker_hp: 30.0,
            runner_pct: 0,
            brute_pct: if level == 3 { 3 } else { 0 },
            boss_hp: 2_500.0 + 500.0 * l,
            cage_hp: 90.0,
            cage_every: 10.0,
            crate_every: 9.0,
            base_hp: 25,
            margin: 0.6,
            share: 0.3,
        };
    }
    let t = f64::from(level - INTRO_LEVELS - 1) / f64::from(99 - INTRO_LEVELS);
    Params {
        // About 2 minutes of play at level 4, 4 at level 100 (decision 2026-11-03); the
        // boss walk adds a little on top.
        seconds: lerp(110.0, 200.0, t),
        waves: 4 + to_u32(2.0 * t),
        rate: lerp(1.4, 2.6, t),
        walker_hp: lerp(55.0, 140.0, t),
        runner_pct: to_u32(lerp(12.0, 30.0, t)).into(),
        brute_pct: to_u32(lerp(5.0, 16.0, t)).into(),
        boss_hp: lerp(8_000.0, 20_000.0, t),
        cage_hp: lerp(180.0, 700.0, t),
        cage_every: lerp(11.0, 14.0, t),
        crate_every: lerp(8.0, 11.0, t),
        base_hp: 20,
        margin: lerp(0.3, 0.1, t),
        // Level 4 plays like the old level 25 (share 0.57), climbing to the ceiling.
        share: lerp(0.57, 1.0, t),
    }
}

/// What the cages hold, in the order they unlock as levels rise. Each level cycles
/// through what it has unlocked, shuffled, so every weapon and unit shows up.
fn cage_deck(level: u16) -> Vec<Reward> {
    let mut deck = vec![
        Reward::Gun(Gun::Minigun),
        Reward::TurretLeft,
        Reward::Gun(Gun::Shotgun),
        Reward::Tank,
        Reward::TurretRight,
        Reward::Repair,
    ];
    let unlocks: [(u16, Reward); 7] = [
        (2, Reward::Gun(Gun::Flamethrower)),
        (3, Reward::Mech),
        (5, Reward::Gun(Gun::Rocket)),
        (7, Reward::Barricade),
        (9, Reward::Gun(Gun::Laser)),
        (12, Reward::Assist(AssistKind::Barrage)),
        (20, Reward::Assist(AssistKind::Lance)),
    ];
    deck.extend(
        unlocks
            .iter()
            .filter(|(from, _)| level >= *from)
            .map(|(_, r)| *r),
    );
    deck
}

/// `strength` scales the horde's size and toughness together; `boss` scales the boss
/// alone, so a level's difficulty is the horde, not one bullet sponge.
fn build(level: u16, seed: u64, strength: f64, boss: f64) -> Script {
    let p = params(level);
    let ease = strength.sqrt();
    let mut rng = Rng::new(seed);
    let total = to_u32(p.seconds * f64::from(TPS));
    let waves: Vec<u32> = (0..p.waves).map(|w| total * w / p.waves).collect();
    let zombies = to_u32(p.rate * p.seconds * ease).max(10);
    let mut spawns = Vec::with_capacity(zombies as usize + 8);
    // Each wave is busier than the last; zombies arrive in clumps, so lanes matter.
    let weight_sum: u32 = (1..=p.waves).sum();
    for (w, &start) in waves.iter().enumerate() {
        let wi = u32::try_from(w).unwrap_or(0);
        let end = waves.get(w + 1).copied().unwrap_or(total);
        let count = zombies * (wi + 1) / weight_sum;
        let mut placed = 0;
        while placed < count {
            let clump = u32::try_from(rng.range(2, 7))
                .unwrap_or(3)
                .min(count - placed);
            let span = u64::from((end - start).max(1)) * 9 / 10;
            let tick = start + u32::try_from(rng.below(span.max(1))).unwrap_or(0);
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
                    ZKind::Brute => 4.5,
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
        // A pair of brutes closes every wave after the first.
        if w > 0 {
            for side in [2_500, BRIDGE_W - 2_500] {
                spawns.push(Spawn {
                    tick: end.saturating_sub(60),
                    kind: ZKind::Brute,
                    x: side,
                    hp: to_u32(p.walker_hp * 6.0 * ease).max(1),
                });
            }
        }
    }
    // The boss walks on near the end, escorted, and takes about 90 s to arrive.
    let boss_at = total.saturating_sub(20 * TPS);
    spawns.push(Spawn {
        tick: boss_at,
        kind: ZKind::Boss,
        x: BRIDGE_W / 2,
        hp: to_u32(p.boss_hp * boss).max(1),
    });
    for k in 0..6 {
        spawns.push(Spawn {
            tick: boss_at + 30 + k * 40,
            kind: ZKind::Walker,
            x: 2_000 + i32::try_from(k).unwrap_or(0) * 1_200,
            hp: to_u32(p.walker_hp * ease).max(1),
        });
    }
    spawns.sort_by_key(|s| s.tick);

    let mut deck = cage_deck(level);
    rng.shuffle(&mut deck);
    let every = to_u32(p.cage_every * f64::from(TPS));
    let mut cages = Vec::new();
    let mut tick = 3 * TPS;
    let mut i = 0usize;
    while tick + 10 * TPS < total {
        let reward = deck[i % deck.len()];
        cages.push(CageSpec {
            tick,
            // Four columns, so a cage still standing never hides the next one.
            x: [1_400, BRIDGE_W - 1_400, 3_300, BRIDGE_W - 3_300][i % 4],
            stop_y: to_u32(rng.range(4_500, 7_500) as f64) as i32,
            hp: to_u32(
                p.cage_hp * ease * (1.0 + f64::from(u32::try_from(i % 6).unwrap_or(0)) * 0.1),
            )
            .max(40),
            reward,
        });
        i += 1;
        tick += every;
    }
    // A heavy cage rolls in with the boss, so the fight is winnable without luck.
    cages.push(CageSpec {
        tick: boss_at,
        x: BRIDGE_W / 2,
        stop_y: 6_000,
        hp: to_u32(p.cage_hp * ease).max(40),
        reward: if level >= 5 && rng.chance(1, 2) {
            Reward::Gun(Gun::Rocket)
        } else {
            Reward::Tank
        },
    });
    cages.sort_by_key(|c| c.tick);
    let mut kinds = vec![
        AssistKind::Airstrike,
        AssistKind::Freeze,
        AssistKind::Drones,
        AssistKind::Lance,
        AssistKind::Napalm,
        AssistKind::Barrage,
    ];
    let mut crates = Vec::new();
    let every = to_u32(p.crate_every * f64::from(TPS));
    let mut tick = 6 * TPS;
    let mut nuke = level >= 30 && rng.chance(1, 2);
    while tick < total {
        rng.shuffle(&mut kinds);
        let kind = if nuke && tick > total / 2 {
            nuke = false;
            AssistKind::Nuke
        } else {
            kinds[0]
        };
        crates.push(CrateSpec {
            tick,
            x: i32::try_from(rng.range(1_200, i64::from(BRIDGE_W - 1_200))).unwrap_or(BRIDGE_W / 2),
            kind,
            hp: to_u32(lerp(30.0, 120.0, f64::from(level) / 100.0)),
        });
        tick += every;
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

fn holds(level: u16, seed: u64, strength: f64, boss: f64, margin: f64) -> Option<DbLevel> {
    let script = build(level, seed, strength, boss);
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
        if holds(level, seed, STRENGTH.0, BOSS_FLOOR, CEILING_MARGIN).is_none() {
            continue;
        }
        // Binary search for the ceiling: the strongest horde still held (against a
        // small boss, so the horde sets the difficulty).
        let (mut lo, mut hi) = STRENGTH;
        for _ in 0..SEARCH_STEPS {
            let mid = (lo + hi) / 2.0;
            if holds(level, seed, mid, BOSS_FLOOR, CEILING_MARGIN).is_some() {
                lo = mid;
            } else {
                hi = mid;
            }
        }
        // Set the level at its share of the ceiling, then give it the biggest boss it
        // still holds with this level's (larger) margin; step the horde down if none.
        let mut strength = (lo * p.share).max(STRENGTH.0);
        loop {
            let mut boss = 1.0;
            while boss >= BOSS_FLOOR {
                if let Some(found) = holds(level, seed, strength, boss, p.margin) {
                    return found;
                }
                boss *= 0.85;
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
        let boss = l
            .script
            .spawns
            .iter()
            .find(|s| s.kind == ZKind::Boss)
            .map_or(0, |s| s.hp);
        eprintln!(
            "  db {:>3}: strength {:.2}, {:>3} zombies, {:>2} cages, boss {:>5} hp, bot kept {:>2}/{} hp in {}s",
            l.level,
            l.strength,
            l.script.spawns.len(),
            l.script.cages.len(),
            boss,
            l.bot_hp,
            l.script.base_hp,
            l.bot_seconds
        );
    }
    levels
}
