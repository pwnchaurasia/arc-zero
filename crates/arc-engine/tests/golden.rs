//! Cross-target determinism vectors.
//!
//! `golden/brick_blast.json` lists (state, aim) → expected state hash. The same
//! file is checked by this native test, by the browser WASM build
//! (`apps/web/scripts/check-determinism.mjs`) and by the Python extension
//! (`apps/api/tests/test_determinism.py`). If any target disagrees, the server
//! would reject honest players, so CI fails.
//!
//! Regenerate (only after an intentional rules change):
//!   UPDATE_GOLDEN=1 cargo test -p arc-engine --test golden

use std::path::PathBuf;

use arc_engine::brick_blast::{
    play_turn, Cell, LevelScript, PowerKind, Row, Shape, State, AIM_MAX, AIM_MIN, COLS, EMPTY_ROW,
};
use arc_engine::rng::Rng;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize)]
struct Vector {
    state: State,
    aim: u16,
    hash: String,
}

const SHAPES: [Shape; 5] = [
    Shape::Square,
    Shape::TriBl,
    Shape::TriBr,
    Shape::TriTl,
    Shape::TriTr,
];
const POWERS: [PowerKind; 8] = [
    PowerKind::LaserH,
    PowerKind::LaserV,
    PowerKind::LaserX,
    PowerKind::BallUp3,
    PowerKind::BallUp5,
    PowerKind::PlusBalls2,
    PowerKind::PlusBalls3,
    PowerKind::PlusBalls5,
];

fn pick<T: Copy>(rng: &mut Rng, items: &[T]) -> T {
    items[usize::try_from(rng.below(items.len() as u64)).unwrap()]
}

fn random_row(rng: &mut Rng) -> Row {
    let mut row = EMPTY_ROW;
    for cell in row.iter_mut().take(COLS) {
        match rng.below(10) {
            0..=4 => {
                *cell = Cell::Block {
                    shape: pick(rng, &SHAPES),
                    hp: u16::try_from(rng.range(1, 150)).unwrap(),
                }
            }
            5 => {
                *cell = Cell::Power {
                    kind: pick(rng, &POWERS),
                }
            }
            _ => {}
        }
    }
    row
}

fn vectors() -> Vec<Vector> {
    let mut out = Vec::new();
    for seed in 0..6u64 {
        let mut rng = Rng::new(seed);
        let script = LevelScript {
            start_balls: u16::try_from(rng.range(5, 60)).unwrap(),
            start_rows: (0..4).map(|_| random_row(&mut rng)).collect(),
            row_queue: (0..6).map(|_| random_row(&mut rng)).collect(),
        };
        let mut state = State::new(&script).unwrap();
        for _ in 0..4 {
            let aim = u16::try_from(rng.range(i64::from(AIM_MIN), i64::from(AIM_MAX))).unwrap();
            let Ok((next, _)) = play_turn(&state, aim) else {
                break;
            };
            // Full server states (with upcoming rows): every target accepts them.
            out.push(Vector {
                state: state.clone(),
                aim,
                hash: next.hash_hex(),
            });
            state = next;
            if state.status != arc_engine::brick_blast::Status::Playing {
                break;
            }
        }
    }
    out
}

fn golden_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/golden/brick_blast.json")
}

#[test]
fn brick_blast_matches_golden_vectors() {
    let fresh = vectors();
    let path = golden_path();
    if std::env::var_os("UPDATE_GOLDEN").is_some() {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, serde_json::to_string_pretty(&fresh).unwrap()).unwrap();
    }
    let stored: Vec<Vector> = serde_json::from_str(
        &std::fs::read_to_string(&path).expect("golden file missing: run with UPDATE_GOLDEN=1"),
    )
    .unwrap();
    assert_eq!(stored.len(), fresh.len());
    for (i, v) in stored.iter().enumerate() {
        let (next, _) = play_turn(&v.state, v.aim).unwrap();
        assert_eq!(next.hash_hex(), v.hash, "vector {i} diverged");
    }
}
