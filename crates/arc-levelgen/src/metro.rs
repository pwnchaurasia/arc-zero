//! MetroJam level pipeline (design doc §4).
//!
//! 1. Build the jam backwards: each vehicle is placed only where its way out is
//!    clear at that moment, so the jam can always be emptied.
//! 2. Build the queue from a plan: a valid removal order is played with the real
//!    rules, and commuters are generated for whatever is parked. The plan is then
//!    replayed on the finished queue, which proves the level winnable without assists.
//! 3. Measure difficulty with a noisy bot that sees only the visible queue, and
//!    keep the candidate closest to the level's target.

use arc_engine::metro_jam::bot::win_rate;
use arc_engine::metro_jam::{Dir, Game, Kind, Level, Vehicle};

use arc_engine::rng::Rng;
use rayon::prelude::*;
use serde::Serialize;

use crate::derive_seed;

const CANDIDATES: usize = 24;
const BOT_RUNS: u32 = 48;
/// A careless player and a careful one; difficulty averages their losses.
const BOT_NOISE_PCT: [u64; 2] = [20, 3];
const PLACE_TRIES: usize = 4_000;
const PLAN_TRIES: usize = 8;

#[derive(Clone, Debug, Serialize)]
pub struct MjLevel {
    pub level: u16,
    pub data: Level,
    /// Bot wins out of BOT_RUNS, careless then careful.
    pub bot_wins: [u32; 2],
    pub difficulty: f64,
}

struct Params {
    width: u8,
    height: u8,
    colors: u8,
    bays: u8,
    fill_pct: u64,
    kinds: Vec<(Kind, u64)>,
    barriers: usize,
    /// None: the whole queue is visible.
    visible: Option<u16>,
    stick_pct: u64,
    /// Target share of noisy-bot losses, 0..1.
    target: f64,
}

fn lerp(a: f64, b: f64, t: f64) -> f64 {
    a + (b - a) * t.clamp(0.0, 1.0)
}

fn round_u8(v: f64) -> u8 {
    v.round().clamp(0.0, 255.0) as u8
}

/// Levels 1–3 are a gentle introduction; real difficulty starts at level 4.
fn params(level: u16) -> Params {
    if level <= 3 {
        // Easy but needs thought (decision 2026-11-02): a few cars block each other,
        // 4 colours, 4 bays, and only the next 10 commuters are visible.
        return Params {
            width: 6,
            height: 7,
            colors: 4,
            bays: 4,
            fill_pct: 48 + 4 * u64::from(level),
            kinds: vec![(Kind::Microcar, 2), (Kind::Hatchback, 4), (Kind::Sedan, 3), (Kind::Mpv, 2)],
            barriers: 0,
            visible: Some(10),
            stick_pct: 45,
            target: 0.16 + 0.05 * f64::from(level),
        };
    }
    let t = f64::from(level - 4) / 96.0;
    let width = round_u8(lerp(6.0, 9.0, t));
    let mut kinds = vec![
        (Kind::Microcar, 3),
        (Kind::Hatchback, 4),
        (Kind::Sedan, 4),
        (Kind::Mpv, 3),
    ];
    if level >= 8 {
        kinds.push((Kind::Minivan, 2));
    }
    if level >= 20 {
        kinds.push((Kind::Minibus, 2));
    }
    if level >= 30 {
        kinds.push((Kind::Bus, if level >= 80 { 2 } else { 1 }));
    }
    Params {
        width,
        height: (width + 1).min(10),
        colors: round_u8(lerp(4.0, 7.0, t)),
        bays: 4,
        fill_pct: lerp(55.0, 80.0, t).round() as u64,
        kinds,
        barriers: if level >= 30 {
            usize::from(round_u8(lerp(1.0, 5.0, t)))
        } else {
            0
        },
        // The far end of the queue is always hidden; the view narrows as levels rise.
        visible: Some(u16::from(round_u8(lerp(12.0, 6.0, t)))),
        stick_pct: lerp(45.0, 5.0, t).round() as u64,
        target: lerp(0.35, 0.97, t),
    }
}

fn pick_weighted<T: Copy>(rng: &mut Rng, items: &[(T, u64)]) -> T {
    let total: u64 = items.iter().map(|(_, w)| w).sum();
    let mut roll = rng.below(total);
    for &(item, w) in items {
        if roll < w {
            return item;
        }
        roll -= w;
    }
    items[0].0
}

fn cells_of(kind: Kind, x: i16, y: i16, dir: Dir) -> Vec<(i16, i16)> {
    let (dx, dy) = dir.delta();
    (0..i16::from(kind.length()))
        .map(|i| (x - dx * i, y - dy * i))
        .collect()
}

/// Places vehicles backwards so the reverse placement order always empties the jam.
fn build_jam(rng: &mut Rng, p: &Params) -> (Vec<(u8, u8)>, Vec<Vehicle>) {
    let (w, h) = (i16::from(p.width), i16::from(p.height));
    let inside = |x: i16, y: i16| (0..w).contains(&x) && (0..h).contains(&y);
    let mut taken = vec![false; usize::from(p.width) * usize::from(p.height)];
    let at = |x: i16, y: i16| usize::try_from(y * w + x).expect("inside");

    let mut barriers = Vec::new();
    while barriers.len() < p.barriers {
        // Barriers stay off the outer ring so they block paths, not exits.
        let x = rng.range(1, i64::from(w - 2)) as i16;
        let y = rng.range(1, i64::from(h - 2)) as i16;
        if !taken[at(x, y)] {
            taken[at(x, y)] = true;
            barriers.push((x as u8, y as u8));
        }
    }

    let target =
        usize::from(p.width) * usize::from(p.height) * usize::try_from(p.fill_pct).unwrap_or(0)
            / 100;
    let mut filled = 0usize;
    let mut vehicles = Vec::new();
    for _ in 0..PLACE_TRIES {
        if filled >= target {
            break;
        }
        let kind = pick_weighted(rng, &p.kinds);
        let dir = [Dir::N, Dir::E, Dir::S, Dir::W][usize::try_from(rng.below(4)).unwrap_or(0)];
        let x = rng.range(0, i64::from(w - 1)) as i16;
        let y = rng.range(0, i64::from(h - 1)) as i16;
        let cells = cells_of(kind, x, y, dir);
        if !cells
            .iter()
            .all(|&(cx, cy)| inside(cx, cy) && !taken[at(cx, cy)])
        {
            continue;
        }
        let (dx, dy) = dir.delta();
        let (mut px, mut py) = (x + dx, y + dy);
        let mut clear = true;
        while inside(px, py) {
            if taken[at(px, py)] {
                clear = false;
                break;
            }
            px += dx;
            py += dy;
        }
        if !clear {
            continue;
        }
        for &(cx, cy) in &cells {
            taken[at(cx, cy)] = true;
        }
        filled += cells.len();
        vehicles.push(Vehicle {
            kind,
            color: 0,
            x: x as u8,
            y: y as u8,
            dir,
        });
    }
    // Every colour appears; the rest are random.
    let n = vehicles.len();
    let mut colors: Vec<u8> = (0..n)
        .map(|i| u8::try_from(i % usize::from(p.colors)).unwrap_or(0))
        .collect();
    rng.shuffle(&mut colors);
    for (v, c) in vehicles.iter_mut().zip(colors) {
        v.color = c;
    }
    (barriers, vehicles)
}

fn free_bay(game: &Game) -> bool {
    game.bays().iter().any(Option::is_none)
}

/// A random removal order that is always physically possible.
fn removal_order(rng: &mut Rng, base: &Level) -> Option<Vec<u8>> {
    let (w, h) = (i16::from(base.width), i16::from(base.height));
    let at = |x: i16, y: i16| usize::try_from(y * w + x).expect("inside");
    // Cell owner: vehicle index + 1, or 0 for empty. Barriers never move.
    let mut grid = vec![0usize; usize::from(base.width) * usize::from(base.height)];
    for &(x, y) in &base.barriers {
        grid[at(i16::from(x), i16::from(y))] = usize::MAX;
    }
    for (i, v) in base.vehicles.iter().enumerate() {
        for (cx, cy) in v.cells() {
            grid[at(cx, cy)] = i + 1;
        }
    }
    let exitable = |grid: &[usize], v: &Vehicle| {
        let (dx, dy) = v.dir.delta();
        let (mut x, mut y) = (i16::from(v.x) + dx, i16::from(v.y) + dy);
        while (0..w).contains(&x) && (0..h).contains(&y) {
            if grid[at(x, y)] != 0 {
                return false;
            }
            x += dx;
            y += dy;
        }
        true
    };
    let mut left: Vec<usize> = (0..base.vehicles.len()).collect();
    let mut order = Vec::with_capacity(left.len());
    while !left.is_empty() {
        let options: Vec<usize> = left
            .iter()
            .copied()
            .filter(|&i| exitable(&grid, &base.vehicles[i]))
            .collect();
        if options.is_empty() {
            return None;
        }
        let pick = options[usize::try_from(rng.below(options.len() as u64)).unwrap_or(0)];
        for (cx, cy) in base.vehicles[pick].cells() {
            grid[at(cx, cy)] = 0;
        }
        left.retain(|&i| i != pick);
        order.push(u8::try_from(pick).ok()?);
    }
    Some(order)
}

/// Plays `order` with the real rules, generating commuters for what is parked.
fn plan_queue(rng: &mut Rng, base: &Level, order: &[u8], stick_pct: u64) -> Option<Vec<u8>> {
    let mut game = Game::new(base).ok()?;
    let mut next = 0usize;
    let mut last: Option<u8> = None;
    while !game.is_won() {
        while free_bay(&game) && next < order.len() {
            game.tap(order[next]).ok()?;
            next += 1;
        }
        let open: Vec<(u8, u64)> = game
            .bays()
            .iter()
            .flatten()
            .map(|b| {
                let v = base.vehicles[usize::from(b.vehicle)];
                (v.color, u64::from(v.kind.riders() - b.riders))
            })
            .filter(|(_, seats)| *seats > 0)
            .collect();
        if open.is_empty() {
            return None;
        }
        let color = match last {
            Some(c) if open.iter().any(|(oc, _)| *oc == c) && rng.chance(stick_pct, 100) => c,
            _ => pick_weighted(rng, &open),
        };
        last = Some(color);
        game.extend_queue(&[color]);
    }
    Some(game.queue().to_vec())
}

/// The plan replayed on the finished queue: tap in order whenever a bay is free.
fn plan_wins(level: &Level, order: &[u8]) -> bool {
    let Ok(mut game) = Game::new(level) else {
        return false;
    };
    for &v in order {
        if !free_bay(&game) || game.tap(v).is_err() {
            return false;
        }
    }
    game.is_won()
}

fn candidate(level: u16, seed: u64) -> Option<MjLevel> {
    let p = params(level);
    let mut rng = Rng::new(seed);
    let (barriers, vehicles) = build_jam(&mut rng, &p);
    if vehicles.len() < usize::from(p.colors) * 2 {
        return None;
    }
    let total: usize = vehicles.iter().map(|v| usize::from(v.kind.riders())).sum();
    let queue_len = u16::try_from(total).ok()?;
    let mut base = Level {
        width: p.width,
        height: p.height,
        barriers,
        vehicles,
        queue: Vec::new(),
        queue_len,
        bays: p.bays,
        visible: p.visible.unwrap_or(queue_len).min(queue_len),
    };
    for _ in 0..PLAN_TRIES {
        let order = removal_order(&mut rng, &base)?;
        let Some(queue) = plan_queue(&mut rng, &base, &order, p.stick_pct) else {
            continue;
        };
        base.queue = queue;
        if base.validate(true).is_ok() && plan_wins(&base, &order) {
            let wins = BOT_NOISE_PCT.map(|noise| win_rate(&base, seed ^ noise, BOT_RUNS, noise));
            return Some(MjLevel {
                level,
                difficulty: 1.0 - f64::from(wins[0] + wins[1]) / f64::from(2 * BOT_RUNS),
                bot_wins: wins,
                data: base,
            });
        }
        base.queue.clear();
    }
    None
}

pub fn generate(master: &str, max_level: u16) -> Vec<MjLevel> {
    (1..=max_level)
        .into_par_iter()
        .map(|level| {
            let target = {
                let t = params(level).target;
                if level.is_multiple_of(10) && level != 100 { t - 0.15 } else { t }
            };
            let pool: Vec<MjLevel> = (0..CANDIDATES)
                .filter_map(|i| {
                    let seed = derive_seed(master, &["mj", &level.to_string(), &i.to_string()]);
                    candidate(level, seed)
                })
                .collect();
            let best = pool
                .into_iter()
                .min_by(|a, b| {
                    (a.difficulty - target)
                        .abs()
                        .total_cmp(&(b.difficulty - target).abs())
                })
                .unwrap_or_else(|| panic!("metro jam level {level}: no winnable candidate"));
            eprintln!(
                "  mj level {level}: {} vehicles, {} commuters, bot {:?}/{BOT_RUNS} (loss {:.2}, target {:.2})",
                best.data.vehicles.len(),
                best.data.queue_len,
                best.bot_wins,
                best.difficulty,
                target
            );
            best
        })
        .collect()
}
