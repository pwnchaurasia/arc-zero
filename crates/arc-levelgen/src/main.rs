//! Offline level generator.
//!
//! Builds the 100 levels of each game from a secret master seed, proves each
//! one can be finished, and orders them by measured difficulty. The output
//! file is server-only: it must never be committed or served to clients.
//!
//! Usage:
//!   ARC_LEVEL_SEED=<secret> arc-levelgen --out levels.json [--game all|water-sort|brick-blast] [--levels 100]

mod brick;
mod water;

use std::io::Write;
use std::path::PathBuf;
use std::process::ExitCode;
use std::time::Instant;

use arc_engine::hash::Fnv64;
use serde::Serialize;

pub const LEVELS_FILE_VERSION: u32 = 1;

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

#[derive(Serialize)]
struct LevelsFile {
    version: u32,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    water_sort: Vec<water::WsLevel>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    brick_blast: Vec<brick::BbLevel>,
}

struct Args {
    out: PathBuf,
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
            "--out" => out = Some(PathBuf::from(value()?)),
            "--game" => game = value()?,
            "--levels" => {
                levels = value()?.parse().map_err(|e| format!("--levels: {e}"))?;
            }
            "-h" | "--help" => {
                return Err("usage: ARC_LEVEL_SEED=<secret> arc-levelgen --out <file> \
                            [--game all|water-sort|brick-blast] [--levels 1..=100]"
                    .to_owned())
            }
            other => return Err(format!("unknown argument {other}")),
        }
    }
    if !matches!(game.as_str(), "all" | "water-sort" | "brick-blast") {
        return Err(format!("unknown game {game}"));
    }
    if !(1..=100).contains(&levels) {
        return Err("--levels must be 1..=100".to_owned());
    }
    Ok(Args {
        out: out.ok_or("--out is required")?,
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

    let started = Instant::now();
    let mut file = LevelsFile {
        version: LEVELS_FILE_VERSION,
        water_sort: Vec::new(),
        brick_blast: Vec::new(),
    };
    if matches!(args.game.as_str(), "all" | "water-sort") {
        file.water_sort = water::generate(&master, args.levels);
        eprintln!(
            "water sort: {} levels ({:.1?})",
            file.water_sort.len(),
            started.elapsed()
        );
    }
    if matches!(args.game.as_str(), "all" | "brick-blast") {
        file.brick_blast = brick::generate(&master, args.levels);
        eprintln!(
            "brick blast: {} levels ({:.1?})",
            file.brick_blast.len(),
            started.elapsed()
        );
    }

    let json = match serde_json::to_vec(&file) {
        Ok(j) => j,
        Err(e) => {
            eprintln!("serialise: {e}");
            return ExitCode::FAILURE;
        }
    };
    let write = std::fs::File::create(&args.out).and_then(|mut f| f.write_all(&json));
    if let Err(e) = write {
        eprintln!("write {}: {e}", args.out.display());
        return ExitCode::FAILURE;
    }
    eprintln!("wrote {}", args.out.display());
    ExitCode::SUCCESS
}
