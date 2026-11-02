//! MetroJam: drive vehicles out of a jam into a few parking bays; commuters
//! at the front of the queue board any parked vehicle of their colour.
//!
//! Rules (see the MetroJam design doc §0 and §2):
//! - A vehicle occupies `length()` cells in a line. `(x, y)` is its front cell;
//!   the body extends backwards, opposite to `dir`.
//! - A tap drives a vehicle out when every cell from its front bumper to the
//!   grid edge is empty. It parks in the leftmost free bay.
//! - After every change the front commuter boards the leftmost parked vehicle
//!   of their colour with a free seat, repeatedly. A full vehicle departs.
//! - Won when every commuter has boarded.
//!
//! The client may hold only the start of the queue (hard levels hide the far
//! end). Boarding then stops at the last known commuter, and the server
//! reveals more after replaying the same moves with the full queue.

pub mod bot;

use std::fmt;

use serde::{Deserialize, Serialize};

pub const MAX_SIDE: u8 = 12;
pub const MAX_VEHICLES: usize = 96;
pub const MAX_COLORS: u8 = 8;
pub const MAX_BAYS: u8 = 7;
pub const MAX_QUEUE: usize = 2_400;
/// Every vehicle leaves at most once, plus a few assists.
pub const MAX_MOVES: usize = MAX_VEHICLES + 16;
/// Extra bays one attempt may add.
pub const MAX_EXTRA_BAYS: u8 = 2;
/// Commuters a queue shuffle may reorder (never more than the visible queue).
pub const SHUFFLE_WINDOW: u16 = 10;

const EMPTY: u8 = u8::MAX;
const BARRIER: u8 = u8::MAX - 1;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Microcar,
    Hatchback,
    Sedan,
    Mpv,
    Minivan,
    Minibus,
    Bus,
}

impl Kind {
    pub const ALL: [Self; 7] = [
        Self::Microcar,
        Self::Hatchback,
        Self::Sedan,
        Self::Mpv,
        Self::Minivan,
        Self::Minibus,
        Self::Bus,
    ];

    /// Seats including the driver's.
    #[must_use]
    pub const fn seats(self) -> u8 {
        match self {
            Self::Microcar => 2,
            Self::Hatchback => 3,
            Self::Sedan => 5,
            Self::Mpv => 7,
            Self::Minivan => 10,
            Self::Minibus => 13,
            Self::Bus => 50,
        }
    }

    /// Passengers it carries: every seat except the driver's.
    #[must_use]
    pub const fn riders(self) -> u8 {
        self.seats() - 1
    }

    /// Cells it covers on the grid.
    #[must_use]
    pub const fn length(self) -> u8 {
        match self {
            Self::Microcar | Self::Hatchback => 1,
            Self::Sedan | Self::Mpv => 2,
            Self::Minivan | Self::Minibus => 3,
            Self::Bus => 4,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Dir {
    N,
    E,
    S,
    W,
}

impl Dir {
    #[must_use]
    pub const fn delta(self) -> (i16, i16) {
        match self {
            Self::N => (0, -1),
            Self::E => (1, 0),
            Self::S => (0, 1),
            Self::W => (-1, 0),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Vehicle {
    pub kind: Kind,
    pub color: u8,
    pub x: u8,
    pub y: u8,
    pub dir: Dir,
}

impl Vehicle {
    /// Cells covered, front first.
    pub fn cells(&self) -> impl Iterator<Item = (i16, i16)> + '_ {
        let (dx, dy) = self.dir.delta();
        (0..i16::from(self.kind.length()))
            .map(move |i| (i16::from(self.x) - dx * i, i16::from(self.y) - dy * i))
    }
}

/// A level as stored by the server. The client receives a copy whose `queue`
/// may be cut short; `queue_len` is always the full length.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Level {
    pub width: u8,
    pub height: u8,
    #[serde(default)]
    pub barriers: Vec<(u8, u8)>,
    pub vehicles: Vec<Vehicle>,
    pub queue: Vec<u8>,
    pub queue_len: u16,
    pub bays: u8,
    /// Commuters shown ahead of the front one; `>= queue_len` shows them all.
    pub visible: u16,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Assist {
    /// Lift one vehicle out of the jam straight into a bay, blocked or not.
    Airlift,
    /// Visible commuters matching a parked vehicle step to the front.
    Shuffle,
    /// One more bay for the rest of the attempt.
    ExtraBay,
}

impl Assist {
    pub const ALL: [Self; 3] = [Self::ExtraBay, Self::Airlift, Self::Shuffle];

    #[must_use]
    pub const fn code(self) -> u8 {
        match self {
            Self::Airlift => 1,
            Self::Shuffle => 2,
            Self::ExtraBay => 3,
        }
    }
}

/// `(op, vehicle)`: op 0 tap, 1 airlift, 2 shuffle, 3 extra bay.
/// The vehicle index is ignored for shuffle and extra bay.
pub type Move = (u8, u8);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MoveError {
    UnknownOp(u8),
    NoSuchVehicle,
    AlreadyLeft,
    Blocked { by: Option<u8> },
    BaysFull,
    TooManyBays,
    NothingToShuffle,
}

impl fmt::Display for MoveError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnknownOp(op) => write!(f, "unknown move op {op}"),
            Self::NoSuchVehicle => f.write_str("no such vehicle"),
            Self::AlreadyLeft => f.write_str("vehicle already left the jam"),
            Self::Blocked { .. } => f.write_str("vehicle's way out is blocked"),
            Self::BaysFull => f.write_str("every bay is full"),
            Self::TooManyBays => f.write_str("no more bays can be added"),
            Self::NothingToShuffle => f.write_str("the queue has nothing to shuffle"),
        }
    }
}

impl std::error::Error for MoveError {}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LevelError {
    Size,
    TooManyVehicles(usize),
    Color(u8),
    OffGrid(usize),
    Overlap(usize),
    Barrier,
    Bays(u8),
    Queue(String),
}

impl fmt::Display for LevelError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Size => write!(f, "grid must be 3..={MAX_SIDE} on each side"),
            Self::TooManyVehicles(n) => write!(f, "{n} vehicles exceeds {MAX_VEHICLES}"),
            Self::Color(c) => write!(f, "colour {c} out of range"),
            Self::OffGrid(i) => write!(f, "vehicle {i} is off the grid"),
            Self::Overlap(i) => write!(f, "vehicle {i} overlaps another vehicle or a barrier"),
            Self::Barrier => f.write_str("barrier off the grid or overlapping"),
            Self::Bays(n) => write!(f, "{n} bays is out of range"),
            Self::Queue(m) => write!(f, "queue: {m}"),
        }
    }
}

impl std::error::Error for LevelError {}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ReplayError {
    TooManyMoves(usize),
    InvalidLevel(LevelError),
    IllegalMove { index: usize, error: MoveError },
}

impl fmt::Display for ReplayError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::TooManyMoves(n) => write!(f, "{n} moves exceeds the limit of {MAX_MOVES}"),
            Self::InvalidLevel(e) => write!(f, "invalid level: {e}"),
            Self::IllegalMove { index, error } => write!(f, "move {index} is illegal: {error}"),
        }
    }
}

impl std::error::Error for ReplayError {}

impl Level {
    /// Checks every structural invariant. `full` also requires the whole queue
    /// to be present and to match the seats exactly (server-side levels).
    pub fn validate(&self, full: bool) -> Result<(), LevelError> {
        if !(3..=MAX_SIDE).contains(&self.width) || !(3..=MAX_SIDE).contains(&self.height) {
            return Err(LevelError::Size);
        }
        if self.vehicles.len() > MAX_VEHICLES {
            return Err(LevelError::TooManyVehicles(self.vehicles.len()));
        }
        if !(1..=MAX_BAYS).contains(&self.bays) {
            return Err(LevelError::Bays(self.bays));
        }
        let mut grid = vec![EMPTY; usize::from(self.width) * usize::from(self.height)];
        for &(x, y) in &self.barriers {
            let idx = index(self.width, self.height, i16::from(x), i16::from(y))
                .ok_or(LevelError::Barrier)?;
            if grid[idx] != EMPTY {
                return Err(LevelError::Barrier);
            }
            grid[idx] = BARRIER;
        }
        let mut seats = [0usize; MAX_COLORS as usize];
        for (i, v) in self.vehicles.iter().enumerate() {
            if v.color >= MAX_COLORS {
                return Err(LevelError::Color(v.color));
            }
            seats[usize::from(v.color)] += usize::from(v.kind.riders());
            for (cx, cy) in v.cells() {
                let idx = index(self.width, self.height, cx, cy).ok_or(LevelError::OffGrid(i))?;
                if grid[idx] != EMPTY {
                    return Err(LevelError::Overlap(i));
                }
                grid[idx] = 0;
            }
        }
        let total: usize = seats.iter().sum();
        if usize::from(self.queue_len) != total || total > MAX_QUEUE {
            return Err(LevelError::Queue(format!(
                "length {} does not match {total} seats",
                self.queue_len
            )));
        }
        if self.queue.len() > total {
            return Err(LevelError::Queue("longer than queue_len".to_owned()));
        }
        let mut riders = [0usize; MAX_COLORS as usize];
        for &c in &self.queue {
            let slot = riders.get_mut(usize::from(c)).ok_or(LevelError::Color(c))?;
            *slot += 1;
        }
        if riders.iter().zip(seats).any(|(r, s)| *r > s) {
            return Err(LevelError::Queue(
                "more commuters of a colour than seats".to_owned(),
            ));
        }
        if full && self.queue.len() != total {
            return Err(LevelError::Queue("incomplete".to_owned()));
        }
        Ok(())
    }

    /// The copy a client may see: the queue cut to what is visible at the start.
    #[must_use]
    pub fn public(&self) -> Self {
        let mut out = self.clone();
        out.queue.truncate(usize::from(self.visible));
        out
    }
}

fn index(w: u8, h: u8, x: i16, y: i16) -> Option<usize> {
    let x = usize::try_from(x).ok()?;
    let y = usize::try_from(y).ok()?;
    (x < usize::from(w) && y < usize::from(h)).then(|| y * usize::from(w) + x)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Bay {
    pub vehicle: u8,
    pub riders: u8,
}

/// What a move did, in order, for the renderer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Event {
    Park { vehicle: u8, bay: u8 },
    Lift { vehicle: u8, bay: u8 },
    Board { bay: u8, vehicle: u8 },
    Depart { bay: u8, vehicle: u8 },
    BayAdded { bay: u8 },
    Shuffled,
}

#[derive(Clone, Debug)]
pub struct Game {
    level: Level,
    grid: Vec<u8>,
    on_grid: Vec<bool>,
    bays: Vec<Option<Bay>>,
    extra_bays: u8,
    queue: Vec<u8>,
    head: usize,
    departed: usize,
    events: Vec<Event>,
}

impl Game {
    pub fn new(level: &Level) -> Result<Self, LevelError> {
        level.validate(false)?;
        let (w, h) = (level.width, level.height);
        let mut grid = vec![EMPTY; usize::from(w) * usize::from(h)];
        for &(x, y) in &level.barriers {
            grid[usize::from(y) * usize::from(w) + usize::from(x)] = BARRIER;
        }
        for (i, v) in level.vehicles.iter().enumerate() {
            let id = u8::try_from(i).expect("MAX_VEHICLES fits u8");
            for (cx, cy) in v.cells() {
                grid[index(w, h, cx, cy).expect("validated")] = id;
            }
        }
        Ok(Self {
            grid,
            on_grid: vec![true; level.vehicles.len()],
            bays: vec![None; usize::from(level.bays)],
            extra_bays: 0,
            queue: level.queue.clone(),
            head: 0,
            departed: 0,
            events: Vec::new(),
            level: level.clone(),
        })
    }

    #[must_use]
    pub fn level(&self) -> &Level {
        &self.level
    }

    #[must_use]
    pub fn bays(&self) -> &[Option<Bay>] {
        &self.bays
    }

    /// Commuters still waiting that this game knows about, front first.
    #[must_use]
    pub fn waiting(&self) -> &[u8] {
        &self.queue[self.head..]
    }

    /// Commuters who have boarded so far.
    #[must_use]
    pub fn boarded(&self) -> usize {
        self.head
    }

    /// Commuters this game knows about, boarded or not, in their current order.
    #[must_use]
    pub fn queue(&self) -> &[u8] {
        &self.queue
    }

    #[must_use]
    pub fn on_grid(&self, vehicle: u8) -> bool {
        self.on_grid
            .get(usize::from(vehicle))
            .copied()
            .unwrap_or(false)
    }

    #[must_use]
    pub fn departed(&self) -> usize {
        self.departed
    }

    #[must_use]
    pub fn is_won(&self) -> bool {
        self.head == usize::from(self.level.queue_len)
    }

    /// True when the client needs more of the queue to keep boarding.
    #[must_use]
    pub fn needs_queue(&self) -> bool {
        self.head == self.queue.len() && !self.is_won()
    }

    fn free_bay(&self) -> Option<usize> {
        self.bays.iter().position(Option::is_none)
    }

    /// Why `vehicle` can't drive out right now: `None` if it can.
    #[must_use]
    pub fn blocker(&self, vehicle: u8) -> Option<MoveError> {
        let Some(v) = self.level.vehicles.get(usize::from(vehicle)) else {
            return Some(MoveError::NoSuchVehicle);
        };
        if !self.on_grid(vehicle) {
            return Some(MoveError::AlreadyLeft);
        }
        let (dx, dy) = v.dir.delta();
        let (mut x, mut y) = (i16::from(v.x) + dx, i16::from(v.y) + dy);
        while let Some(idx) = index(self.level.width, self.level.height, x, y) {
            match self.grid[idx] {
                EMPTY => {}
                BARRIER => return Some(MoveError::Blocked { by: None }),
                other => return Some(MoveError::Blocked { by: Some(other) }),
            }
            x += dx;
            y += dy;
        }
        None
    }

    #[must_use]
    pub fn can_leave(&self, vehicle: u8) -> bool {
        self.blocker(vehicle).is_none()
    }

    /// Vehicles a tap would park right now, in index order.
    #[must_use]
    pub fn tappable(&self) -> Vec<u8> {
        if self.free_bay().is_none() {
            return Vec::new();
        }
        (0..self.level.vehicles.len())
            .map(|i| u8::try_from(i).expect("fits"))
            .filter(|&v| self.can_leave(v))
            .collect()
    }

    /// Not won, and no tap is possible: the player must undo or use an assist.
    #[must_use]
    pub fn is_stuck(&self) -> bool {
        !self.is_won() && !self.needs_queue() && self.tappable().is_empty()
    }

    pub fn take_events(&mut self) -> Vec<Event> {
        std::mem::take(&mut self.events)
    }

    /// Adds commuters the server revealed. They must continue the known queue.
    pub fn extend_queue(&mut self, more: &[u8]) {
        let room = usize::from(self.level.queue_len) - self.queue.len();
        self.queue.extend_from_slice(&more[..more.len().min(room)]);
        self.board();
    }

    fn remove_from_grid(&mut self, vehicle: u8) {
        for cell in &mut self.grid {
            if *cell == vehicle {
                *cell = EMPTY;
            }
        }
        self.on_grid[usize::from(vehicle)] = false;
    }

    fn park(&mut self, vehicle: u8, lifted: bool) -> Result<(), MoveError> {
        let bay = self.free_bay().ok_or(MoveError::BaysFull)?;
        self.remove_from_grid(vehicle);
        self.bays[bay] = Some(Bay { vehicle, riders: 0 });
        let bay = u8::try_from(bay).expect("MAX_BAYS fits u8");
        self.events.push(if lifted {
            Event::Lift { vehicle, bay }
        } else {
            Event::Park { vehicle, bay }
        });
        self.board();
        Ok(())
    }

    fn seats_left(&self, bay: &Bay) -> bool {
        bay.riders < self.level.vehicles[usize::from(bay.vehicle)].kind.riders()
    }

    fn color_of(&self, bay: &Bay) -> u8 {
        self.level.vehicles[usize::from(bay.vehicle)].color
    }

    /// Boards front commuters until the front one has no matching seat.
    fn board(&mut self) {
        while let Some(&color) = self.queue.get(self.head) {
            let Some(i) = self
                .bays
                .iter()
                .position(|b| b.is_some_and(|b| self.color_of(&b) == color && self.seats_left(&b)))
            else {
                return;
            };
            let mut bay = self.bays[i].expect("found above");
            bay.riders += 1;
            self.head += 1;
            let at = u8::try_from(i).expect("fits");
            self.events.push(Event::Board {
                bay: at,
                vehicle: bay.vehicle,
            });
            if self.seats_left(&bay) {
                self.bays[i] = Some(bay);
            } else {
                self.bays[i] = None;
                self.departed += 1;
                self.events.push(Event::Depart {
                    bay: at,
                    vehicle: bay.vehicle,
                });
            }
        }
    }

    fn check_vehicle(&self, vehicle: u8) -> Result<(), MoveError> {
        if usize::from(vehicle) >= self.level.vehicles.len() {
            return Err(MoveError::NoSuchVehicle);
        }
        if !self.on_grid(vehicle) {
            return Err(MoveError::AlreadyLeft);
        }
        Ok(())
    }

    pub fn tap(&mut self, vehicle: u8) -> Result<(), MoveError> {
        self.check_vehicle(vehicle)?;
        if let Some(e) = self.blocker(vehicle) {
            return Err(e);
        }
        if self.free_bay().is_none() {
            return Err(MoveError::BaysFull);
        }
        self.park(vehicle, false)
    }

    pub fn airlift(&mut self, vehicle: u8) -> Result<(), MoveError> {
        self.check_vehicle(vehicle)?;
        self.park(vehicle, true)
    }

    pub fn add_bay(&mut self) -> Result<(), MoveError> {
        if self.extra_bays >= MAX_EXTRA_BAYS || self.bays.len() >= usize::from(MAX_BAYS) {
            return Err(MoveError::TooManyBays);
        }
        self.extra_bays += 1;
        self.bays.push(None);
        let bay = u8::try_from(self.bays.len() - 1).expect("fits");
        self.events.push(Event::BayAdded { bay });
        Ok(())
    }

    /// Commuters a shuffle may reorder: the visible ones, at most [`SHUFFLE_WINDOW`].
    fn shuffle_window(&self) -> usize {
        let window = usize::from(self.level.visible.min(SHUFFLE_WINDOW));
        (self.head + window).min(self.queue.len())
    }

    /// Stable partition of the window: commuters with a parked seat of their colour first.
    pub fn shuffle(&mut self) -> Result<(), MoveError> {
        let end = self.shuffle_window();
        let wanted: Vec<u8> = self
            .bays
            .iter()
            .flatten()
            .filter(|b| self.seats_left(b))
            .map(|b| self.color_of(b))
            .collect();
        let window = &self.queue[self.head..end];
        let (mut front, back): (Vec<u8>, Vec<u8>) = window.iter().partition(|c| wanted.contains(c));
        if front.is_empty() || window.starts_with(&front) {
            return Err(MoveError::NothingToShuffle);
        }
        front.extend(back);
        self.queue[self.head..end].copy_from_slice(&front);
        self.events.push(Event::Shuffled);
        self.board();
        Ok(())
    }

    pub fn apply(&mut self, (op, vehicle): Move) -> Result<(), MoveError> {
        match op {
            0 => self.tap(vehicle),
            1 => self.airlift(vehicle),
            2 => self.shuffle(),
            3 => self.add_bay(),
            other => Err(MoveError::UnknownOp(other)),
        }
    }
}

/// Assists used by a move list, as `(airlifts, shuffles, extra bays)`.
#[must_use]
pub fn assists_used(moves: &[Move]) -> [u16; 3] {
    let mut out = [0u16; 3];
    for &(op, _) in moves {
        if (1..=3).contains(&op) {
            out[usize::from(op) - 1] += 1;
        }
    }
    out
}

/// Replays `moves` from the start of `level`, rejecting any illegal move.
pub fn replay(level: &Level, moves: &[Move]) -> Result<Game, ReplayError> {
    if moves.len() > MAX_MOVES {
        return Err(ReplayError::TooManyMoves(moves.len()));
    }
    let mut game = Game::new(level).map_err(ReplayError::InvalidLevel)?;
    for (index, &m) in moves.iter().enumerate() {
        game.apply(m)
            .map_err(|error| ReplayError::IllegalMove { index, error })?;
        game.events.clear();
    }
    Ok(game)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(kind: Kind, color: u8, x: u8, y: u8, dir: Dir) -> Vehicle {
        Vehicle {
            kind,
            color,
            x,
            y,
            dir,
        }
    }

    /// Two hatchbacks in a column facing north: the lower one is blocked by the upper.
    fn small() -> Level {
        let vehicles = vec![
            v(Kind::Hatchback, 0, 1, 0, Dir::N),
            v(Kind::Hatchback, 1, 1, 1, Dir::N),
            v(Kind::Sedan, 0, 3, 3, Dir::E),
        ];
        let queue = vec![1, 0, 1, 0, 0, 0, 0, 0];
        Level {
            width: 4,
            height: 4,
            barriers: vec![],
            queue_len: 8,
            queue,
            vehicles,
            bays: 2,
            visible: 100,
        }
    }

    #[test]
    fn seats_follow_real_vehicles() {
        let riders: Vec<u8> = Kind::ALL.iter().map(|k| k.riders()).collect();
        assert_eq!(riders, [1, 2, 4, 6, 9, 12, 49]);
        let lengths: Vec<u8> = Kind::ALL.iter().map(|k| k.length()).collect();
        assert_eq!(lengths, [1, 1, 2, 2, 3, 3, 4]);
    }

    #[test]
    fn blocked_vehicle_cannot_leave() {
        let game = Game::new(&small()).unwrap();
        assert_eq!(game.blocker(1), Some(MoveError::Blocked { by: Some(0) }));
        assert!(game.can_leave(0));
        assert!(game.can_leave(2));
    }

    #[test]
    fn boarding_and_departure() {
        let level = small();
        let mut game = Game::new(&level).unwrap();
        game.tap(0).unwrap(); // colour 0, front commuter is colour 1: nobody boards
        assert_eq!(game.boarded(), 0);
        game.tap(1).unwrap(); // colour 1 boards, then colour 0, then colour 1 fills it
        assert_eq!(game.boarded(), 4);
        assert_eq!(game.departed(), 2);
        game.tap(2).unwrap();
        assert!(game.is_won());
    }

    #[test]
    fn stuck_when_bays_hold_the_wrong_colours() {
        let mut level = small();
        level.bays = 1;
        let mut game = Game::new(&level).unwrap();
        game.tap(2).unwrap(); // colour 0 sedan, but colour 1 is in front
        assert!(game.is_stuck());
        assert_eq!(game.tap(0), Err(MoveError::BaysFull));
    }

    #[test]
    fn assists_change_the_board() {
        let mut level = small();
        level.bays = 1;
        let mut game = Game::new(&level).unwrap();
        game.tap(2).unwrap();
        game.add_bay().unwrap();
        game.airlift(1).unwrap();
        assert!(game.boarded() > 0);
        let mut g = Game::new(&small()).unwrap();
        g.tap(2).unwrap();
        g.shuffle().unwrap();
        assert_eq!(g.boarded(), 4);
    }

    #[test]
    fn partial_queue_stops_and_resumes() {
        let level = small();
        let mut public = level.clone();
        public.queue.truncate(2);
        let mut game = Game::new(&public).unwrap();
        game.tap(0).unwrap();
        game.tap(1).unwrap();
        assert!(game.needs_queue());
        game.extend_queue(&level.queue[2..]);
        let full = replay(&level, &[(0, 0), (0, 1)]).unwrap();
        assert_eq!(game.boarded(), full.boarded());
        assert_eq!(game.bays(), full.bays());
    }

    #[test]
    fn validate_rejects_bad_levels() {
        let mut level = small();
        level.vehicles[1].y = 0;
        assert_eq!(level.validate(true), Err(LevelError::Overlap(1)));
        let mut level = small();
        level.queue_len = 9;
        assert!(level.validate(false).is_err());
        let mut level = small();
        level.queue.pop();
        assert!(level.validate(true).is_err());
        assert!(level.validate(false).is_ok());
    }

    #[test]
    fn replay_reports_first_illegal_move() {
        let err = replay(&small(), &[(0, 1)]).unwrap_err();
        assert!(matches!(err, ReplayError::IllegalMove { index: 0, .. }));
        let err = replay(&small(), &[(0, 0), (0, 0)]).unwrap_err();
        assert_eq!(
            err,
            ReplayError::IllegalMove {
                index: 1,
                error: MoveError::AlreadyLeft
            }
        );
    }
}
