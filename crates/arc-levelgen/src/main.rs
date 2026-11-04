//! Offline level generator.
//!
//! Builds the 100 levels of each game from a secret master seed, proves each
//! one can be finished, and orders them by measured difficulty. The output
//! file is server-only: it must never be committed or served to clients.
//!
//! Usage:
//!   ARC_LEVEL_SEED=<secret> arc-levelgen --out-dir levels [--game all|water-sort|brick-blast|metro-jam|dead-bridge|traceout|gridsnap] [--levels 100]
//!
//! Each game gets its own file (`levels/<game>.json`), so regenerating one game never
//! touches the others.

mod brick;
mod bridge;
mod grid;
mod metro;
mod pictures;
mod trace;
mod water;

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::Instant;

use arc_engine::hash::Fnv64;
use serde::Serialize;

pub const LEVELS_FILE_VERSION: u32 = 2;

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
                            [--game all|water-sort|brick-blast|metro-jam|dead-bridge|traceout|gridsnap] [--levels 1..=100]"
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
    let mut result = Ok(());
    if wants("water-sort") {
        let levels = water::generate(&master, args.levels);
        eprintln!(
            "water sort: {} levels ({:.1?})",
            levels.len(),
            started.elapsed()
        );
        result = result.and(write_game(&args.out_dir, "water-sort", &levels));
    }
    if wants("brick-blast") {
        let levels = brick::generate(&master, args.levels);
        eprintln!(
            "brick blast: {} levels ({:.1?})",
            levels.len(),
            started.elapsed()
        );
        result = result.and(write_game(&args.out_dir, "brick-blast", &levels));
    }
    if wants("metro-jam") {
        let levels = metro::generate(&master, args.levels);
        eprintln!(
            "metro jam: {} levels ({:.1?})",
            levels.len(),
            started.elapsed()
        );
        result = result.and(write_game(&args.out_dir, "metro-jam", &levels));
    }
    if wants("dead-bridge") {
        let levels = bridge::generate(&master, args.levels);
        eprintln!(
            "dead bridge: {} levels ({:.1?})",
            levels.len(),
            started.elapsed()
        );
        result = result.and(write_game(&args.out_dir, "dead-bridge", &levels));
    }
    if wants("traceout") {
        let levels = trace::generate(&master, args.levels);
        eprintln!(
            "traceout: {} levels ({:.1?})",
            levels.len(),
            started.elapsed()
        );
        result = result.and(write_game(&args.out_dir, "traceout", &levels));
    }
    if wants("gridsnap") {
        let levels = grid::generate(&master, args.levels);
        eprintln!(
            "gridsnap: {} levels ({:.1?})",
            levels.len(),
            started.elapsed()
        );
        result = result.and(write_game(&args.out_dir, "gridsnap", &levels));
    }
    if let Err(e) = result {
        eprintln!("{e}");
        return ExitCode::FAILURE;
    }
    ExitCode::SUCCESS
}
