//! Offline level generator.
//!
//! Builds the 100 levels of each game from a secret master seed, proves each
//! one can be finished, and orders them by measured difficulty. The output
//! file is server-only: it must never be committed or served to clients.
//!
//! Usage:
//!   ARC_LEVEL_SEED=<secret> arc-levelgen --out-dir levels [--game all|water-sort|brick-blast|metro-jam|dead-bridge|traceout|gridsnap|cipher9|logoquest] [--levels 100]
//!
//! Each game gets its own file (`levels/<game>.json`), so regenerating one game never
//! touches the others.

mod brick;
mod bridge;
mod grid;
mod logo;
mod metro;
mod pictures;
mod sudoku;
mod trace;
mod water;

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::Instant;

use arc_engine::hash::Fnv64;
use serde::Serialize;

pub const LEVELS_FILE_VERSION: u32 = 2;

/// Builds levels `1..=max_level` on every core, the highest (slowest) first, and returns
/// them in level order.
///
/// Late levels take far longer than early ones. Started last (as a plain parallel
/// iterator over `1..=max_level` tends to), they leave a long tail with most cores idle;
/// started first, the quick ones fill in around them. Each level depends only on its own
/// seed, so the order of work never changes the output.
pub fn heavy_first<T: Send>(max_level: u16, build: impl Fn(u16) -> T + Sync) -> Vec<T> {
    let order: Vec<u16> = (1..=max_level).rev().collect();
    let next = AtomicUsize::new(0);
    let built = Mutex::new(Vec::with_capacity(order.len()));
    let (order_ref, next_ref, built_ref, build_ref) = (&order, &next, &built, &build);
    rayon::scope(|s| {
        for _ in 0..rayon::current_num_threads() {
            s.spawn(move |_| {
                while let Some(&level) = order_ref.get(next_ref.fetch_add(1, Ordering::Relaxed)) {
                    let one = build_ref(level);
                    built_ref
                        .lock()
                        .expect("a panic aborts the process")
                        .push((level, one));
                }
            });
        }
    });
    let mut levels = built.into_inner().expect("a panic aborts the process");
    levels.sort_by_key(|(level, _)| *level);
    levels.into_iter().map(|(_, one)| one).collect()
}

/// Derives an independent per-item seed from the master secret.
pub fn derive_seed(master: &str, parts: &[&str]) -> u64 {
    let mut h = Fnv64::default();
    h.write(master.as_bytes());
    for part in parts {
        h.write_u8(0x1f);
        h.write(part.as_bytes());
    }
    u64::from_str_radix(&h.hex(), 16).expect("fnv hex is valid")
}

/// One game's levels: `<out-dir>/<game>.json`.
#[derive(Serialize)]
struct LevelsFile<'a, T: Serialize> {
    version: u32,
    game: &'a str,
    levels: &'a [T],
}

/// Writes atomically (temp file, then rename) so the API never reads a half-written file.
fn write_game<T: Serialize>(dir: &Path, game: &str, levels: &[T]) -> Result<(), String> {
    let file = LevelsFile {
        version: LEVELS_FILE_VERSION,
        game,
        levels,
    };
    let json = serde_json::to_vec(&file).map_err(|e| format!("serialise {game}: {e}"))?;
    let path = dir.join(format!("{game}.json"));
    let tmp = dir.join(format!(".{game}.json.tmp"));
    std::fs::File::create(&tmp)
        .and_then(|mut f| f.write_all(&json))
        .and_then(|()| std::fs::rename(&tmp, &path))
        .map_err(|e| format!("write {}: {e}", path.display()))?;
    eprintln!("wrote {}", path.display());
    Ok(())
}

struct Args {
    out_dir: PathBuf,
    game: String,
    levels: u16,
}

fn parse_args() -> Result<Args, String> {
    let mut out = None;
    let mut game = "all".to_owned();
    let mut levels = 100u16;
    let mut it = std::env::args().skip(1);
    while let Some(arg) = it.next() {
        let mut value = || it.next().ok_or(format!("{arg} needs a value"));
        match arg.as_str() {
            "--out-dir" => out = Some(PathBuf::from(value()?)),
            "--game" => game = value()?,
            "--levels" => {
                levels = value()?.parse().map_err(|e| format!("--levels: {e}"))?;
            }
            "-h" | "--help" => {
                return Err(
                    "usage: ARC_LEVEL_SEED=<secret> arc-levelgen --out-dir <dir> \
                            [--game all|water-sort|brick-blast|metro-jam|dead-bridge|traceout|gridsnap|cipher9|logoquest] [--levels 1..=100]"
                        .to_owned(),
                )
            }
            other => return Err(format!("unknown argument {other}")),
        }
    }
    if !matches!(
        game.as_str(),
        "all"
            | "water-sort"
            | "brick-blast"
            | "metro-jam"
            | "dead-bridge"
            | "traceout"
            | "gridsnap"
            | "cipher9"
            | "logoquest"
    ) {
        return Err(format!("unknown game {game}"));
    }
    if !(1..=100).contains(&levels) {
        return Err("--levels must be 1..=100".to_owned());
    }
    Ok(Args {
        out_dir: out.ok_or("--out-dir is required")?,
        game,
        levels,
    })
}

fn main() -> ExitCode {
    let args = match parse_args() {
        Ok(a) => a,
        Err(e) => {
            eprintln!("{e}");
            return ExitCode::FAILURE;
        }
    };
    let master = match std::env::var("ARC_LEVEL_SEED") {
        Ok(s) if s.len() >= 32 => s,
        _ => {
            eprintln!("ARC_LEVEL_SEED must be set to a secret of at least 32 characters");
            return ExitCode::FAILURE;
        }
    };

    if let Err(e) = std::fs::create_dir_all(&args.out_dir) {
        eprintln!("create {}: {e}", args.out_dir.display());
        return ExitCode::FAILURE;
    }
    let started = Instant::now();
    let wants = |game: &str| args.game == "all" || args.game == game;
    let failures: Mutex<Vec<String>> = Mutex::new(Vec::new());
    let (master, out, levels) = (&master, &args.out_dir, args.levels);
    // Every game at once, the slowest first, so the small ones fill the cores that a big
    // one leaves idle near its end. Each writes its own file.
    macro_rules! game {
        ($scope:expr, $id:literal, $label:literal, $generate:expr) => {
            if wants($id) {
                let (failures, started) = (&failures, &started);
                $scope.spawn(move |_| {
                    let built = $generate;
                    eprintln!(
                        "{}: {} levels ({:.1?})",
                        $label,
                        built.len(),
                        started.elapsed()
                    );
                    if let Err(e) = write_game(out, $id, &built) {
                        failures.lock().expect("a panic aborts the process").push(e);
                    }
                });
            }
        };
    }
    rayon::scope(|s| {
        game!(
            s,
            "brick-blast",
            "brick blast",
            brick::generate(master, levels)
        );
        game!(s, "traceout", "traceout", trace::generate(master, levels));
        game!(s, "cipher9", "cipher9", sudoku::generate(master, levels));
        game!(s, "gridsnap", "gridsnap", grid::generate(master, levels));
        game!(
            s,
            "water-sort",
            "water sort",
            water::generate(master, levels)
        );
        game!(s, "metro-jam", "metro jam", metro::generate(master, levels));
        game!(
            s,
            "dead-bridge",
            "dead bridge",
            bridge::generate(master, levels)
        );
        game!(s, "logoquest", "logoquest", logo::generate(levels));
    });
    let mut failures = failures.into_inner().expect("a panic aborts the process");
    failures.sort();
    let result = match failures.first() {
        Some(e) => Err(e.clone()),
        None => Ok(()),
    };
    if let Err(e) = result {
        eprintln!("{e}");
        return ExitCode::FAILURE;
    }
    ExitCode::SUCCESS
}
