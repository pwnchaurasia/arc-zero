//! TraceOut level pipeline (design doc §3).
//!
//! 1. Lay lines one at a time. A new line's exit (head to board edge) must be
//!    clear of every line already placed; its body may cross earlier exits, and
//!    that is what makes the puzzle. Removing lines in reverse order then always
//!    works, so every level is solvable by construction (and checked again).
//! 2. Harder levels try several placements per line and keep the one that blocks
//!    the most existing lines.
//! 3. Several candidates per level; keep the one whose "clear this first" chain
//!    (rounds of removing every free line at once) is closest to the target.
//!
//! Every 5th level from 5 on is laid inside a picture (heart, diamond, ...).

use arc_engine::rng::Rng;
use arc_engine::traceout::{Game, Level, Line};
use rayon::prelude::*;
use serde::Serialize;

use crate::derive_seed;

const CANDIDATES: usize = 8;
const THEMES: [&str; 6] = ["heart", "diamond", "circle", "hourglass", "cross", "ring"];

#[derive(Clone, Debug, Serialize)]
pub struct TraceLevel {
    pub level: u16,
    pub data: Level,
    /// Rounds of removing every free line at once.
    pub depth: usize,
    /// Lines that can leave at the very start.
    pub free_at_start: usize,
}

struct Params {
    width: u8,
    height: u8,
    /// Share of (picture) cells to cover with lines.
    fill: f64,
    max_len: usize,
    max_turns: usize,
    /// Placements tried per line; the most blocking one wins.
    tangle: usize,
    depth: f64,
}

fn lerp(a: f64, b: f64, t: f64) -> f64 {
    a + (b - a) * t
}

/// Levels 1–3 are a warm-up; from level 4 the board, the tangle and the chains grow.
fn params(level: u16) -> Params {
    let t = (f64::from(level.max(4)) - 4.0) / 96.0;
    let warm = level <= 3;
    let width = if warm {
        4 + level as u8
    } else {
        lerp(7.0, 14.0, t).round() as u8
    };
    let height = ((f64::from(width) * 1.4).round() as u8).min(24);
    Params {
        width,
        height,
        fill: if warm { 0.55 } else { lerp(0.75, 0.92, t) },
        max_len: if warm {
            3
        } else {
            lerp(4.0, 7.0, t).round() as usize
        },
        max_turns: if warm {
            1
        } else {
            lerp(1.0, 4.0, t).round() as usize
        },
        tangle: if warm {
            1
        } else {
            lerp(3.0, 40.0, t).round() as usize
        },
        depth: if warm { 2.0 } else { lerp(4.0, 14.0, t) },
    }
}

/// Cells inside the picture for silhouette levels (all cells otherwise).
fn mask(theme: Option<&str>, w: usize, h: usize) -> Vec<bool> {
    let mut out = vec![true; w * h];
    let Some(theme) = theme else {
        return out;
    };
    for y in 0..h {
        for x in 0..w {
            // -1..1 across the board, y pointing up.
            let nx = (x as f64 + 0.5) / w as f64 * 2.0 - 1.0;
            let ny = 1.0 - (y as f64 + 0.5) / h as f64 * 2.0;
            let r = (nx * nx + ny * ny).sqrt();
            out[y * w + x] = match theme {
                "heart" => {
                    let (x, y) = (nx * 1.25, ny * 1.25 + 0.2);
                    (x * x + y * y - 1.0).powi(3) - x * x * y.powi(3) <= 0.0
                }
                "diamond" => nx.abs() + ny.abs() <= 1.05,
                "circle" => r <= 1.0,
                "hourglass" => nx.abs() <= ny.abs() + 0.2,
                "cross" => nx.abs() < 0.4 || ny.abs() < 0.32,
                "ring" => (0.42..=1.0).contains(&r),
                _ => true,
            };
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
        let want = 2 + rng.below((p.max_len - 1) as u64) as usize;
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
                let sides = [(gy, gx), (-gy, -gx)];
                if rng.chance(1, 3) {
                    options.insert(0, sides[rng.below(2) as usize]);
                } else {
                    options.push(sides[rng.below(2) as usize]);
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

    /// Phase 2: a line anywhere, kept only if the level stays solvable.
    fn densify(&mut self, rng: &mut Rng, p: &Params) -> bool {
        let Some(body) = self.sample(rng, p, false) else {
            return false;
        };
        self.heights.push(1);
        self.push(&body);
        if self.level(p).solvable() {
            return true;
        }
        let line = self.lines.pop().unwrap_or(Line { cells: Vec::new() });
        self.heights.pop();
        for &[x, y] in &line.cells {
            self.occ[usize::from(y) * self.w + usize::from(x)] = 0;
        }
        false
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
    let theme = (level >= 5 && level.is_multiple_of(5))
        .then(|| THEMES[usize::from(level / 5) % THEMES.len()]);
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
    while failures < 60 && !full(&board) {
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
    // Shuffle line order so indices say nothing about the solution order.
    rng.shuffle(&mut board.lines);
    let data = Level {
        width: p.width,
        height: p.height,
        lines: board.lines,
        theme: theme.map(str::to_owned),
    };
    data.validate().ok()?;
    let depth = data.depth()?;
    let free_at_start = Game::new(&data).ok()?.free_lines().len();
    Some(TraceLevel {
        level,
        data,
        depth,
        free_at_start,
    })
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
                .min_by(|a, b| {
                    (a.depth as f64 - target)
                        .abs()
                        .total_cmp(&(b.depth as f64 - target).abs())
                })
                .unwrap_or_else(|| panic!("traceout level {level}: no valid candidate"));
            eprintln!(
                "  to level {level}: {}x{} {} lines, depth {} (target {target:.1}), {} free at start{}",
                best.data.width,
                best.data.height,
                best.data.lines.len(),
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
        let heart = candidate(5, 3).expect("level 5");
        assert!(heart.data.theme.is_some());
    }
}
