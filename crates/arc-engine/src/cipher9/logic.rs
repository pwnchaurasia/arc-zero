//! Solving like a person: the techniques people use, simplest first.
//!
//! The level generator grades a puzzle by the hardest technique it needs, and the
//! server's hints explain the next step with the same code, so a level's tier and its
//! hints always agree. Puzzles that need anything beyond these techniques (or a guess)
//! are never generated.

use serde::Serialize;

use super::{Grid, CELLS, SIZE};

/// Candidate bits 1..=9.
const ALL: u16 = 0b11_1111_1110;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Technique {
    /// A cell where only one number fits.
    NakedSingle,
    /// A number that fits in only one cell of a row, column or box.
    HiddenSingle,
    /// Two cells of a unit that share the same two candidates.
    NakedPair,
    /// A number confined to one line inside a box (or one box along a line).
    LockedCandidates,
    /// A number in two rows (or columns) confined to the same two columns (or rows).
    XWing,
    /// Three two-candidate cells that remove a shared candidate.
    XyWing,
}

impl Technique {
    #[must_use]
    pub const fn id(self) -> &'static str {
        match self {
            Self::NakedSingle => "naked_single",
            Self::HiddenSingle => "hidden_single",
            Self::NakedPair => "naked_pair",
            Self::LockedCandidates => "locked_candidates",
            Self::XWing => "x_wing",
            Self::XyWing => "xy_wing",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum UnitKind {
    Row,
    Column,
    Box,
}

impl UnitKind {
    #[must_use]
    pub const fn id(self) -> &'static str {
        match self {
            Self::Row => "row",
            Self::Column => "column",
            Self::Box => "box",
        }
    }
}

/// A row, column or box, numbered 0-8 within its kind.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct Unit {
    pub kind: UnitKind,
    pub index: u8,
}

impl Unit {
    const fn of(u: usize) -> Self {
        let kind = match u / SIZE {
            0 => UnitKind::Row,
            1 => UnitKind::Column,
            _ => UnitKind::Box,
        };
        Self {
            kind,
            index: (u % SIZE) as u8,
        }
    }
}

const fn build_units() -> [[usize; SIZE]; 27] {
    let mut units = [[0; SIZE]; 27];
    let mut i = 0;
    while i < SIZE {
        let mut j = 0;
        while j < SIZE {
            units[i][j] = i * SIZE + j;
            units[SIZE + i][j] = j * SIZE + i;
            units[2 * SIZE + i][j] = (i / 3) * 27 + (i % 3) * 3 + (j / 3) * SIZE + j % 3;
            j += 1;
        }
        i += 1;
    }
    units
}

/// Rows 0-8, then columns, then boxes, each listing its 9 cells.
pub const UNITS: [[usize; SIZE]; 27] = build_units();

const fn box_of(cell: usize) -> usize {
    (cell / 27) * 3 + (cell % SIZE) / 3
}

const fn sees(a: usize, b: usize) -> bool {
    a != b && (a / SIZE == b / SIZE || a % SIZE == b % SIZE || box_of(a) == box_of(b))
}

const fn build_peers() -> [[usize; 20]; CELLS] {
    let mut peers = [[0; 20]; CELLS];
    let mut c = 0;
    while c < CELLS {
        let (mut n, mut o) = (0, 0);
        while o < CELLS {
            if sees(c, o) {
                peers[c][n] = o;
                n += 1;
            }
            o += 1;
        }
        c += 1;
    }
    peers
}

/// The 20 cells sharing a row, column or box with each cell.
pub const PEERS: [[usize; 20]; CELLS] = build_peers();

const fn bit(d: u8) -> u16 {
    1 << d
}

/// The digits in a candidate mask, lowest first.
fn digits(mask: u16) -> impl Iterator<Item = u8> {
    (1..=9u8).filter(move |d| mask & bit(*d) != 0)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Step {
    Place {
        cell: usize,
        digit: u8,
        technique: Technique,
        /// The unit a hidden single is found in.
        unit: Option<Unit>,
    },
    /// Candidates `(cell, digit)` that can be crossed out.
    Eliminate {
        technique: Technique,
        removals: Vec<(usize, u8)>,
    },
}

/// A grid with every empty cell's candidates.
#[derive(Clone, Debug)]
pub struct Board {
    grid: Grid,
    cands: [u16; CELLS],
}

impl Board {
    /// `None` when the grid already breaks the rules or leaves a cell with no candidate.
    #[must_use]
    pub fn new(grid: &Grid) -> Option<Self> {
        if !super::consistent(grid) {
            return None;
        }
        let mut cands = [0u16; CELLS];
        for (c, cand) in cands.iter_mut().enumerate() {
            if grid[c] == 0 {
                let used = PEERS[c].iter().fold(0, |m, &p| m | bit(grid[p]));
                *cand = ALL & !used;
                if *cand == 0 {
                    return None;
                }
            }
        }
        Some(Self { grid: *grid, cands })
    }

    #[must_use]
    pub fn solved(&self) -> bool {
        self.grid.iter().all(|d| *d != 0)
    }

    #[must_use]
    pub fn candidates(&self, cell: usize) -> u16 {
        self.cands[cell]
    }

    fn place(&mut self, cell: usize, digit: u8) {
        self.grid[cell] = digit;
        self.cands[cell] = 0;
        for &p in &PEERS[cell] {
            self.cands[p] &= !bit(digit);
        }
    }

    pub fn apply(&mut self, step: &Step) {
        match step {
            Step::Place { cell, digit, .. } => self.place(*cell, *digit),
            Step::Eliminate { removals, .. } => {
                for &(c, d) in removals {
                    self.cands[c] &= !bit(d);
                }
            }
        }
    }

    /// Whether some empty cell has run out of candidates (the grid is wrong).
    fn stuck(&self) -> bool {
        (0..CELLS).any(|c| self.grid[c] == 0 && self.cands[c] == 0)
    }

    /// The simplest step that makes progress, if any.
    #[must_use]
    pub fn step(&self) -> Option<Step> {
        self.naked_single()
            .or_else(|| self.hidden_single())
            .or_else(|| self.naked_pair())
            .or_else(|| self.locked_candidates())
            .or_else(|| self.x_wing())
            .or_else(|| self.xy_wing())
    }

    fn naked_single(&self) -> Option<Step> {
        (0..CELLS)
            .find(|&c| self.grid[c] == 0 && self.cands[c].count_ones() == 1)
            .map(|cell| Step::Place {
                cell,
                digit: self.cands[cell].trailing_zeros() as u8,
                technique: Technique::NakedSingle,
                unit: None,
            })
    }

    /// Cells of `unit` where `digit` is still a candidate.
    fn spots(&self, unit: &[usize; SIZE], digit: u8) -> impl Iterator<Item = usize> + '_ {
        unit.iter()
            .copied()
            .filter(move |&c| self.grid[c] == 0 && self.cands[c] & bit(digit) != 0)
            .collect::<Vec<_>>()
            .into_iter()
    }

    fn hidden_single(&self) -> Option<Step> {
        // Boxes first: that's where people look.
        for u in (2 * SIZE..27).chain(0..2 * SIZE) {
            let unit = &UNITS[u];
            for digit in 1..=9u8 {
                if unit.iter().any(|&c| self.grid[c] == digit) {
                    continue;
                }
                let mut spots = self.spots(unit, digit);
                if let (Some(cell), None) = (spots.next(), spots.next()) {
                    return Some(Step::Place {
                        cell,
                        digit,
                        technique: Technique::HiddenSingle,
                        unit: Some(Unit::of(u)),
                    });
                }
            }
        }
        None
    }

    fn removals<I: IntoIterator<Item = usize>>(&self, cells: I, mask: u16) -> Vec<(usize, u8)> {
        let mut out = Vec::new();
        for c in cells {
            for d in digits(self.cands[c] & mask) {
                out.push((c, d));
            }
        }
        out
    }

    fn eliminate(technique: Technique, removals: Vec<(usize, u8)>) -> Option<Step> {
        (!removals.is_empty()).then_some(Step::Eliminate {
            technique,
            removals,
        })
    }

    fn naked_pair(&self) -> Option<Step> {
        for unit in &UNITS {
            for (i, &a) in unit.iter().enumerate() {
                let pair = self.cands[a];
                if self.grid[a] != 0 || pair.count_ones() != 2 {
                    continue;
                }
                for &b in &unit[i + 1..] {
                    if self.grid[b] != 0 || self.cands[b] != pair {
                        continue;
                    }
                    let others = unit
                        .iter()
                        .copied()
                        .filter(|&c| c != a && c != b && self.grid[c] == 0);
                    let found = Self::eliminate(Technique::NakedPair, self.removals(others, pair));
                    if found.is_some() {
                        return found;
                    }
                }
            }
        }
        None
    }

    fn locked_candidates(&self) -> Option<Step> {
        for digit in 1..=9u8 {
            // Pointing: inside a box, the number sits on one row or column only.
            for b in 0..SIZE {
                let spots: Vec<usize> = self.spots(&UNITS[2 * SIZE + b], digit).collect();
                let Some(&first) = spots.first() else {
                    continue;
                };
                for line in [first / SIZE, SIZE + first % SIZE] {
                    if !spots.iter().all(|c| UNITS[line].contains(c)) {
                        continue;
                    }
                    let outside = UNITS[line]
                        .iter()
                        .copied()
                        .filter(|&c| box_of(c) != b && self.grid[c] == 0);
                    let found = Self::eliminate(
                        Technique::LockedCandidates,
                        self.removals(outside, bit(digit)),
                    );
                    if found.is_some() {
                        return found;
                    }
                }
            }
            // Claiming: along a row or column, the number sits in one box only.
            for line in &UNITS[..2 * SIZE] {
                let spots: Vec<usize> = self.spots(line, digit).collect();
                let Some(&first) = spots.first() else {
                    continue;
                };
                let b = box_of(first);
                if !spots.iter().all(|&c| box_of(c) == b) {
                    continue;
                }
                let outside = UNITS[2 * SIZE + b]
                    .iter()
                    .copied()
                    .filter(|c| !line.contains(c) && self.grid[*c] == 0);
                let found = Self::eliminate(
                    Technique::LockedCandidates,
                    self.removals(outside, bit(digit)),
                );
                if found.is_some() {
                    return found;
                }
            }
        }
        None
    }

    fn x_wing(&self) -> Option<Step> {
        for digit in 1..=9u8 {
            // Rows as the base (the number's columns are crossed out elsewhere), then columns.
            for (base, cover) in [(0, SIZE), (SIZE, 0)] {
                let at = |line: usize| -> Vec<usize> {
                    self.spots(&UNITS[base + line], digit)
                        .map(|c| if base == 0 { c % SIZE } else { c / SIZE })
                        .collect()
                };
                for l1 in 0..SIZE {
                    let first = at(l1);
                    if first.len() != 2 {
                        continue;
                    }
                    for l2 in l1 + 1..SIZE {
                        if at(l2) != first {
                            continue;
                        }
                        let crossed = first.iter().flat_map(|&k| UNITS[cover + k]).filter(|&c| {
                            let line = if base == 0 { c / SIZE } else { c % SIZE };
                            line != l1 && line != l2 && self.grid[c] == 0
                        });
                        let found =
                            Self::eliminate(Technique::XWing, self.removals(crossed, bit(digit)));
                        if found.is_some() {
                            return found;
                        }
                    }
                }
            }
        }
        None
    }

    fn xy_wing(&self) -> Option<Step> {
        let pairs: Vec<usize> = (0..CELLS)
            .filter(|&c| self.grid[c] == 0 && self.cands[c].count_ones() == 2)
            .collect();
        for &pivot in &pairs {
            let xy = self.cands[pivot];
            for &p1 in &pairs {
                let m1 = self.cands[p1];
                // The pincers each share one number with the pivot and a third, `z`, between them.
                if !sees(pivot, p1) || (m1 & xy).count_ones() != 1 {
                    continue;
                }
                for &p2 in &pairs {
                    let m2 = self.cands[p2];
                    if p2 == p1
                        || !sees(pivot, p2)
                        || (m2 & xy).count_ones() != 1
                        || m1 & m2 & xy != 0
                    {
                        continue;
                    }
                    let z = m1 & m2 & !xy;
                    if z.count_ones() != 1 || (m1 | m2) & xy != xy {
                        continue;
                    }
                    let both = (0..CELLS)
                        .filter(|&c| c != pivot && sees(c, p1) && sees(c, p2) && self.grid[c] == 0);
                    let found = Self::eliminate(Technique::XyWing, self.removals(both, z));
                    if found.is_some() {
                        return found;
                    }
                }
            }
        }
        None
    }
}

/// The hardest technique solving `puzzle` needs, or `None` if these techniques can't
/// solve it without guessing.
#[must_use]
pub fn grade(puzzle: &Grid) -> Option<Technique> {
    let mut board = Board::new(puzzle)?;
    let mut hardest = Technique::NakedSingle;
    while !board.solved() {
        if board.stuck() {
            return None;
        }
        let step = board.step()?;
        let technique = match &step {
            Step::Place { technique, .. } | Step::Eliminate { technique, .. } => *technique,
        };
        hardest = hardest.max(technique);
        board.apply(&step);
    }
    Some(hardest)
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Hint {
    pub cell: usize,
    pub digit: u8,
    /// How the number is found; `None` when no technique here finds a next number and
    /// the hint simply reveals one.
    pub technique: Option<Technique>,
    pub unit: Option<Unit>,
    /// Harder techniques that had to cross out candidates first, in order, once each.
    pub after: Vec<Technique>,
}

/// The next number a person could find in `grid` (every number in it must be right).
/// `None` once the grid is full.
#[must_use]
pub fn hint(grid: &Grid, solution: &Grid) -> Option<Hint> {
    let mut board = Board::new(grid)?;
    if board.solved() {
        return None;
    }
    let mut after: Vec<Technique> = Vec::new();
    while let Some(step) = board.step() {
        match step {
            Step::Place {
                cell,
                digit,
                technique,
                unit,
            } => {
                // Sound deductions from right numbers always give the solution's number.
                if digit != solution[cell] {
                    break;
                }
                return Some(Hint {
                    cell,
                    digit,
                    technique: Some(technique),
                    unit,
                    after,
                });
            }
            Step::Eliminate { technique, .. } => {
                if !after.contains(&technique) {
                    after.push(technique);
                }
                board.apply(&step);
            }
        }
    }
    // Nothing simple left: reveal the empty cell with the fewest candidates.
    let cell = (0..CELLS)
        .filter(|&c| grid[c] == 0)
        .min_by_key(|&c| board.candidates(c).count_ones())?;
    Some(Hint {
        cell,
        digit: solution[cell],
        technique: None,
        unit: None,
        after: Vec::new(),
    })
}

/// How many solutions `grid` has, counting up to `limit`.
#[must_use]
pub fn count_solutions(grid: &Grid, limit: usize) -> usize {
    if !super::consistent(grid) {
        return 0;
    }
    let mut g = *grid;
    let mut count = 0;
    search(&mut g, limit, &mut count);
    count
}

fn search(g: &mut Grid, limit: usize, count: &mut usize) {
    // The empty cell with the fewest options next (minimum remaining values).
    let mut best: Option<(usize, u16)> = None;
    for c in 0..CELLS {
        if g[c] != 0 {
            continue;
        }
        let used = PEERS[c].iter().fold(0, |m, &p| m | bit(g[p]));
        let free = ALL & !used;
        if free == 0 {
            return;
        }
        if best.is_none_or(|(_, m)| free.count_ones() < m.count_ones()) {
            best = Some((c, free));
        }
    }
    let Some((cell, free)) = best else {
        *count += 1;
        return;
    };
    for d in digits(free) {
        g[cell] = d;
        search(g, limit, count);
        if *count >= limit {
            break;
        }
    }
    g[cell] = 0;
}

#[cfg(test)]
mod tests {
    use super::super::{parse_grid, tests::level};
    use super::*;

    fn grid(text: &str) -> Grid {
        parse_grid(text, true).unwrap()
    }

    #[test]
    fn units_and_peers_line_up() {
        assert_eq!(UNITS[0], [0, 1, 2, 3, 4, 5, 6, 7, 8]);
        assert_eq!(UNITS[9], [0, 9, 18, 27, 36, 45, 54, 63, 72]);
        assert_eq!(UNITS[18 + 4], [30, 31, 32, 39, 40, 41, 48, 49, 50]);
        assert!(PEERS.iter().all(|p| p.len() == 20));
        assert!(PEERS[40].contains(&4) && PEERS[40].contains(&36) && PEERS[40].contains(&30));
        assert!(!PEERS[40].contains(&0));
    }

    #[test]
    fn an_easy_puzzle_needs_only_singles() {
        let (p, s) = level().grids().unwrap();
        assert!(grade(&p) <= Some(Technique::HiddenSingle));
        assert_eq!(count_solutions(&p, 2), 1);
        let h = hint(&p, &s).unwrap();
        assert_eq!(h.digit, s[h.cell]);
        assert!(h.technique.is_some() && h.after.is_empty());
        assert_eq!(hint(&s, &s), None, "a full grid needs no hint");
    }

    #[test]
    fn harder_techniques_are_recognised() {
        // Well-known puzzles that need an X-Wing and an XY-Wing (from solver test suites).
        let x_wing = grid(
            "100000569492056108056109240009640801064010000218035604040500016905061402621000005",
        );
        assert_eq!(grade(&x_wing), Some(Technique::XWing));
        let xy_wing = grid(
            "900040000000600031020000090000700020002935600070002000060000073510009000000080009",
        );
        assert_eq!(count_solutions(&xy_wing, 2), 1);
        assert!(grade(&xy_wing).is_none_or(|t| t >= Technique::NakedPair));
    }

    #[test]
    fn counting_stops_at_the_limit() {
        assert_eq!(count_solutions(&[0; CELLS], 2), 2);
        let (p, _) = level().grids().unwrap();
        let mut twice = p;
        twice[2] = 5;
        assert_eq!(
            count_solutions(&twice, 2),
            0,
            "a broken grid has no solution"
        );
    }

    #[test]
    fn a_hint_reveals_a_cell_when_nothing_simple_is_left() {
        // The hardest known puzzles need far more than these techniques.
        let hard = grid(
            "800000000003600000070090200050007000000045700000100030001000068008500010090000400",
        );
        let mut solution = hard;
        assert_eq!(count_solutions(&hard, 2), 1);
        assert!(grade(&hard).is_none());
        solve_into(&mut solution);
        let h = hint(&hard, &solution).unwrap();
        assert_eq!(h.digit, solution[h.cell]);
    }

    #[test]
    fn every_step_agrees_with_the_solution() {
        for text in [
            "100000569492056108056109240009640801064010000218035604040500016905061402621000005",
            "900040000000600031020000090000700020002935600070002000060000073510009000000080009",
            super::super::tests::PUZZLE,
        ] {
            let puzzle = grid(text);
            let mut solution = puzzle;
            solve_into(&mut solution);
            let mut board = Board::new(&puzzle).unwrap();
            while let Some(step) = board.step() {
                match &step {
                    Step::Place { cell, digit, .. } => assert_eq!(*digit, solution[*cell]),
                    Step::Eliminate { removals, .. } => {
                        assert!(removals.iter().all(|&(c, d)| solution[c] != d), "{step:?}");
                    }
                }
                board.apply(&step);
            }
        }
    }

    fn solve_into(g: &mut Grid) {
        fn go(g: &mut Grid) -> bool {
            let Some(c) = (0..CELLS).find(|&c| g[c] == 0) else {
                return true;
            };
            let used = PEERS[c].iter().fold(0, |m, &p| m | bit(g[p]));
            for d in digits(ALL & !used) {
                g[c] = d;
                if go(g) {
                    return true;
                }
            }
            g[c] = 0;
            false
        }
        assert!(go(g));
    }
}
