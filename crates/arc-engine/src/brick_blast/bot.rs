//! Greedy one-turn-lookahead player.
//!
//! Used offline to prove every level can be finished, and on the server to
//! pick the aim shown by a hint.

use super::{play_turn, Cell, LevelScript, State, StateError, Status, AIM_MAX, AIM_MIN};

/// Evenly spaced aims across the legal range.
#[must_use]
pub fn candidate_aims(count: u16) -> Vec<u16> {
    let count = count.max(2);
    let span = u32::from(AIM_MAX - AIM_MIN);
    (0..count)
        .map(|i| {
            let offset = span * u32::from(i) / u32::from(count - 1);
            AIM_MIN + u16::try_from(offset).expect("offset within aim span")
        })
        .collect()
}

/// Higher is better. Rewards progress, punishes blocks near the ground.
fn score(after: &State, hits: u32, collected: u16) -> i64 {
    match after.status {
        Status::Won => return 1_000_000_000 - i64::from(after.turn) * 1_000,
        Status::Lost => return -1_000_000_000 + i64::from(hits),
        Status::Playing => {}
    }
    let danger = after.lowest_block_row().map_or(0, |r| {
        let r = i64::try_from(r).unwrap_or(0);
        if r >= 6 {
            (r - 5).pow(3) * 400
        } else {
            0
        }
    });
    let blocks = i64::try_from(after.block_count()).unwrap_or(0);
    -i64::from(after.total_hp()) * 10 - blocks * 40 + i64::from(collected) * 150 - danger
}

/// Best aim among `candidates` evenly spaced aims, by one-turn lookahead.
///
/// `state` must be the full server state (with upcoming rows).
#[must_use]
pub fn best_aim(state: &State, candidates: u16) -> Option<(u16, i64)> {
    let mut best: Option<(u16, i64)> = None;
    for aim in candidate_aims(candidates) {
        let Ok((after, summary)) = play_turn(state, aim) else {
            continue;
        };
        let s = score(&after, summary.hits, summary.collected);
        if best.is_none_or(|(_, b)| s > b) {
            best = Some((aim, s));
        }
    }
    best
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BotRun {
    pub won: bool,
    pub turns: u16,
    /// Fewest free rows above the ground during the run (bigger = more comfortable).
    pub closest: u8,
    pub final_balls: u16,
}

/// Plays a level start to finish with the greedy bot.
pub fn play_level(script: &LevelScript, candidates: u16) -> Result<BotRun, StateError> {
    let mut state = State::new(script)?;
    while state.status == Status::Playing {
        let Some((aim, _)) = best_aim(&state, candidates) else {
            break;
        };
        match play_turn(&state, aim) {
            Ok((next, _)) => state = next,
            Err(_) => break,
        }
    }
    Ok(BotRun {
        won: state.status == Status::Won,
        turns: state.turn,
        closest: state.closest,
        final_balls: state.balls,
    })
}

/// True if any block is left on the board (used by tests and tools).
#[must_use]
pub fn has_blocks(state: &State) -> bool {
    state
        .grid
        .iter()
        .flatten()
        .any(|c| matches!(c, Cell::Block { .. }))
}

#[cfg(test)]
mod tests {
    use super::super::{Shape, EMPTY_ROW};
    use super::*;

    #[test]
    fn aims_cover_range() {
        let aims = candidate_aims(5);
        assert_eq!(aims.first(), Some(&AIM_MIN));
        assert_eq!(aims.last(), Some(&AIM_MAX));
        assert_eq!(aims.len(), 5);
    }

    #[test]
    fn bot_clears_an_easy_level() {
        let mut row = EMPTY_ROW;
        for (i, cell) in row.iter_mut().enumerate() {
            if i % 2 == 0 {
                *cell = Cell::Block {
                    shape: Shape::Square,
                    hp: 3,
                };
            }
        }
        let script = LevelScript {
            start_balls: 5,
            start_rows: vec![row],
            row_queue: vec![row, EMPTY_ROW, row],
        };
        let run = play_level(&script, 21).unwrap();
        assert!(run.won, "{run:?}");
    }
}
