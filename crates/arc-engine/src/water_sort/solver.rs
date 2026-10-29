//! A* search over Water Sort boards.
//!
//! `weight == 1` gives a shortest solution (used to set star thresholds).
//! Larger weights find *a* solution much faster (used for hints).

use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap};

use super::packed::{Packed, KEY_LEN};
use super::{replay, Board, Move, ReplayError};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SolveOutcome {
    Solved { moves: Vec<Move>, expanded: usize },
    Unsolvable { expanded: usize },
    BudgetExceeded { expanded: usize },
}

struct Node {
    state: Packed,
    parent: u32,
    mv: Move,
    g: u16,
}

/// Searches for a solution, expanding at most `budget` states.
#[must_use]
pub fn solve(board: &Board, budget: usize, weight: u32) -> SolveOutcome {
    let start = Packed::from_board(board);
    let weight = weight.max(1);
    let mut nodes = vec![Node {
        state: start,
        parent: u32::MAX,
        mv: (0, 0),
        g: 0,
    }];
    let mut best_g: HashMap<[u8; KEY_LEN], u16> = HashMap::new();
    best_g.insert(start.key(), 0);
    // Ordered by lowest f, then deepest g, then insertion order: fully deterministic.
    let mut open = BinaryHeap::new();
    open.push((Reverse(weight * start.heuristic()), 0u16, Reverse(0u32)));
    let mut expanded = 0usize;
    let mut moves = Vec::with_capacity(64);

    while let Some((_, g, Reverse(idx))) = open.pop() {
        let state = nodes[idx as usize].state;
        if best_g.get(&state.key()).is_some_and(|&bg| g > bg) {
            continue;
        }
        if state.is_solved() {
            return SolveOutcome::Solved {
                moves: path(&nodes, idx),
                expanded,
            };
        }
        expanded += 1;
        if expanded > budget {
            return SolveOutcome::BudgetExceeded { expanded };
        }
        state.useful_moves(&mut moves);
        for &(from, to) in &moves {
            let (f, t) = (usize::from(from), usize::from(to));
            let Ok(amount) = state.pour_amount(f, t) else {
                continue;
            };
            let mut child = state;
            child.apply(f, t, amount);
            let ng = g + 1;
            let key = child.key();
            if best_g.get(&key).is_some_and(|&bg| bg <= ng) {
                continue;
            }
            best_g.insert(key, ng);
            let child_idx = u32::try_from(nodes.len()).expect("node count fits u32");
            nodes.push(Node {
                state: child,
                parent: idx,
                mv: (from, to),
                g: ng,
            });
            let f_score = u32::from(ng) + weight * child.heuristic();
            open.push((Reverse(f_score), ng, Reverse(child_idx)));
        }
    }
    SolveOutcome::Unsolvable { expanded }
}

fn path(nodes: &[Node], mut idx: u32) -> Vec<Move> {
    let mut out = Vec::with_capacity(usize::from(nodes[idx as usize].g));
    while nodes[idx as usize].parent != u32::MAX {
        out.push(nodes[idx as usize].mv);
        idx = nodes[idx as usize].parent;
    }
    out.reverse();
    out
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum HintOutcome {
    /// The next move along a known solution from the player's current board.
    Move(Move),
    /// No solution exists from here: the player must undo or restart.
    DeadEnd,
    /// The board is already solved.
    Solved,
    /// The search budget ran out; the caller should not charge a hint.
    Unknown,
}

/// Replays the player's moves and suggests the next one.
pub fn hint(start: &Board, moves: &[Move], budget: usize) -> Result<HintOutcome, ReplayError> {
    let current = replay(start, moves)?;
    if current.is_solved() {
        return Ok(HintOutcome::Solved);
    }
    Ok(match solve(&current, budget, 3) {
        SolveOutcome::Solved { moves, .. } => moves
            .first()
            .copied()
            .map_or(HintOutcome::Solved, HintOutcome::Move),
        SolveOutcome::Unsolvable { .. } => HintOutcome::DeadEnd,
        SolveOutcome::BudgetExceeded { .. } => HintOutcome::Unknown,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn b(bottles: &[&[u8]]) -> Board {
        Board {
            bottles: bottles.iter().map(|x| x.to_vec()).collect(),
        }
    }

    #[test]
    fn finds_shortest_solution() {
        // Three pours are needed and enough.
        let board = b(&[&[0, 0, 0, 1], &[1, 1, 1, 0], &[]]);
        let SolveOutcome::Solved { moves, .. } = solve(&board, 10_000, 1) else {
            panic!("expected a solution");
        };
        let end = replay(&board, &moves).unwrap();
        assert!(end.is_solved());
        assert_eq!(moves.len(), 3);
    }

    #[test]
    fn detects_unsolvable() {
        // No empty bottle and no matching tops: no legal move at all.
        let board = b(&[&[0, 1, 0, 1], &[1, 0, 1, 0]]);
        assert!(matches!(
            solve(&board, 10_000, 1),
            SolveOutcome::Unsolvable { .. }
        ));
    }

    #[test]
    fn generated_boards_are_usually_solvable_and_solutions_replay() {
        let mut solved = 0;
        for seed in 0..20 {
            let board = Board::generate(seed, 4, 2);
            if let SolveOutcome::Solved { moves, .. } = solve(&board, 200_000, 1) {
                assert!(replay(&board, &moves).unwrap().is_solved());
                solved += 1;
            }
        }
        assert!(solved >= 18, "only {solved}/20 solvable");
    }

    #[test]
    fn optimal_is_never_longer_than_weighted() {
        for seed in 0..8 {
            let board = Board::generate(seed, 4, 2);
            let (SolveOutcome::Solved { moves: opt, .. }, SolveOutcome::Solved { moves: fast, .. }) =
                (solve(&board, 200_000, 1), solve(&board, 200_000, 3))
            else {
                continue;
            };
            assert!(opt.len() <= fast.len());
        }
    }

    #[test]
    fn hint_follows_from_current_state() {
        let board = Board::generate(5, 4, 2);
        let SolveOutcome::Solved { moves, .. } = solve(&board, 200_000, 1) else {
            return;
        };
        let HintOutcome::Move(mv) = hint(&board, &moves[..1], 50_000).unwrap() else {
            panic!("expected a move");
        };
        let mut after = replay(&board, &moves[..1]).unwrap();
        after.pour(mv.0, mv.1).unwrap();
        assert_eq!(hint(&board, &moves, 50_000).unwrap(), HintOutcome::Solved);
    }
}
