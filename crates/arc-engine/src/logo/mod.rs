//! LogoQuest: Logo turtle graphics (decision 2026-11-17, see the LogoQuest doc).
//!
//! A program is a tree of blocks the player builds from chips (there is no typing in
//! the game; `parse` reads the same language as text, for the level files and tests).
//! The turtle starts at the centre of a 300 x 300 board facing up, pen down, green.
//!
//! The browser runs a program to animate it; the server runs it again and judges the
//! drawing against the level's target. Positions are fixed-point integers (thousandths
//! of a unit) and sines come from integer arithmetic, so every platform draws exactly
//! the same lines.

use std::fmt;

use serde::{Deserialize, Serialize};

/// Units from the centre to each edge of the board.
pub const HALF_BOARD: i64 = 150;
pub const MAX_DISTANCE: u16 = 300;
pub const MAX_REPEAT: u16 = 36;
/// REPEAT inside REPEAT inside REPEAT, no deeper.
pub const MAX_DEPTH: usize = 3;
/// Blocks (chips) in one program.
pub const MAX_BLOCKS: usize = 150;
/// Moves and turns once every REPEAT is unrolled.
pub const MAX_STEPS: usize = 4_000;
/// Thousandths of a unit.
const MILLI: i64 = 1_000;
/// The judge looks at a point every 4 units of line...
const SAMPLE: i64 = 4 * MILLI;
/// ...and counts it as on the line within 8 units, as the spec asks.
const TOLERANCE: i64 = 8 * MILLI;
/// Of the target's points, this share must be drawn...
const MIN_COVERAGE_PCT: u32 = 94;
/// ...and of the player's points, this share must be on the target.
const MIN_PRECISION_PCT: u32 = 90;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Color {
    Green,
    Blue,
    Yellow,
    Red,
    Purple,
    White,
}

impl Color {
    pub const ALL: [Self; 6] = [
        Self::Green,
        Self::Blue,
        Self::Yellow,
        Self::Red,
        Self::Purple,
        Self::White,
    ];

    #[must_use]
    pub const fn name(self) -> &'static str {
        match self {
            Self::Green => "GREEN",
            Self::Blue => "BLUE",
            Self::Yellow => "YELLOW",
            Self::Red => "RED",
            Self::Purple => "PURPLE",
            Self::White => "WHITE",
        }
    }
}

/// One chip. `Repeat` holds the chips inside its brackets.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Block {
    Fd { n: u16 },
    Bk { n: u16 },
    Rt { n: u16 },
    Lt { n: u16 },
    Pu,
    Pd,
    Color { c: Color },
    Repeat { n: u16, body: Vec<Block> },
}

pub type Program = Vec<Block>;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProgramError(pub String);

impl fmt::Display for ProgramError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for ProgramError {}

/// Blocks in a program, every chip counted once (a REPEAT is one chip plus its body).
#[must_use]
pub fn blocks(program: &[Block]) -> usize {
    program
        .iter()
        .map(|b| match b {
            Block::Repeat { body, .. } => 1 + blocks(body),
            _ => 1,
        })
        .sum()
}

/// The deepest REPEAT nesting (0 without REPEAT).
#[must_use]
pub fn depth(program: &[Block]) -> usize {
    program
        .iter()
        .map(|b| match b {
            Block::Repeat { body, .. } => 1 + depth(body),
            _ => 0,
        })
        .max()
        .unwrap_or(0)
}

/// Checks the limits a program must respect before it runs.
pub fn validate(program: &[Block]) -> Result<(), ProgramError> {
    let bad = |m: &str| Err(ProgramError(m.to_owned()));
    if blocks(program) > MAX_BLOCKS {
        return bad("that program has too many blocks");
    }
    if depth(program) > MAX_DEPTH {
        return bad("REPEAT can only go 3 deep");
    }
    fn check(program: &[Block]) -> Result<(), ProgramError> {
        for b in program {
            let ok = match b {
                Block::Fd { n } | Block::Bk { n } => (1..=MAX_DISTANCE).contains(n),
                Block::Rt { n } | Block::Lt { n } => (1..=360).contains(n),
                Block::Repeat { n, body } => {
                    check(body)?;
                    (1..=MAX_REPEAT).contains(n) && !body.is_empty()
                }
                _ => true,
            };
            if !ok {
                return Err(ProgramError(format!(
                    "{} has a number out of range",
                    text_of(b)
                )));
            }
        }
        Ok(())
    }
    check(program)
}

fn text_of(b: &Block) -> String {
    match b {
        Block::Fd { n } => format!("FD {n}"),
        Block::Bk { n } => format!("BK {n}"),
        Block::Rt { n } => format!("RT {n}"),
        Block::Lt { n } => format!("LT {n}"),
        Block::Pu => "PU".into(),
        Block::Pd => "PD".into(),
        Block::Color { c } => format!("COLOR {}", c.name()),
        Block::Repeat { n, body } => format!("REPEAT {n} [ {} ]", to_text(body)),
    }
}

/// The program as Logo text, e.g. `REPEAT 4 [ FD 100 RT 90 ]`.
#[must_use]
pub fn to_text(program: &[Block]) -> String {
    program.iter().map(text_of).collect::<Vec<_>>().join(" ")
}

/// Reads Logo text (the level files' format). Accepts the long names too (`FORWARD`).
pub fn parse(text: &str) -> Result<Program, ProgramError> {
    let spaced = text.to_uppercase().replace('[', " [ ").replace(']', " ] ");
    let tokens: Vec<&str> = spaced.split_whitespace().collect();
    let mut at = 0;
    let program = parse_block(&tokens, &mut at, false)?;
    validate(&program)?;
    Ok(program)
}

fn parse_block(tokens: &[&str], at: &mut usize, inside: bool) -> Result<Program, ProgramError> {
    let err = |m: String| Err(ProgramError(m));
    let mut out = Vec::new();
    let number = |tokens: &[&str], i: usize, what: &str| -> Result<u16, ProgramError> {
        tokens
            .get(i)
            .and_then(|t| t.parse().ok())
            .ok_or_else(|| ProgramError(format!("{what} needs a number after it")))
    };
    while let Some(&tok) = tokens.get(*at) {
        *at += 1;
        let block = match tok {
            "]" if inside => return Ok(out),
            "]" => return err("a ']' has no REPEAT".into()),
            "FD" | "FORWARD" => Block::Fd {
                n: number(tokens, *at, tok)?,
            },
            "BK" | "BACK" => Block::Bk {
                n: number(tokens, *at, tok)?,
            },
            "RT" | "RIGHT" => Block::Rt {
                n: number(tokens, *at, tok)?,
            },
            "LT" | "LEFT" => Block::Lt {
                n: number(tokens, *at, tok)?,
            },
            "PU" | "PENUP" => Block::Pu,
            "PD" | "PENDOWN" => Block::Pd,
            "COLOR" | "SETCOLOR" => {
                let name = tokens.get(*at).copied().unwrap_or_default();
                let c = Color::ALL
                    .into_iter()
                    .find(|c| c.name() == name)
                    .ok_or_else(|| ProgramError(format!("unknown colour {name}")))?;
                *at += 1;
                Block::Color { c }
            }
            "REPEAT" => {
                let n = number(tokens, *at, tok)?;
                if tokens.get(*at + 1) != Some(&"[") {
                    return err(format!("REPEAT {n} needs a '['"));
                }
                *at += 2;
                let body = parse_block(tokens, at, true)?;
                out.push(Block::Repeat { n, body });
                continue;
            }
            other => return err(format!("unknown command {other}")),
        };
        if matches!(
            block,
            Block::Fd { .. } | Block::Bk { .. } | Block::Rt { .. } | Block::Lt { .. }
        ) {
            *at += 1;
        }
        out.push(block);
    }
    if inside {
        return err("a REPEAT is missing its ']'".into());
    }
    Ok(out)
}

/// sin(degrees) scaled by 10^9, from integer arithmetic only (Taylor series).
#[must_use]
pub fn sin_e9(deg: i64) -> i64 {
    const S: i128 = 1_000_000_000_000_000_000; // 10^18
    const PI: i128 = 3_141_592_653_589_793_238; // pi * 10^18
    let d = deg.rem_euclid(360);
    let (d, sign) = if d >= 180 { (d - 180, -1) } else { (d, 1) };
    let d = if d > 90 { 180 - d } else { d };
    let x = i128::from(d) * PI / 180;
    let mut term = x;
    let mut sum = x;
    for k in 1..12i128 {
        term = -term * x / S * x / S / ((2 * k) * (2 * k + 1));
        sum += term;
    }
    // Rounded to the nearest (the sum is never negative here).
    sign * i64::try_from((sum + 500_000_000) / 1_000_000_000).expect("sine fits")
}

#[must_use]
pub fn cos_e9(deg: i64) -> i64 {
    sin_e9(deg + 90)
}

/// `d * ratio / 10^9`, rounded to the nearest thousandth (half away from zero).
fn scale(d: i64, ratio_e9: i64) -> i64 {
    let v = i128::from(d) * i128::from(ratio_e9);
    let r = (v.abs() + 500_000_000) / 1_000_000_000;
    i64::try_from(if v < 0 { -r } else { r }).expect("distance fits")
}

/// A drawn line, in thousandths of a unit (y grows downwards, like the screen).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct Segment {
    pub x1: i64,
    pub y1: i64,
    pub x2: i64,
    pub y2: i64,
    pub color: Color,
}

impl Segment {
    #[must_use]
    pub fn length(&self) -> i64 {
        let (dx, dy) = (self.x2 - self.x1, self.y2 - self.y1);
        i64::try_from(crate::isqrt(u64::try_from(dx * dx + dy * dy).unwrap_or(0))).unwrap_or(0)
    }
}

/// The turtle after one step, and the block (numbered in reading order) that made it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct Step {
    pub block: u16,
    pub x: i64,
    pub y: i64,
    pub heading: u16,
    pub pen: bool,
    pub color: Color,
    /// The line this step drew, as an index into `segments`.
    pub drew: Option<u16>,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct Run {
    pub segments: Vec<Segment>,
    pub steps: Vec<Step>,
}

struct Turtle {
    x: i64,
    y: i64,
    heading: i64,
    pen: bool,
    color: Color,
}

/// Runs a program (assumed valid). Stops quietly after `MAX_STEPS`.
#[must_use]
pub fn run(program: &[Block]) -> Run {
    let mut out = Run::default();
    let mut t = Turtle {
        x: 0,
        y: 0,
        heading: 0,
        pen: true,
        color: Color::Green,
    };
    let mut next_id = 0u16;
    exec(program, &mut t, &mut out, &mut next_id);
    out
}

/// Numbers each block in reading order, so the browser can light up the one running.
fn exec(program: &[Block], t: &mut Turtle, out: &mut Run, next_id: &mut u16) {
    for b in program {
        let id = *next_id;
        *next_id += 1;
        if let Block::Repeat { n, body } = b {
            let first_child = *next_id;
            for _ in 0..*n {
                *next_id = first_child;
                exec(body, t, out, next_id);
                if out.steps.len() >= MAX_STEPS {
                    return;
                }
            }
            if *n == 0 {
                skip_ids(body, next_id);
            }
            continue;
        }
        if out.steps.len() >= MAX_STEPS {
            return;
        }
        let mut drew = None;
        match b {
            Block::Fd { n } | Block::Bk { n } => {
                let d = i64::from(*n) * MILLI * if matches!(b, Block::Bk { .. }) { -1 } else { 1 };
                let nx = t.x + scale(d, sin_e9(t.heading));
                let ny = t.y - scale(d, cos_e9(t.heading));
                if t.pen {
                    drew = u16::try_from(out.segments.len()).ok();
                    out.segments.push(Segment {
                        x1: t.x,
                        y1: t.y,
                        x2: nx,
                        y2: ny,
                        color: t.color,
                    });
                }
                t.x = nx;
                t.y = ny;
            }
            Block::Rt { n } => t.heading = (t.heading + i64::from(*n)).rem_euclid(360),
            Block::Lt { n } => t.heading = (t.heading - i64::from(*n)).rem_euclid(360),
            Block::Pu => t.pen = false,
            Block::Pd => t.pen = true,
            Block::Color { c } => t.color = *c,
            Block::Repeat { .. } => unreachable!(),
        }
        out.steps.push(Step {
            block: id,
            x: t.x,
            y: t.y,
            heading: t.heading as u16,
            pen: t.pen,
            color: t.color,
            drew,
        });
    }
}

fn skip_ids(program: &[Block], next_id: &mut u16) {
    for b in program {
        *next_id += 1;
        if let Block::Repeat { body, .. } = b {
            skip_ids(body, next_id);
        }
    }
}

/// Points every `SAMPLE` along each line, with its colour.
fn sample(segments: &[Segment]) -> Vec<(i64, i64, Color)> {
    let mut pts = Vec::new();
    for s in segments {
        let n = (s.length() / SAMPLE).max(1);
        for i in 0..=n {
            pts.push((
                s.x1 + (s.x2 - s.x1) * i / n,
                s.y1 + (s.y2 - s.y1) * i / n,
                s.color,
            ));
        }
    }
    pts
}

fn near(p: (i64, i64, Color), others: &[(i64, i64, Color)]) -> bool {
    others.iter().any(|q| {
        let (dx, dy) = (p.0 - q.0, p.1 - q.1);
        p.2 == q.2 && dx * dx + dy * dy <= TOLERANCE * TOLERANCE
    })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct Judgement {
    pub passed: bool,
    /// 0-100: how well the drawing matches, both ways.
    pub accuracy: u32,
    /// Share of the target drawn, 0-100.
    pub coverage: u32,
    /// Share of the drawing that is on the target, 0-100.
    pub precision: u32,
    /// The first target line not drawn yet (for a hint), as an index.
    pub missing: Option<u16>,
}

/// Compares a drawing with the target, point by point, so the same picture drawn in a
/// different order, direction or number of strokes still passes. Colours must match.
#[must_use]
pub fn judge(drawn: &[Segment], target: &[Segment]) -> Judgement {
    let want = sample(target);
    let got = sample(drawn);
    let covered = want.iter().filter(|p| near(**p, &got)).count();
    let on_target = got.iter().filter(|p| near(**p, &want)).count();
    let pct = |a: usize, b: usize| if b == 0 { 100 } else { (a * 100 / b) as u32 };
    let coverage = pct(covered, want.len());
    let precision = if got.is_empty() {
        0
    } else {
        pct(on_target, got.len())
    };
    let accuracy = if coverage + precision == 0 {
        0
    } else {
        2 * coverage * precision / (coverage + precision)
    };
    let missing = target.iter().position(|s| {
        sample(std::slice::from_ref(s))
            .iter()
            .any(|p| !near(*p, &got))
    });
    Judgement {
        passed: coverage >= MIN_COVERAGE_PCT && precision >= MIN_PRECISION_PCT,
        accuracy,
        coverage,
        precision,
        missing: missing.and_then(|i| u16::try_from(i).ok()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(text: &str) -> Program {
        parse(text).unwrap()
    }

    #[test]
    fn integer_sines_are_accurate() {
        assert_eq!(sin_e9(0), 0);
        assert_eq!(sin_e9(90), 1_000_000_000);
        assert_eq!(sin_e9(180), 0);
        assert_eq!(sin_e9(270), -1_000_000_000);
        assert!((sin_e9(30) - 500_000_000).abs() <= 1);
        assert!((cos_e9(60) - 500_000_000).abs() <= 1);
        assert!((sin_e9(45) - 707_106_781).abs() <= 1);
        assert_eq!(sin_e9(-90), -1_000_000_000);
    }

    #[test]
    fn parsing_reads_logo_and_counts_blocks() {
        let square = p("repeat 4 [forward 100 rt 90]");
        assert_eq!(to_text(&square), "REPEAT 4 [ FD 100 RT 90 ]");
        assert_eq!((blocks(&square), depth(&square)), (3, 1));
        assert!(parse("FD").is_err());
        assert!(parse("REPEAT 4 FD 10").is_err());
        assert!(parse("REPEAT 4 [ FD 10").is_err());
        assert!(parse("FD 10 ]").is_err());
        assert!(parse("JUMP 4").is_err());
        assert!(parse("FD 999").is_err());
        assert!(parse("REPEAT 2 [ REPEAT 2 [ REPEAT 2 [ REPEAT 2 [ FD 1 ] ] ] ]").is_err());
        assert_eq!(p("COLOR RED PU PD").len(), 3);
    }

    #[test]
    fn the_turtle_starts_up_and_turns_right() {
        let r = run(&p("FD 100 RT 90 FD 50"));
        assert_eq!(r.segments.len(), 2);
        let s = r.segments[0];
        assert_eq!((s.x1, s.y1, s.x2, s.y2), (0, 0, 0, -100_000));
        let s = r.segments[1];
        assert_eq!((s.x2, s.y2), (50_000, -100_000));
        let square = run(&p("REPEAT 4 [ FD 100 RT 90 ]"));
        let last = square.steps.last().unwrap();
        assert_eq!((last.x, last.y, last.heading), (0, 0, 0));
        // Blocks are numbered in reading order: REPEAT 0, FD 1, RT 2.
        assert_eq!(
            square.steps.iter().map(|s| s.block).collect::<Vec<_>>(),
            [1, 2, 1, 2, 1, 2, 1, 2]
        );
    }

    #[test]
    fn the_pen_and_colours_change_what_is_drawn() {
        let r = run(&p("FD 50 PU FD 50 PD COLOR RED FD 50"));
        assert_eq!(r.segments.len(), 2);
        assert_eq!(r.segments[1].color, Color::Red);
        assert_eq!(r.steps[1].drew, None);
    }

    #[test]
    fn the_judge_accepts_any_way_to_draw_the_same_picture() {
        let target = run(&p("REPEAT 4 [ FD 100 RT 90 ]")).segments;
        for same in [
            "FD 100 RT 90 FD 100 RT 90 FD 100 RT 90 FD 100",
            "FD 50 FD 50 RT 90 FD 100 RT 90 FD 100 RT 90 FD 100",
            "RT 90 FD 100 LT 90 FD 100 LT 90 FD 100 LT 90 FD 100",
        ] {
            let j = judge(&run(&p(same)).segments, &target);
            assert!(j.passed, "{same}: {j:?}");
        }
        let three_sides = judge(&run(&p("REPEAT 3 [ FD 100 RT 90 ]")).segments, &target);
        assert!(!three_sides.passed);
        assert_eq!(three_sides.missing, Some(3));
        let scribble = judge(
            &run(&p("REPEAT 4 [ FD 100 RT 90 ] RT 45 FD 140")).segments,
            &target,
        );
        assert!(!scribble.passed && scribble.coverage == 100);
        let wrong_colour = judge(
            &run(&p("COLOR RED REPEAT 4 [ FD 100 RT 90 ]")).segments,
            &target,
        );
        assert!(!wrong_colour.passed);
        let nothing = judge(&[], &target);
        assert!(!nothing.passed && nothing.accuracy == 0);
    }

    #[test]
    fn huge_loops_stop_at_the_step_limit() {
        let r = run(&p("REPEAT 36 [ REPEAT 36 [ REPEAT 36 [ FD 1 RT 1 ] ] ]"));
        assert_eq!(r.steps.len(), MAX_STEPS);
    }
}
