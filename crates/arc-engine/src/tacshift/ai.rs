//! The AI the server plays, and the "tactical radar" that suggests a move to the player.
//!
//! Everything random comes from the caller's `Rng`, which the server seeds and never
//! shares, so the AI's choices can't be predicted or replayed by the browser.
//!
//! - Classic: Easy plays at random 3 times in 4, Medium about 1 in 3; otherwise (and always
//!   on Hard) it plays perfectly, so Hard can't be beaten, only held to a draw.
//! - Infinity: Easy plays at random; Medium looks 3 moves ahead, Hard 6.
//! - Ultimate: Easy plays at random. Medium and Hard score each move (win a board, block
//!   one, don't hand over free choice); Medium adds noise, Hard also checks the reply.

use serde::{Deserialize, Serialize};

use super::{line_of, Game, Mode, Status, LINES, O, X};
use crate::rng::Rng;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Tier {
    Easy,
    Medium,
    Hard,
}

const WIN: i32 = 1_000;

/// The AI's move for the player to move, or `None` when the game is over.
#[must_use]
pub fn choose(game: &Game, tier: Tier, rng: &mut Rng) -> Option<u8> {
    let moves = game.legal_moves();
    if moves.is_empty() {
        return None;
    }
    let random = |rng: &mut Rng| moves[rng.below(moves.len() as u64) as usize];
    match (game.mode, tier) {
        (_, Tier::Easy) if game.mode != Mode::Classic => Some(random(rng)),
        (Mode::Classic, Tier::Easy) if rng.chance(3, 4) => Some(random(rng)),
        (Mode::Classic, Tier::Medium) if rng.chance(35, 100) => Some(random(rng)),
        (Mode::Classic, _) => Some(search(game, &moves, 9, rng)),
        (Mode::Infinity, Tier::Medium) => Some(search(game, &moves, 3, rng)),
        (Mode::Infinity, _) => Some(search(game, &moves, 6, rng)),
        (Mode::Ultimate, _) => Some(ultimate(game, &moves, tier == Tier::Hard, rng)),
    }
}

/// The strongest move this AI knows for the player to move (the paid radar).
#[must_use]
pub fn radar(game: &Game, rng: &mut Rng) -> Option<u8> {
    choose(game, Tier::Hard, rng)
}

/// The best of `scored`, a random one among equals.
fn pick(scored: &[(u8, i32)], rng: &mut Rng) -> u8 {
    let top = scored.iter().map(|s| s.1).max().unwrap_or(0);
    let best: Vec<u8> = scored.iter().filter(|s| s.1 == top).map(|s| s.0).collect();
    best[rng.below(best.len() as u64) as usize]
}

/// Two-in-a-row and one-in-a-row lines `me` could still finish.
fn potential(cells: &[u8], me: u8) -> i32 {
    let them = if me == X { O } else { X };
    LINES
        .iter()
        .map(|l| {
            let mine = l.iter().filter(|&&i| cells[i] == me).count();
            let theirs = l.iter().filter(|&&i| cells[i] == them).count();
            match (mine, theirs) {
                (2, 0) => 15,
                (1, 0) => 3,
                _ => 0,
            }
        })
        .sum()
}

/// Score for the player to move in `g` (negamax), looking `depth_left` moves ahead.
fn negamax(g: &Game, ply: i32, depth_left: u32, mut alpha: i32, beta: i32) -> i32 {
    match g.status {
        Status::Draw => return 0,
        // The previous move won: the player to move has lost (sooner is worse).
        Status::XWon | Status::OWon => return -(WIN - ply),
        Status::Playing => {}
    }
    if depth_left == 0 {
        let them = if g.turn == X { O } else { X };
        return potential(&g.cells, g.turn) - potential(&g.cells, them);
    }
    let mut best = i32::MIN + 1;
    for m in g.legal_moves() {
        let mut child = g.clone();
        if child.play(m).is_err() {
            continue;
        }
        let v = -negamax(&child, ply + 1, depth_left - 1, -beta, -alpha);
        best = best.max(v);
        alpha = alpha.max(v);
        if alpha >= beta {
            break;
        }
    }
    best
}

fn search(game: &Game, moves: &[u8], depth: u32, rng: &mut Rng) -> u8 {
    let scored: Vec<(u8, i32)> = moves
        .iter()
        .map(|&m| {
            let mut child = game.clone();
            let _ = child.play(m);
            (m, -negamax(&child, 1, depth - 1, i32::MIN + 1, i32::MAX))
        })
        .collect();
    pick(&scored, rng)
}

fn ultimate(game: &Game, moves: &[u8], hard: bool, rng: &mut Rng) -> u8 {
    let me = game.turn;
    let them = if me == X { O } else { X };
    let scored: Vec<(u8, i32)> = moves
        .iter()
        .map(|&m| {
            let mut child = game.clone();
            let Ok(placed) = child.play(m) else {
                return (m, i32::MIN);
            };
            if child.winner() == Some(me) {
                return (m, 100_000);
            }
            let board = usize::from(m / 9);
            let mut score = 0;
            if placed.closed == Some(board as u8) && child.boards[board] == me {
                score += if board == 4 { 75 } else { 50 };
            }
            // Taking a cell the opponent needed to win this board.
            let mut sub = game.cells[board * 9..board * 9 + 9].to_vec();
            sub[usize::from(m % 9)] = them;
            if line_of(&sub, them).is_some() {
                score += 40;
            }
            if child.status == Status::Playing {
                match child.active {
                    None => score -= 30,
                    Some(4) => score -= 12,
                    Some(_) => {}
                }
                if hard {
                    score += reply_risk(&child, them);
                }
            }
            if !hard {
                score += rng.range(-12, 12) as i32;
            }
            (m, score)
        })
        .collect();
    pick(&scored, rng)
}

/// How much the opponent's best reply hurts: a lost game, or a board handed to them.
fn reply_risk(after: &Game, them: u8) -> i32 {
    let mut worst = 0;
    for r in after.legal_moves() {
        let mut g = after.clone();
        let Ok(placed) = g.play(r) else { continue };
        if g.winner() == Some(them) {
            return -50_000;
        }
        if placed
            .closed
            .is_some_and(|b| g.boards[usize::from(b)] == them)
        {
            worst = -35;
        }
    }
    worst
}

#[cfg(test)]
mod tests {
    use super::*;

    fn play_out(mode: Mode, x: Tier, o: Tier, seed: u64) -> Game {
        let mut g = Game::new(mode);
        let mut rng = Rng::new(seed);
        while g.status == Status::Playing {
            let tier = if g.turn == X { x } else { o };
            let m = choose(&g, tier, &mut rng).expect("a move while playing");
            g.play(m).expect("the AI only plays legal moves");
        }
        g
    }

    #[test]
    fn every_tier_plays_legal_moves_to_the_end() {
        for mode in [Mode::Classic, Mode::Infinity, Mode::Ultimate] {
            for (x, o) in [
                (Tier::Easy, Tier::Hard),
                (Tier::Medium, Tier::Medium),
                (Tier::Hard, Tier::Easy),
            ] {
                for seed in 0..5 {
                    let g = play_out(mode, x, o, seed);
                    assert_ne!(g.status, Status::Playing);
                }
            }
        }
    }

    /// Every line of play X can choose, against Hard as O: X never wins.
    fn x_can_win(g: &Game, seed: u64) -> bool {
        for m in g.legal_moves() {
            let mut after = g.clone();
            after.play(m).unwrap();
            match after.status {
                Status::XWon => return true,
                Status::Playing => {
                    let mut rng = Rng::new(seed ^ u64::from(m) ^ (u64::from(after.plies) << 8));
                    let reply = choose(&after, Tier::Hard, &mut rng).unwrap();
                    after.play(reply).unwrap();
                    if after.status == Status::Playing && x_can_win(&after, seed.wrapping_mul(31)) {
                        return true;
                    }
                }
                _ => {}
            }
        }
        false
    }

    #[test]
    fn classic_hard_cannot_be_beaten() {
        for seed in [1, 2, 3] {
            assert!(!x_can_win(&Game::new(Mode::Classic), seed));
        }
    }

    #[test]
    fn harder_tiers_win_more() {
        for mode in [Mode::Infinity, Mode::Ultimate] {
            let o_wins = |o: Tier| {
                (0..40)
                    .filter(|&s| play_out(mode, Tier::Easy, o, s).status == Status::OWon)
                    .count()
            };
            let (easy, hard) = (o_wins(Tier::Easy), o_wins(Tier::Hard));
            assert!(hard > easy, "{mode:?}: hard {hard} vs easy {easy}");
            assert!(
                hard >= 30,
                "{mode:?}: hard only beat a random player {hard}/40 times"
            );
        }
    }

    #[test]
    fn the_ai_takes_a_win_and_blocks_one() {
        let mut g = Game::new(Mode::Classic);
        for c in [0, 3, 1, 4] {
            g.play(c).unwrap();
        }
        // X to move with 0, 1 down: Hard takes 2. As O (after X's 8), Hard takes 5.
        let mut rng = Rng::new(7);
        assert_eq!(choose(&g, Tier::Hard, &mut rng), Some(2));
        g.play(8).unwrap();
        assert_eq!(choose(&g, Tier::Hard, &mut rng), Some(5));
        assert_eq!(radar(&g, &mut rng), Some(5));
    }
}
