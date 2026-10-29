//! One turn of Brick Blast: launch, simulate tick by tick, then resolve the turn end.
//!
//! The client steps a [`Turn`] once per rendered tick to animate it; the server
//! calls [`play_turn`] to run the same simulation to completion.

use std::fmt;

use super::geom::{aim_velocity, closest_on_polygon, polygon, reflect, rotate, to_i32, V};
use super::{
    cell_index, free_rows, Cell, PowerKind, Row, State, StateError, Status, AIM_MAX, AIM_MIN,
    BALL_R, BOARD_W, CELL, CLONE_LIFETIME, COLS, EMPTY_ROW, FLOOR_Y, GROUND_ROW, LAUNCH_INTERVAL,
    MAX_ACTIVE_BALLS, MAX_BALLS, MAX_TICKS_PER_TURN, MAX_TURNS, PLAY_ROWS, POWER_R, ROWS, SUBSTEPS,
};
use crate::isqrt;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Ball {
    pub id: u32,
    pub x: i32,
    pub y: i32,
    pub vx: i32,
    pub vy: i32,
    /// Tick at which a clone vanishes; `0` for original balls.
    pub clone_expires: u32,
    alive: bool,
    /// Power-up cells this ball currently overlaps (bit = cell index).
    touching: u128,
    /// Ball Up cells this ball has already split on.
    split: u128,
}

impl Ball {
    #[must_use]
    pub fn is_clone(&self) -> bool {
        self.clone_expires != 0
    }
}

/// Things the renderer reacts to (sound, particles, beams).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Event {
    Hit { cell: u8, hp: u16 },
    Blast { cell: u8 },
    Laser { cell: u8, kind: PowerKind },
    Split { cell: u8 },
    Collect { cell: u8, amount: u16 },
    Land { x: i32 },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TurnError {
    NotPlaying,
    AimOutOfRange(u16),
    InvalidState(StateError),
    /// The client must provide the next row (received from the server) before finishing.
    MissingRow,
}

impl fmt::Display for TurnError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotPlaying => f.write_str("the run is already over"),
            Self::AimOutOfRange(a) => write!(f, "aim {a} outside {AIM_MIN}..={AIM_MAX}"),
            Self::InvalidState(e) => write!(f, "invalid state: {e}"),
            Self::MissingRow => f.write_str("next row not provided"),
        }
    }
}

impl std::error::Error for TurnError {}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TurnSummary {
    pub ticks: u32,
    pub hits: u32,
    pub blasted: u32,
    pub collected: u16,
    /// The row that entered at the top at the end of this turn, if any.
    pub new_row: Option<Row>,
}

struct Contact {
    row: usize,
    col: usize,
    point: V,
    inside: bool,
}

/// Deepest block overlap for a ball centred at `(x, y)`, if any.
fn find_contact(grid: &[Row], x: i32, y: i32) -> Option<Contact> {
    let p = V::new(i64::from(x), i64::from(y));
    let r2 = i64::from(BALL_R) * i64::from(BALL_R);
    let span = |c: i32, max: usize| {
        let lo = usize::try_from((c - BALL_R).max(0) / CELL).unwrap_or(0);
        let hi = usize::try_from((c + BALL_R).max(0) / CELL).unwrap_or(0);
        (lo.min(max - 1), hi.min(max - 1))
    };
    let (c0, c1) = span(x, COLS);
    let (r0, r1) = span(y, PLAY_ROWS);
    let mut best: Option<(i64, Contact)> = None;
    for (row, cells) in grid.iter().enumerate().take(r1 + 1).skip(r0) {
        for (col, cell) in cells.iter().enumerate().take(c1 + 1).skip(c0) {
            let Cell::Block { shape, .. } = *cell else {
                continue;
            };
            let (poly, n) = polygon(shape, row, col);
            let (point, inside) = closest_on_polygon(p, &poly[..n]);
            let d2 = V::new(p.x - point.x, p.y - point.y).len2();
            if !inside && d2 >= r2 {
                continue;
            }
            let depth = if inside { i64::MAX } else { r2 - d2 };
            if best.as_ref().is_none_or(|(d, _)| depth > *d) {
                best = Some((
                    depth,
                    Contact {
                        row,
                        col,
                        point,
                        inside,
                    },
                ));
            }
        }
    }
    best.map(|(_, c)| c)
}

/// Bounces a ball off a block contact. Returns true if the ball struck it
/// (was moving into the surface), which is what deals damage.
fn resolve(ball: &mut Ball, contact: &Contact) -> bool {
    if contact.inside {
        // Tunnelled in (should not happen at our speeds): back out and reverse.
        ball.x -= ball.vx;
        ball.y -= ball.vy;
        ball.vx = -ball.vx;
        ball.vy = -ball.vy;
        return true;
    }
    let n = V::new(
        i64::from(ball.x) - contact.point.x,
        i64::from(ball.y) - contact.point.y,
    );
    if i64::from(ball.vx) * n.x + i64::from(ball.vy) * n.y >= 0 {
        return false;
    }
    (ball.vx, ball.vy) = reflect((ball.vx, ball.vy), n);
    let len = i64::try_from(isqrt(u64::try_from(n.len2()).unwrap_or(0)))
        .unwrap_or(1)
        .max(1);
    let push = i64::from(BALL_R) + 1;
    ball.x = to_i32(contact.point.x + n.x * push / len);
    ball.y = to_i32(contact.point.y + n.y * push / len);
    true
}

/// Side walls and ceiling. Returns true if the ball bounced.
fn bounce_walls(ball: &mut Ball) -> bool {
    let mut bounced = false;
    if ball.x < BALL_R {
        ball.x = BALL_R;
        ball.vx = ball.vx.abs();
        bounced = true;
    } else if ball.x > BOARD_W - BALL_R {
        ball.x = BOARD_W - BALL_R;
        ball.vx = -ball.vx.abs();
        bounced = true;
    }
    if ball.y < BALL_R {
        ball.y = BALL_R;
        ball.vy = ball.vy.abs();
        bounced = true;
    }
    bounced
}

fn on_floor(ball: &Ball) -> bool {
    ball.y >= FLOOR_Y - BALL_R && ball.vy > 0
}

fn launch_y() -> i32 {
    FLOOR_Y - BALL_R - 1
}

fn clamp_x(x: i32) -> i32 {
    x.clamp(BALL_R, BOARD_W - BALL_R)
}

pub struct Turn {
    state: State,
    balls: Vec<Ball>,
    spawned: Vec<Ball>,
    events: Vec<Event>,
    tick: u32,
    launched: u16,
    next_id: u32,
    launch_v: (i32, i32),
    first_land: Option<i32>,
    collected: u16,
    touched: u128,
    blocks_left: usize,
    hits: u32,
    blasted: u32,
    won: bool,
    done: bool,
}

impl Turn {
    pub fn new(state: &State, aim: u16) -> Result<Self, TurnError> {
        if state.status != Status::Playing {
            return Err(TurnError::NotPlaying);
        }
        if !(AIM_MIN..=AIM_MAX).contains(&aim) {
            return Err(TurnError::AimOutOfRange(aim));
        }
        state.validate().map_err(TurnError::InvalidState)?;
        Ok(Self {
            blocks_left: state.block_count(),
            state: state.clone(),
            balls: Vec::with_capacity(usize::from(state.balls)),
            spawned: Vec::new(),
            events: Vec::new(),
            tick: 0,
            launched: 0,
            next_id: 0,
            launch_v: aim_velocity(aim),
            first_land: None,
            collected: 0,
            touched: 0,
            hits: 0,
            blasted: 0,
            won: false,
            done: false,
        })
    }

    #[must_use]
    pub fn tick(&self) -> u32 {
        self.tick
    }

    #[must_use]
    pub fn is_done(&self) -> bool {
        self.done
    }

    #[must_use]
    pub fn balls(&self) -> &[Ball] {
        &self.balls
    }

    /// Live grid (block HP updates as hits land).
    #[must_use]
    pub fn grid(&self) -> &[Row] {
        &self.state.grid
    }

    /// Original balls not yet launched.
    #[must_use]
    pub fn waiting(&self) -> u16 {
        self.state.balls - self.launched
    }

    pub fn take_events(&mut self) -> Vec<Event> {
        std::mem::take(&mut self.events)
    }

    /// Supplies the next row (client side, from the server's turn response).
    pub fn provide_row(&mut self, row: Row) {
        if self.state.queue.len() < usize::from(self.state.rows_remaining) {
            self.state.queue.push(row);
        }
    }

    /// Advances one tick. Returns true once the turn is over.
    pub fn step(&mut self) -> bool {
        if self.done {
            return true;
        }
        if self.launched < self.state.balls && self.tick.is_multiple_of(LAUNCH_INTERVAL) {
            self.balls.push(Ball {
                id: self.next_id,
                x: self.state.launch_x,
                y: launch_y(),
                vx: self.launch_v.0,
                vy: self.launch_v.1,
                clone_expires: 0,
                alive: true,
                touching: 0,
                split: 0,
            });
            self.next_id += 1;
            self.launched += 1;
        }
        for _ in 0..SUBSTEPS {
            for i in 0..self.balls.len() {
                if self.balls[i].alive {
                    let mut ball = self.balls[i];
                    self.advance(&mut ball);
                    self.balls[i] = ball;
                }
                if self.won {
                    break;
                }
            }
            self.balls.append(&mut self.spawned);
            if self.won {
                break;
            }
        }
        let tick = self.tick;
        for ball in &mut self.balls {
            if ball.is_clone() && tick >= ball.clone_expires {
                ball.alive = false;
            }
        }
        self.balls.retain(|b| b.alive);
        self.tick += 1;
        let all_back = self.launched == self.state.balls && self.balls.is_empty();
        if self.won || all_back || self.tick >= MAX_TICKS_PER_TURN {
            self.done = true;
        }
        self.done
    }

    pub fn run_to_end(&mut self) {
        while !self.step() {}
    }

    fn advance(&mut self, ball: &mut Ball) {
        ball.x += ball.vx;
        ball.y += ball.vy;
        bounce_walls(ball);
        if on_floor(ball) {
            ball.alive = false;
            if !ball.is_clone() && self.first_land.is_none() {
                let x = clamp_x(ball.x);
                self.first_land = Some(x);
                self.events.push(Event::Land { x });
            }
            return;
        }
        if let Some(contact) = find_contact(&self.state.grid, ball.x, ball.y) {
            if resolve(ball, &contact) {
                self.damage(contact.row, contact.col);
            }
        }
        self.touch_power_ups(ball);
    }

    fn damage(&mut self, row: usize, col: usize) {
        let cell = cell_index(row, col);
        let Cell::Block { hp, .. } = &mut self.state.grid[row][col] else {
            return;
        };
        *hp -= 1;
        self.hits += 1;
        if *hp > 0 {
            self.events.push(Event::Hit { cell, hp: *hp });
            return;
        }
        self.state.grid[row][col] = Cell::Empty;
        self.blocks_left -= 1;
        self.blasted += 1;
        self.events.push(Event::Blast { cell });
        if self.blocks_left == 0 && self.state.rows_remaining == 0 {
            self.won = true;
        }
    }

    fn touch_power_ups(&mut self, ball: &mut Ball) {
        let reach = BALL_R + POWER_R;
        let reach2 = i64::from(reach) * i64::from(reach);
        let lo = |c: i32| usize::try_from((c - reach).max(0) / CELL).unwrap_or(0);
        let hi = |c: i32, max: usize| {
            usize::try_from((c + reach).max(0) / CELL)
                .unwrap_or(0)
                .min(max - 1)
        };
        let mut now: u128 = 0;
        for row in lo(ball.y).min(PLAY_ROWS - 1)..=hi(ball.y, PLAY_ROWS) {
            for col in lo(ball.x).min(COLS - 1)..=hi(ball.x, COLS) {
                if !matches!(self.state.grid[row][col], Cell::Power { .. }) {
                    continue;
                }
                let cx = i64::from(i32::try_from(col).unwrap_or(0) * CELL + CELL / 2);
                let cy = i64::from(i32::try_from(row).unwrap_or(0) * CELL + CELL / 2);
                let (dx, dy) = (i64::from(ball.x) - cx, i64::from(ball.y) - cy);
                if dx * dx + dy * dy <= reach2 {
                    now |= 1u128 << cell_index(row, col);
                }
            }
        }
        let entering = now & !ball.touching;
        ball.touching = now;
        let mut bits = entering;
        while bits != 0 {
            let idx = bits.trailing_zeros() as usize;
            bits &= bits - 1;
            self.trigger(ball, idx / COLS, idx % COLS);
        }
    }

    fn trigger(&mut self, ball: &mut Ball, row: usize, col: usize) {
        let Cell::Power { kind } = self.state.grid[row][col] else {
            return;
        };
        let cell = cell_index(row, col);
        let bit = 1u128 << cell;
        let first_touch = self.touched & bit == 0;
        self.touched |= bit;
        match kind {
            PowerKind::LaserH | PowerKind::LaserV | PowerKind::LaserX => {
                self.events.push(Event::Laser { cell, kind });
                if matches!(kind, PowerKind::LaserH | PowerKind::LaserX) {
                    for c in 0..COLS {
                        self.damage(row, c);
                    }
                }
                if matches!(kind, PowerKind::LaserV | PowerKind::LaserX) {
                    for r in 0..PLAY_ROWS {
                        self.damage(r, col);
                    }
                }
            }
            PowerKind::BallUp3 | PowerKind::BallUp5 => {
                if ball.is_clone() || ball.split & bit != 0 {
                    return;
                }
                ball.split |= bit;
                self.events.push(Event::Split { cell });
                let offsets: &[i32] = if kind == PowerKind::BallUp3 {
                    &[-120, 120]
                } else {
                    &[-160, -80, 80, 160]
                };
                for &off in offsets {
                    if self.balls.len() + self.spawned.len() >= MAX_ACTIVE_BALLS {
                        break;
                    }
                    let (vx, vy) = rotate((ball.vx, ball.vy), off);
                    self.spawned.push(Ball {
                        id: self.next_id,
                        vx,
                        vy,
                        clone_expires: self.tick + CLONE_LIFETIME,
                        ..*ball
                    });
                    self.next_id += 1;
                }
            }
            PowerKind::PlusBalls2 | PowerKind::PlusBalls3 | PowerKind::PlusBalls5 => {
                if first_touch {
                    let amount = match kind {
                        PowerKind::PlusBalls2 => 2,
                        PowerKind::PlusBalls3 => 3,
                        _ => 5,
                    };
                    self.collected += amount;
                    self.events.push(Event::Collect { cell, amount });
                }
            }
        }
    }

    /// Ends the turn: consume power-ups, add collected balls, shift rows, check win/lose.
    pub fn finish(mut self) -> Result<(State, TurnSummary), TurnError> {
        self.run_to_end();
        let mut summary = TurnSummary {
            ticks: self.tick,
            hits: self.hits,
            blasted: self.blasted,
            collected: self.collected,
            new_row: None,
        };
        let s = &mut self.state;
        let mut bits = self.touched;
        while bits != 0 {
            let idx = bits.trailing_zeros() as usize;
            bits &= bits - 1;
            s.grid[idx / COLS][idx % COLS] = Cell::Empty;
        }
        s.balls = s.balls.saturating_add(self.collected).min(MAX_BALLS);
        if let Some(x) = self.first_land {
            s.launch_x = x;
        }
        s.turn += 1;
        if self.won {
            s.status = Status::Won;
            return Ok((self.state, summary));
        }

        s.grid.copy_within(0..ROWS - 1, 1);
        s.grid[0] = if s.rows_remaining > 0 {
            if s.queue.is_empty() {
                return Err(TurnError::MissingRow);
            }
            let row = s.queue.remove(0);
            s.rows_remaining -= 1;
            summary.new_row = Some(row);
            row
        } else {
            EMPTY_ROW
        };

        let mut lost = false;
        for cell in &mut s.grid[GROUND_ROW] {
            match cell {
                Cell::Block { .. } => lost = true,
                Cell::Power { .. } => *cell = Cell::Empty,
                Cell::Empty => {}
            }
        }
        if lost || s.turn >= MAX_TURNS {
            s.status = Status::Lost;
        } else {
            s.closest = s.closest.min(free_rows(&s.grid));
            if s.block_count() == 0 && s.rows_remaining == 0 {
                s.status = Status::Won;
            }
        }
        Ok((self.state, summary))
    }
}

/// Runs a whole turn. This is what the server executes for every `/turn` request.
pub fn play_turn(state: &State, aim: u16) -> Result<(State, TurnSummary), TurnError> {
    Turn::new(state, aim)?.finish()
}

/// Path of a single ghost ball for the aim guide: launch point then each
/// bounce point, up to `max_bounces`. Deals no damage.
#[must_use]
pub fn aim_path(state: &State, aim: u16, max_bounces: usize) -> Vec<(i32, i32)> {
    let (vx, vy) = aim_velocity(aim);
    let mut ball = Ball {
        id: 0,
        x: state.launch_x,
        y: launch_y(),
        vx,
        vy,
        clone_expires: 0,
        alive: true,
        touching: 0,
        split: 0,
    };
    let mut points = vec![(ball.x, ball.y)];
    for _ in 0..(MAX_TICKS_PER_TURN * SUBSTEPS) {
        ball.x += ball.vx;
        ball.y += ball.vy;
        let mut bounced = bounce_walls(&mut ball);
        if on_floor(&ball) {
            points.push((ball.x, FLOOR_Y - BALL_R));
            break;
        }
        if let Some(contact) = find_contact(&state.grid, ball.x, ball.y) {
            bounced |= resolve(&mut ball, &contact);
        }
        if bounced {
            points.push((ball.x, ball.y));
            if points.len() > max_bounces {
                break;
            }
        }
    }
    points
}

#[cfg(test)]
mod tests {
    use super::super::{LevelScript, Shape};
    use super::*;

    fn block(hp: u16) -> Cell {
        Cell::Block {
            shape: Shape::Square,
            hp,
        }
    }

    fn state_with(rows: Vec<Row>, queue: Vec<Row>, balls: u16) -> State {
        State::new(&LevelScript {
            start_balls: balls,
            start_rows: rows,
            row_queue: queue,
        })
        .unwrap()
    }

    #[test]
    fn straight_shot_hits_block_above_and_returns() {
        let mut row = EMPTY_ROW;
        row[4] = block(50);
        let s = state_with(vec![row], vec![], 3);
        let (after, summary) = play_turn(&s, 900).unwrap();
        // Each ball bounces between the block and the floor-free return path:
        // straight up, hit once, straight back down.
        assert_eq!(summary.hits, 3);
        let Cell::Block { hp, .. } = after.grid[1][4] else {
            panic!("block should have shifted down one row");
        };
        assert_eq!(hp, 47);
        assert_eq!(after.turn, 1);
        assert_eq!(after.status, Status::Playing);
    }

    #[test]
    fn clearing_last_block_wins_immediately() {
        let mut row = EMPTY_ROW;
        row[4] = block(1);
        let s = state_with(vec![row], vec![], 5);
        let (after, summary) = play_turn(&s, 900).unwrap();
        assert_eq!(after.status, Status::Won);
        assert_eq!(summary.blasted, 1);
        assert_eq!(after.stars(), 3);
    }

    #[test]
    fn block_reaching_ground_loses() {
        let mut grid_row = EMPTY_ROW;
        grid_row[0] = block(150);
        let mut s = state_with(vec![], vec![], 1);
        s.grid[PLAY_ROWS - 1] = grid_row;
        let (after, _) = play_turn(&s, 900).unwrap();
        assert_eq!(after.status, Status::Lost);
    }

    #[test]
    fn rows_enter_from_queue_and_client_must_provide_them() {
        let mut row = EMPTY_ROW;
        row[0] = block(9);
        let s = state_with(vec![row], vec![row], 1);
        let (server, summary) = play_turn(&s, 450).unwrap();
        assert_eq!(summary.new_row, Some(row));
        assert_eq!(server.rows_remaining, 0);

        let client_view = s.public();
        assert_eq!(play_turn(&client_view, 450), Err(TurnError::MissingRow));
        let mut turn = Turn::new(&client_view, 450).unwrap();
        turn.provide_row(row);
        let (client, _) = turn.finish().unwrap();
        assert_eq!(client.hash_hex(), server.hash_hex());
    }

    #[test]
    fn plus_balls_and_laser_power_ups() {
        let mut row = EMPTY_ROW;
        row[4] = Cell::Power {
            kind: PowerKind::PlusBalls3,
        };
        let mut blocks = EMPTY_ROW;
        blocks[0] = block(10);
        blocks[8] = block(10);
        blocks[4] = Cell::Power {
            kind: PowerKind::LaserH,
        };
        let s = state_with(vec![blocks, EMPTY_ROW, row], vec![], 2);
        let (after, summary) = play_turn(&s, 900).unwrap();
        assert_eq!(summary.collected, 3);
        assert_eq!(after.balls, 5);
        // Power-ups touched this turn are consumed.
        assert!(after
            .grid
            .iter()
            .flatten()
            .all(|c| !matches!(c, Cell::Power { .. })));
        // Each ball passing the laser hits both blocks in that row.
        let Cell::Block { hp, .. } = after.grid[1][0] else {
            panic!()
        };
        assert!(hp < 10);
    }

    #[test]
    fn ball_up_spawns_temporary_clones() {
        let mut row = EMPTY_ROW;
        row[4] = Cell::Power {
            kind: PowerKind::BallUp3,
        };
        let mut top = EMPTY_ROW;
        top[3] = block(150);
        top[4] = block(150);
        top[5] = block(150);
        let s = state_with(vec![top, EMPTY_ROW, EMPTY_ROW, row], vec![], 4);
        let mut turn = Turn::new(&s, 900).unwrap();
        let mut peak = 0;
        while !turn.step() {
            peak = peak.max(turn.balls().len());
        }
        assert!(peak > 4, "clones should appear, peak {peak}");
        let (after, _) = turn.finish().unwrap();
        assert_eq!(after.balls, 4, "clones never join the stack");
    }

    #[test]
    fn simulation_is_deterministic() {
        let mut a = EMPTY_ROW;
        a[1] = Cell::Block {
            shape: Shape::TriBr,
            hp: 30,
        };
        a[5] = block(40);
        a[7] = Cell::Block {
            shape: Shape::TriTl,
            hp: 12,
        };
        let s = state_with(vec![a, a, EMPTY_ROW, a], vec![a, a], 25);
        let one = play_turn(&s, 617).unwrap();
        let two = play_turn(&s, 617).unwrap();
        assert_eq!(one, two);
        assert_ne!(play_turn(&s, 618).unwrap().0.hash_hex(), one.0.hash_hex());
    }

    #[test]
    fn turn_is_bounded_and_lands_balls() {
        let s = state_with(vec![], vec![], 30);
        let mut turn = Turn::new(&s, 80).unwrap();
        turn.run_to_end();
        assert!(turn.tick() < MAX_TICKS_PER_TURN);
    }

    #[test]
    fn aim_guide_stops_after_bounces() {
        let s = state_with(vec![], vec![], 1);
        let path = aim_path(&s, 300, 2);
        assert_eq!(path.len(), 3);
        assert_eq!(path[0], (s.launch_x, FLOOR_Y - BALL_R - 1));
    }

    #[test]
    fn rejects_bad_input() {
        let s = state_with(vec![], vec![], 1);
        assert_eq!(play_turn(&s, 10).unwrap_err(), TurnError::AimOutOfRange(10));
        let mut over = s.clone();
        over.status = Status::Lost;
        assert_eq!(play_turn(&over, 900).unwrap_err(), TurnError::NotPlaying);
    }
}
