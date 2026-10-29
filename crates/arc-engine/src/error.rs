use std::fmt;

/// Every way an engine call can reject its input. None of these are bugs:
/// they are what a tampered or malformed client request looks like.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EngineError {
    /// The input is structurally wrong (bad index, bad shape, bad JSON, ...).
    InvalidInput(String),
    /// The move is well-formed but not allowed by the game rules.
    IllegalMove(String),
    /// A hard cap (moves, turns, balls) was exceeded.
    LimitExceeded(String),
    /// The game is already over; no further moves are accepted.
    GameOver,
}

impl fmt::Display for EngineError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidInput(m) => write!(f, "invalid input: {m}"),
            Self::IllegalMove(m) => write!(f, "illegal move: {m}"),
            Self::LimitExceeded(m) => write!(f, "limit exceeded: {m}"),
            Self::GameOver => write!(f, "game is already over"),
        }
    }
}

impl std::error::Error for EngineError {}
