//! A fair, fallible player used by the level generator to measure difficulty.
//!
//! It sees only what a human sees (the visible part of the queue) and parks
//! the vehicle whose colour is needed soonest. With `noise`, it sometimes
//! picks at random, like a player who misjudges. Its win rate over many
//! playouts is the level's difficulty signal; it never uses assists.

use super::{Game, Level};
use crate::rng::Rng;

/// How soon `color` is needed beyond the seats already parked for it.
/// Lower is sooner; `None` if not needed within the visible queue.
fn need(game: &Game, color: u8) -> Option<usize> {
    let mut parked: usize = game
        .bays()
        .iter()
        .flatten()
        .filter(|b| game.level().vehicles[usize::from(b.vehicle)].color == color)
        .map(|b| {
            let kind = game.level().vehicles[usize::from(b.vehicle)].kind;
            usize::from(kind.riders() - b.riders)
        })
        .sum();
    let visible = usize::from(game.level().visible);
    for (i, &c) in game.waiting().iter().take(visible).enumerate() {
        if c == color {
            if parked == 0 {
                return Some(i);
            }
            parked -= 1;
        }
    }
    None
}

/// The vehicle the greedy policy parks next, if any can be parked.
#[must_use]
pub fn greedy_choice(game: &Game) -> Option<u8> {
    let options = game.tappable();
    options.iter().copied().min_by_key(|&v| {
        let vehicle = game.level().vehicles[usize::from(v)];
        // Unneeded colours last; among equals prefer small vehicles (they free a bay sooner).
        (
            need(game, vehicle.color).unwrap_or(usize::MAX),
            vehicle.kind.riders(),
            v,
        )
    })
}

/// Plays one game to the end. Returns true on a win.
#[must_use]
pub fn playout(level: &Level, rng: &mut Rng, noise_pct: u64) -> bool {
    let Ok(mut game) = Game::new(level) else {
        return false;
    };
    loop {
        if game.is_won() {
            return true;
        }
        let options = game.tappable();
        if options.is_empty() {
            return false;
        }
        let pick = if rng.chance(noise_pct, 100) {
            options[usize::try_from(rng.below(options.len() as u64)).unwrap_or(0)]
        } else {
            match greedy_choice(&game) {
                Some(v) => v,
                None => return false,
            }
        };
        if game.tap(pick).is_err() {
            return false;
        }
    }
}

/// Wins out of `runs` noisy playouts.
#[must_use]
pub fn win_rate(level: &Level, seed: u64, runs: u32, noise_pct: u64) -> u32 {
    let mut rng = Rng::new(seed);
    u32::try_from(
        (0..runs)
            .filter(|_| playout(level, &mut rng, noise_pct))
            .count(),
    )
    .unwrap_or(u32::MAX)
}
