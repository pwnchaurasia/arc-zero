//! TraceOut level pipeline (design doc §3).
//!
//! 1. Lay lines one at a time. A new line's exit (head to board edge) must be
//!    clear of every line already placed; its body may cross earlier exits, and
//!    that is what makes the puzzle. Removing lines in reverse order then always
//!    works, so every level is solvable by construction (and checked again).
//! 2. Harder levels try several placements per line and keep the one that blocks
//!    the most existing lines. Lines are long, winding random walks (decision
//!    2026-11-04: tangled like the reference apps, not short straight sticks).
//! 3. Lines anywhere (kept only if the level stays solvable) fill the rest, then
//!    short ones plug the holes so the board looks packed.
//! 4. Several candidates per level; keep the one whose "clear this first" chain
//!    (rounds of removing every free line at once) is closest to the target.
//!
//! Every level from 4 on is laid inside a picture (see `pictures.rs`), packed tight so
//! the lines draw it, like the reference apps.

use arc_engine::rng::Rng;
use arc_engine::traceout::{Game, Level, Line};
use rayon::prelude::*;
use serde::Serialize;

use crate::derive_seed;
use crate::pictures::{self, PICTURES};

const CANDIDATES: usize = 8;
/// Lines sampled per densify step, and how many of the best are tried.
const DENSIFY_SAMPLES: usize = 8;
const DENSIFY_TRIES: usize = 3;

#[derive(Clone, Debug, Serialize)]
pub struct TraceLevel {
    pub level: u16,
    pub data: Level,
    /// Rounds of removing every free line at once.
    pub depth: usize,
    /// Lines that can leave at the very start.
    pub free_at_start: usize,
    /// Share of the picture's cells covered by lines (for the log).
    #[serde(skip)]
    pub cover: f64,
}

struct Params {
    width: u8,
    height: u8,
    /// Share of (picture) cells to cover with lines.
    fill: f64,
    min_len: usize,
    max_len: usize,
    max_turns: usize,
    /// Chance (in %) that a line turns at each cell it grows.
    turn_pct: u64,
    /// Placements tried per line; the most blocking one wins.
    tangle: usize,
    depth: f64,
}

fn lerp(a: f64, b: f64, t: f64) -> f64 {
    a + (b - a) * t
}

/// Level 1 is a warm-up and 2–3 a gentle step; from level 4 the board grows, lines get
/// longer and twistier, and the "clear this first" chains get deeper.
fn params(level: u16) -> Params {
    let t = (f64::from(level.max(4)) - 4.0) / 96.0;
    if level <= 3 {
        let l = level as usize;
        return Params {
            width: 4 + level as u8,
            height: [7, 9, 10][l - 1],
            fill: [0.6, 0.75, 0.8][l - 1],
            min_len: 2,
            max_len: [3, 5, 6][l - 1],
            max_turns: [0, 1, 2][l - 1],
            turn_pct: [0, 25, 30][l - 1],
            tangle: [1, 4, 6][l - 1],
            depth: [2.0, 3.0, 4.0][l - 1],
        };
    }
    // Boards grow fastest early on: more lines means longer chains, and more cells
    // draw the picture in finer detail. From level 5 boards are big enough that
    // players pinch to zoom (decision 2026-11-04: about 70% more complex).
    let width = if level == 4 {
        11
    } else {
        lerp(14.0, 34.0, t.sqrt()).round() as u8
    };
    Params {
        width,
        height: ((f64::from(width) * 1.42).round() as u8).min(arc_engine::traceout::MAX_SIDE),
        // Share of the picture's cells covered by lines: high, so the shape reads.
        fill: lerp(0.93, 0.985, t),
        min_len: lerp(3.0, 6.0, t).round() as usize,
        max_len: lerp(8.0, 24.0, t).round() as usize,
        max_turns: lerp(4.0, 14.0, t).round() as usize,
        turn_pct: lerp(32.0, 48.0, t).round() as u64,
        tangle: lerp(12.0, 48.0, t).round() as usize,
        depth: lerp(10.0, 36.0, t),
    }
}

/// Cells inside the picture (all cells when there is none). The picture is scaled to
/// fill the board, keeping its proportions, with a cell of paper around it.
fn mask(theme: Option<&str>, w: usize, h: usize) -> Vec<bool> {
    let Some(theme) = theme else {
        return vec![true; w * h];
    };
    // The picture's bounding box, found by sampling its coordinate space finely.
    let (mut x0, mut x1, mut y0, mut y1) = (f64::MAX, f64::MIN, f64::MAX, f64::MIN);
    for i in 0..=200 {
        for j in 0..=280 {
            let (x, y) = (-1.0 + f64::from(i) / 100.0, -1.4 + f64::from(j) / 100.0);
            if pictures::inside(theme, x, y) {
                (x0, x1, y0, y1) = (x0.min(x), x1.max(x), y0.min(y), y1.max(y));
            }
        }
    }
    // Board units per picture unit: as large as fits inside a one-cell margin.
    let scale = ((w as f64 - 2.0) / (x1 - x0)).min((h as f64 - 2.0) / (y1 - y0));
    let (cx, cy) = ((x0 + x1) / 2.0, (y0 + y1) / 2.0);
    let mut out = vec![false; w * h];
    for y in 0..h {
        for x in 0..w {
            let px = cx + (x as f64 + 0.5 - w as f64 / 2.0) / scale;
            let py = cy - (y as f64 + 0.5 - h as f64 / 2.0) / scale;
            out[y * w + x] = pictures::inside(theme, px, py);
        }
    }
    out
}

struct Board {
    w: usize,
    h: usize,
    /// Line index + 1 per cell.
    occ: Vec<u16>,
    mask: Vec<bool>,
    lines: Vec<Line>,
    /// Per line: 1 + the longest chain of lines it keeps waiting.
    heights: Vec<usize>,
}

impl Board {
    fn at(&self, x: i32, y: i32) -> Option<usize> {
        (x >= 0 && y >= 0 && (x as usize) < self.w && (y as usize) < self.h)
            .then(|| y as usize * self.w + x as usize)
    }

    /// Cells from `(x, y)` (exclusive) to the edge in direction `(dx, dy)`.
    fn ray(&self, x: i32, y: i32, dx: i32, dy: i32) -> Vec<usize> {
        let mut out = Vec::new();
        let (mut cx, mut cy) = (x + dx, y + dy);
        while let Some(i) = self.at(cx, cy) {
            out.push(i);
            cx += dx;
            cy += dy;
        }
        out
    }

    /// Indices of lines whose exit runs through any of `cells`.
    fn blocks(&self, cells: &[usize]) -> Vec<usize> {
        (0..self.lines.len())
            .filter(|i| {
                let l = &self.lines[*i];
                let [hx, hy] = l.head();
                let (dx, dy) = l.dir();
                self.ray(i32::from(hx), i32::from(hy), i32::from(dx), i32::from(dy))
                    .iter()
                    .any(|c| cells.contains(c))
            })
            .collect()
    }

    /// One random line: head first, then the body grown backwards from it.
    /// With `clear_exit`, the new line's exit must already be free (phase 1).
    fn sample(&self, rng: &mut Rng, p: &Params, clear_exit: bool) -> Option<Vec<usize>> {
        const DIRS: [(i32, i32); 4] = [(0, -1), (1, 0), (0, 1), (-1, 0)];
        let free: Vec<usize> = (0..self.w * self.h)
            .filter(|i| self.mask[*i] && self.occ[*i] == 0)
            .collect();
        if free.is_empty() {
            return None;
        }
        let head = free[rng.below(free.len() as u64) as usize];
        let (hx, hy) = ((head % self.w) as i32, (head / self.w) as i32);
        let (dx, dy) = DIRS[rng.below(4) as usize];
        let ray = self.ray(hx, hy, dx, dy);
        if clear_exit && ray.iter().any(|c| self.occ[*c] != 0) {
            return None;
        }
        let want = p.min_len + rng.below((p.max_len + 1 - p.min_len) as u64) as usize;
        let mut body = vec![head];
        let (mut x, mut y) = (hx, hy);
        // Grow away from the arrow: the cell behind the head comes first.
        let (mut gx, mut gy) = (-dx, -dy);
        let mut turns = 0;
        while body.len() < want {
            let straight = (gx, gy);
            let mut options = vec![straight];
            // The cell right behind the head must be straight, or there is no arrow.
            if turns < p.max_turns && body.len() > 1 {
                let mut sides = [(gy, gx), (-gy, -gx)];
                if rng.chance(1, 2) {
                    sides.swap(0, 1);
                }
                // Turn by choice `turn_pct` of the time; otherwise only when blocked.
                if rng.chance(p.turn_pct, 100) {
                    options.splice(0..0, sides);
                } else {
                    options.extend(sides);
                }
            }
            let next = options.into_iter().find_map(|(ox, oy)| {
                let i = self.at(x + ox, y + oy)?;
                (self.mask[i] && self.occ[i] == 0 && !body.contains(&i) && !ray.contains(&i))
                    .then_some((i, ox, oy))
            });
            let Some((i, ox, oy)) = next else { break };
            if (ox, oy) != straight {
                turns += 1;
            }
            (gx, gy) = (ox, oy);
            x += ox;
            y += oy;
            body.push(i);
        }
        // The arrow needs a body cell behind it pointing the right way.
        let behind = self.at(hx - dx, hy - dy)?;
        (body.len() >= 2 && body[1] == behind).then_some(body)
    }

    fn place(&mut self, rng: &mut Rng, p: &Params) -> bool {
        // Prefer lines that extend the longest chain, then block the most lines.
        let mut best: Option<(usize, usize, Vec<usize>)> = None;
        let mut tries = 0;
        let mut found = 0;
        while found < p.tangle && tries < p.tangle * 40 {
            tries += 1;
            let Some(body) = self.sample(rng, p, true) else {
                continue;
            };
            found += 1;
            let blocked = self.blocks(&body);
            let height = 1 + blocked.iter().map(|i| self.heights[*i]).max().unwrap_or(0);
            let score = height * 1_000 + blocked.len() * 16 + body.len();
            if best.as_ref().is_none_or(|(s, _, _)| score > *s) {
                best = Some((score, height, body));
            }
        }
        let Some((_, height, body)) = best else {
            return false;
        };
        self.heights.push(height);
        self.push(&body);
        true
    }

    /// Phase 2: a line anywhere, kept only if the level stays solvable. Of a few
    /// samples, the most tangled one that keeps it solvable wins: its own way out is
    /// blocked, and it blocks as many lines as possible.
    fn densify(&mut self, rng: &mut Rng, p: &Params) -> bool {
        let mut options: Vec<(usize, Vec<usize>)> = (0..DENSIFY_SAMPLES)
            .filter_map(|_| self.sample(rng, p, false))
            .map(|body| {
                let [hx, hy] = [body[0] % self.w, body[0] / self.w];
                let behind = body[1];
                let (dx, dy) = (
                    hx as i32 - (behind % self.w) as i32,
                    hy as i32 - (behind / self.w) as i32,
                );
                let stuck = self
                    .ray(hx as i32, hy as i32, dx, dy)
                    .iter()
                    .any(|c| self.occ[*c] != 0);
                (self.blocks(&body).len() * 2 + usize::from(stuck) * 3, body)
            })
            .collect();
        options.sort_by_key(|(score, _)| std::cmp::Reverse(*score));
        for (_, body) in options.into_iter().take(DENSIFY_TRIES) {
            self.heights.push(1);
            self.push(&body);
            if self.level(p).solvable() {
                return true;
            }
            self.pop();
        }
        false
    }

    fn pop(&mut self) {
        let line = self.lines.pop().unwrap_or(Line { cells: Vec::new() });
        self.heights.pop();
        for &[x, y] in &line.cells {
            self.occ[usize::from(y) * self.w + usize::from(x)] = 0;
        }
    }

    fn level(&self, p: &Params) -> Level {
        Level {
            width: p.width,
            height: p.height,
            lines: self.lines.clone(),
            theme: None,
        }
    }

    fn push(&mut self, body: &[usize]) {
        let id = u16::try_from(self.lines.len() + 1).unwrap_or(u16::MAX);
        let cells = body
            .iter()
            .rev()
            .map(|i| {
                self.occ[*i] = id;
                [(i % self.w) as u8, (i / self.w) as u8]
            })
            .collect();
        self.lines.push(Line { cells });
    }
}

fn candidate(level: u16, seed: u64) -> Option<TraceLevel> {
    let p = params(level);
    let mut rng = Rng::new(seed);
    let theme = (level >= 4).then(|| PICTURES[usize::from(level - 4) % PICTURES.len()]);
    let (w, h) = (usize::from(p.width), usize::from(p.height));
    let mut board = Board {
        w,
        h,
        occ: vec![0; w * h],
        mask: mask(theme, w, h),
        lines: Vec::new(),
        heights: Vec::new(),
    };
    let area = board.mask.iter().filter(|m| **m).count();
    let full = |b: &Board| {
        let covered = b.occ.iter().filter(|c| **c != 0).count();
        covered as f64 >= area as f64 * p.fill || b.lines.len() >= arc_engine::traceout::MAX_LINES
    };
    let mut failures = 0;
    while failures < 80 && !full(&board) {
        if board.place(&mut rng, &p) {
            failures = 0;
        } else {
            failures += 1;
        }
    }
    failures = 0;
    while failures < 600 && !full(&board) {
        if board.densify(&mut rng, &p) {
            failures = 0;
        } else {
            failures += 1;
        }
    }
    // Plug the holes with short lines (still only if the level stays solvable).
    let short = Params {
        min_len: 2,
        max_len: 4,
        ..p
    };
    failures = 0;
    while failures < 400 && !full(&board) {
        if board.densify(&mut rng, &short) {
            failures = 0;
        } else {
            failures += 1;
        }
    }
    // Last, 2-cell lines into whatever gaps are left, so the picture has no holes.
    let pairs = Params {
        min_len: 2,
        max_len: 2,
        ..p
    };
    failures = 0;
    while failures < 600 && !full(&board) {
        if board.densify(&mut rng, &pairs) {
            failures = 0;
        } else {
            failures += 1;
        }
    }
    // Shuffle line order so indices say nothing about the solution order.
    rng.shuffle(&mut board.lines);
    let data = Level {
        width: p.width,
        height: p.height,
        lines: board.lines,
        theme: theme.map(str::to_owned),
    };
    let covered = board.occ.iter().filter(|c| **c != 0).count() as f64 / area.max(1) as f64;
    data.validate().ok()?;
    let depth = data.depth()?;
    let free_at_start = Game::new(&data).ok()?.free_lines().len();
    Some(TraceLevel {
        level,
        data,
        depth,
        free_at_start,
        cover: covered,
    })
}

/// How far a candidate is from what we want: its chain depth near the target, few
/// lines free at the start (a point per 5% free), and the picture fully drawn (a point
/// per 2% of it left uncovered).
fn miss(c: &TraceLevel, target: f64) -> f64 {
    let free = c.free_at_start as f64 / c.data.lines.len().max(1) as f64;
    (c.depth as f64 - target).abs() + free * 20.0 + (1.0 - c.cover) * 50.0
}

pub fn generate(master: &str, max_level: u16) -> Vec<TraceLevel> {
    (1..=max_level)
        .into_par_iter()
        .map(|level| {
            let target = params(level).depth;
            let best = (0..CANDIDATES)
                .filter_map(|i| {
                    let seed = derive_seed(master, &["to", &level.to_string(), &i.to_string()]);
                    candidate(level, seed)
                })
                .min_by(|a, b| miss(a, target).total_cmp(&miss(b, target)))
                .unwrap_or_else(|| panic!("traceout level {level}: no valid candidate"));
            eprintln!(
                "  to level {level}: {}x{} {} lines, {:.0}% covered, depth {} (target {target:.1}), {} free at start{}",
                best.data.width,
                best.data.height,
                best.data.lines.len(),
                best.cover * 100.0,
                best.depth,
                best.free_at_start,
                best.data.theme.as_deref().map(|t| format!(", {t}")).unwrap_or_default()
            );
            best
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn levels_are_solvable_and_grow() {
        let easy = candidate(1, 1).expect("level 1");
        let hard = candidate(80, 1).expect("level 80");
        assert!(easy.data.lines.len() < hard.data.lines.len());
        assert!(easy.depth <= hard.depth);
        assert!(hard.data.solvable());
        let picture = candidate(5, 3).expect("level 5");
        assert!(picture.data.theme.is_some());
    }
}
