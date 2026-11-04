//! A greedy GridSnap player, used to tune the deal and in tests.
//!
//! It tries every remaining shape at every spot and keeps the placement that
//! scores best now while leaving the board most open: few lone holes, a short
//! outline, and room for the big shapes. It plays about as well as a careful
//! human, so its scores set the difficulty curve.

use super::{openness, Board, Game, Status, SIZE, STONE, TRAY};

/// Cells in rows and columns that still hold a stone: filling them works towards
/// clearing it.
fn stone_lines(board: &Board) -> i64 {
    let mut total = 0;
    for i in 0..SIZE {
        let row = &board.cells[i * SIZE..(i + 1) * SIZE];
        if row.contains(&STONE) {
            total += row.iter().filter(|c| **c != 0).count();
        }
        let col: Vec<u8> = (0..SIZE).map(|r| board.cells[r * SIZE + i]).collect();
        if col.contains(&STONE) {
            total += col.iter().filter(|c| **c != 0).count();
        }
    }
    i64::try_from(total).unwrap_or(0)
}

fn after(board: &Board, slot: usize, row: u8, col: u8) -> Option<(i64, u64)> {
    let mut b = board.clone();
    let placed = b.place(slot, row, col).ok()?;
    let occupied = b.occupied();
    let mut value = i64::from(placed.points) + openness(occupied);
    if b.goal {
        // On a level, clearing stones matters most, then lining up to clear them.
        let cleared = board.stones() - b.stones();
        value += 400 * i64::try_from(cleared).unwrap_or(0) + 12 * stone_lines(&b);
        if b.status == Status::Won {
            value += 1_000_000;
        }
    }
    Some((value, occupied))
}

/// The best `(slot, row, col)` for the current tray, if any shape fits.
#[must_use]
pub fn best_move(board: &Board) -> Option<(usize, u8, u8)> {
    let mut best: Option<(i64, (usize, u8, u8))> = None;
    #[allow(clippy::cast_possible_truncation)]
    for slot in 0..TRAY {
        if board.tray[slot].is_none() {
            continue;
        }
        for row in 0..SIZE as u8 {
            for col in 0..SIZE as u8 {
                if !board.can_place(slot, row, col) {
                    continue;
                }
                if let Some((value, _)) = after(board, slot, row, col) {
                    if best.is_none_or(|(v, _)| value > v) {
                        best = Some((value, (slot, row, col)));
                    }
                }
            }
        }
    }
    best.map(|(_, m)| m)
}

/// Plays a run until it is stuck or `max` placements were made.
#[must_use]
pub fn play(seed: u64, max: u32) -> Game {
    play_from(Game::new(seed), max)
}

/// Plays `game` (a run or a level) until it is won, stuck, or `max` placements
/// were made.
#[must_use]
pub fn play_from(mut game: Game, max: u32) -> Game {
    while game.board.status == Status::Playing && game.board.placed < max {
        let Some((slot, row, col)) = best_move(&game.board) else {
            break;
        };
        if game.place(slot, row, col).is_err() {
            break;
        }
    }
    game
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn early_trays_are_kind_and_runs_end() {
        // Easy start: early trays can always be placed, so careful play
        // rarely gets stuck in the first 20 placements.
        let mut scores = Vec::new();
        let mut early = 0;
        for seed in 0..40 {
            let g = play(seed, 3_000);
            early += usize::from(g.board.placed < 20);
            scores.push(g.board.score);
        }
        assert!(
            early <= 2,
            "{early} of 40 runs ended in the first 20 placements"
        );
        scores.sort_unstable();
        let median = scores[scores.len() / 2];
        // Moderately difficult: a careful player usually ends somewhere in the
        // thousands, not in the tens of thousands.
        assert!(
            (2_000..=20_000).contains(&median),
            "median {median}, all {scores:?}"
        );
    }
}

#[cfg(test)]
mod tuning {
    use super::*;

    /// `cargo test --release -p arc-engine gridsnap_curve -- --ignored --nocapture`
    #[test]
    #[ignore = "prints the difficulty curve"]
    fn gridsnap_curve() {
        let mut runs: Vec<(u32, u32)> = (0..300)
            .map(|s| {
                let g = play(s, 20_000);
                (g.board.score, g.board.placed)
            })
            .collect();
        runs.sort_unstable();
        let pct = |p: usize| runs[runs.len() * p / 100];
        for p in [5, 10, 25, 50, 75, 90, 95] {
            println!("p{p}: score {} placed {}", pct(p).0, pct(p).1);
        }
        let early = runs.iter().filter(|r| r.1 < 30).count();
        let mut deaths: Vec<u32> = runs.iter().map(|r| r.1).filter(|p| *p < 30).collect();
        deaths.sort_unstable();
        println!("early deaths at placements {deaths:?}");
        println!("stuck before 30 placements: {early}/300");
    }
}
