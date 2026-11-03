//! Browser bindings. The client uses these to animate and pre-check moves;
//! the server re-runs every move with the same engine and has the final say.
//!
//! Hot paths return flat `Int32Array`s instead of JSON to avoid per-frame allocation churn.

use arc_engine::brick_blast::{self as bb, Cell, Event};
use arc_engine::dead_bridge as db;
use arc_engine::metro_jam as mj;
use arc_engine::water_sort as ws;
use sha2::{Digest, Sha256};
use wasm_bindgen::prelude::*;

fn js_err(e: impl std::fmt::Display) -> JsError {
    JsError::new(&e.to_string())
}

// ---------------------------------------------------------------- Water Sort

#[wasm_bindgen]
pub struct WaterSort {
    board: ws::Board,
}

#[wasm_bindgen]
impl WaterSort {
    /// `{"capacity": n, "bottles": [...]}`. The board may be masked: hidden layers are 255.
    #[wasm_bindgen(constructor)]
    pub fn new(board_json: &str) -> Result<WaterSort, JsError> {
        let board: ws::Board = serde_json::from_str(board_json).map_err(js_err)?;
        board.validate_masked().map_err(js_err)?;
        Ok(Self { board })
    }

    /// The paid assist: one more empty bottle.
    #[wasm_bindgen(js_name = addBottle)]
    pub fn add_bottle(&mut self) -> Result<(), JsError> {
        self.board.add_bottle().map_err(js_err)
    }

    /// Units a pour would move, or -1 if illegal.
    #[wasm_bindgen(js_name = canPour)]
    #[must_use]
    pub fn can_pour(&self, from: u8, to: u8) -> i32 {
        self.board
            .can_pour(from, to)
            .map_or(-1, |n| i32::try_from(n).unwrap_or(-1))
    }

    pub fn pour(&mut self, from: u8, to: u8) -> Result<u32, JsError> {
        let n = self.board.pour(from, to).map_err(js_err)?;
        Ok(u32::try_from(n).unwrap_or(0))
    }

    #[wasm_bindgen(js_name = isSolved)]
    #[must_use]
    pub fn is_solved(&self) -> bool {
        self.board.is_solved()
    }

    /// False when no legal pour exists at all (the player must undo or restart).
    #[wasm_bindgen(js_name = hasMoves)]
    #[must_use]
    pub fn has_moves(&self) -> bool {
        let n = u8::try_from(self.board.bottles.len()).unwrap_or(0);
        (0..n).any(|f| (0..n).any(|t| self.board.can_pour(f, t).is_ok()))
    }

    #[wasm_bindgen(js_name = toJson)]
    #[must_use]
    pub fn to_json(&self) -> String {
        serde_json::to_string(&self.board).unwrap_or_default()
    }
}

// --------------------------------------------------------------- Brick Blast

fn encode_cell(cell: &Cell, out: &mut Vec<i32>) {
    match *cell {
        Cell::Empty => out.extend([0, 0, 0]),
        Cell::Block { shape, hp } => out.extend([1, shape as i32, i32::from(hp)]),
        Cell::Power { kind } => out.extend([2, kind as i32, 0]),
    }
}

fn encode_grid(grid: &[bb::Row]) -> Vec<i32> {
    let mut out = Vec::with_capacity(bb::ROWS * bb::COLS * 3);
    for cell in grid.iter().flatten() {
        encode_cell(cell, &mut out);
    }
    out
}

fn parse_state(json: &str) -> Result<bb::State, JsError> {
    let state: bb::State = serde_json::from_str(json).map_err(js_err)?;
    state.validate().map_err(js_err)?;
    Ok(state)
}

/// A turn being animated in the browser.
#[wasm_bindgen]
pub struct BrickTurn {
    turn: bb::Turn,
}

#[wasm_bindgen]
impl BrickTurn {
    #[wasm_bindgen(constructor)]
    pub fn new(state_json: &str, aim: u16) -> Result<BrickTurn, JsError> {
        let state = parse_state(state_json)?;
        let turn = bb::Turn::new(&state, aim).map_err(js_err)?;
        Ok(Self { turn })
    }

    /// Advances one tick; returns true when the turn is over.
    pub fn step(&mut self) -> bool {
        self.turn.step()
    }

    #[must_use]
    pub fn tick(&self) -> u32 {
        self.turn.tick()
    }

    #[wasm_bindgen(js_name = isDone)]
    #[must_use]
    pub fn is_done(&self) -> bool {
        self.turn.is_done()
    }

    /// Balls not yet launched.
    #[must_use]
    pub fn waiting(&self) -> u16 {
        self.turn.waiting()
    }

    /// Flat `[id, x, y, isClone]` per live ball.
    #[must_use]
    pub fn balls(&self) -> Vec<i32> {
        let balls = self.turn.balls();
        let mut out = Vec::with_capacity(balls.len() * 4);
        for b in balls {
            out.extend([
                i32::try_from(b.id).unwrap_or(i32::MAX),
                b.x,
                b.y,
                i32::from(b.is_clone()),
            ]);
        }
        out
    }

    /// Flat `[tag, kind, hp]` per cell, row-major. tag: 0 empty, 1 block, 2 power-up.
    #[must_use]
    pub fn cells(&self) -> Vec<i32> {
        encode_grid(self.turn.grid())
    }

    /// Flat `[kind, a, b]` per event since the last call.
    /// kind: 0 hit(cell, hp) 1 blast(cell) 2 laser(cell, power) 3 split(cell)
    /// 4 collect(cell, amount) 5 land(x) 6 boost(cell, factor)
    #[wasm_bindgen(js_name = takeEvents)]
    pub fn take_events(&mut self) -> Vec<i32> {
        let mut out = Vec::new();
        for e in self.turn.take_events() {
            out.extend(match e {
                Event::Hit { cell, hp } => [0, i32::from(cell), i32::from(hp)],
                Event::Blast { cell } => [1, i32::from(cell), 0],
                Event::Laser { cell, kind } => [2, i32::from(cell), kind as i32],
                Event::Split { cell } => [3, i32::from(cell), 0],
                Event::Collect { cell, amount } => [4, i32::from(cell), i32::from(amount)],
                Event::Land { x } => [5, x, 0],
                Event::Boost { cell, factor } => [6, i32::from(cell), i32::from(factor)],
            });
        }
        out
    }

    /// Adds the row the server says entered this turn (JSON array of 9 cells).
    #[wasm_bindgen(js_name = provideRow)]
    pub fn provide_row(&mut self, row_json: &str) -> Result<(), JsError> {
        let row: bb::Row = serde_json::from_str(row_json).map_err(js_err)?;
        self.turn.provide_row(row);
        Ok(())
    }

    /// Finishes the turn and returns `{"state": State, "hash": string}` as JSON.
    pub fn finish(self) -> Result<String, JsError> {
        let (state, _) = self.turn.finish().map_err(js_err)?;
        let hash = state.hash_hex();
        serde_json::to_string(&serde_json::json!({ "state": state, "hash": hash })).map_err(js_err)
    }
}

/// Flat `[x0, y0, x1, y1, ...]`: launch point then bounce points for the aim guide.
#[wasm_bindgen(js_name = bbAimPath)]
pub fn bb_aim_path(state_json: &str, aim: u16, bounces: usize) -> Result<Vec<i32>, JsError> {
    let state = parse_state(state_json)?;
    Ok(bb::aim_path(&state, aim, bounces)
        .into_iter()
        .flat_map(|(x, y)| [x, y])
        .collect())
}

/// `[row, col]` of the block a shot at `aim` hits first, or empty if it hits none.
#[wasm_bindgen(js_name = bbAimHit)]
pub fn bb_aim_hit(state_json: &str, aim: u16) -> Result<Vec<i32>, JsError> {
    let state = parse_state(state_json)?;
    Ok(bb::aim_trace(&state, aim, 0)
        .1
        .map_or_else(Vec::new, |(r, c)| {
            vec![i32::try_from(r).unwrap_or(0), i32::try_from(c).unwrap_or(0)]
        }))
}

/// Flat `[tag, kind, hp]` per cell for a state (used when no turn is running).
#[wasm_bindgen(js_name = bbCells)]
pub fn bb_cells(state_json: &str) -> Result<Vec<i32>, JsError> {
    Ok(encode_grid(&parse_state(state_json)?.grid))
}

#[wasm_bindgen(js_name = bbStateHash)]
pub fn bb_state_hash(state_json: &str) -> Result<String, JsError> {
    Ok(parse_state(state_json)?.hash_hex())
}

/// Board geometry and timing constants, so the renderer never hard-codes them.
#[wasm_bindgen(js_name = bbConstants)]
#[must_use]
pub fn bb_constants() -> String {
    serde_json::json!({
        "cols": bb::COLS,
        "rows": bb::ROWS,
        "playRows": bb::PLAY_ROWS,
        "cell": bb::CELL,
        "boardW": bb::BOARD_W,
        "floorY": bb::FLOOR_Y,
        "ballR": bb::BALL_R,
        "blockInset": bb::BLOCK_INSET,
        "powerR": bb::POWER_R,
        "ticksPerSecond": bb::TICKS_PER_SECOND,
        "aimMin": bb::AIM_MIN,
        "aimMax": bb::AIM_MAX,
        "maxHp": bb::MAX_HP,
    })
    .to_string()
}

// ----------------------------------------------------------------- MetroJam

/// A MetroJam game in the browser. Undo rebuilds it from the move list.
#[wasm_bindgen]
pub struct MetroJam {
    game: mj::Game,
}

#[wasm_bindgen]
impl MetroJam {
    #[wasm_bindgen(constructor)]
    pub fn new(level_json: &str) -> Result<MetroJam, JsError> {
        let level: mj::Level = serde_json::from_str(level_json).map_err(js_err)?;
        Ok(Self {
            game: mj::Game::new(&level).map_err(js_err)?,
        })
    }

    /// Applies `(op, vehicle)`: 0 tap, 1 airlift, 2 shuffle, 3 extra bay.
    pub fn apply(&mut self, op: u8, vehicle: u8) -> Result<(), JsError> {
        self.game.apply((op, vehicle)).map_err(js_err)
    }

    /// -1 if the vehicle can drive out; otherwise the blocking vehicle,
    /// -2 for a barrier, -3 if it already left or does not exist.
    #[must_use]
    pub fn blocker(&self, vehicle: u8) -> i32 {
        match self.game.blocker(vehicle) {
            None => -1,
            Some(mj::MoveError::Blocked { by: Some(v) }) => i32::from(v),
            Some(mj::MoveError::Blocked { by: None }) => -2,
            Some(_) => -3,
        }
    }

    #[must_use]
    pub fn tappable(&self) -> Vec<u8> {
        self.game.tappable()
    }

    #[wasm_bindgen(js_name = onGrid)]
    #[must_use]
    pub fn on_grid(&self, vehicle: u8) -> bool {
        self.game.on_grid(vehicle)
    }

    /// Flat `[vehicle, riders]` per bay; `[-1, 0]` for an empty bay.
    #[must_use]
    pub fn bays(&self) -> Vec<i32> {
        self.game
            .bays()
            .iter()
            .flat_map(|b| b.map_or([-1, 0], |b| [i32::from(b.vehicle), i32::from(b.riders)]))
            .collect()
    }

    /// Known commuters still waiting, front first.
    #[must_use]
    pub fn waiting(&self) -> Vec<u8> {
        self.game.waiting().to_vec()
    }

    #[must_use]
    pub fn boarded(&self) -> usize {
        self.game.boarded()
    }

    /// Commuters known so far, boarded or not (the queue the server revealed).
    #[must_use]
    pub fn known(&self) -> usize {
        self.game.queue().len()
    }

    /// Adds commuters the server revealed; boarding continues at once.
    #[wasm_bindgen(js_name = extendQueue)]
    pub fn extend_queue(&mut self, more: &[u8]) {
        self.game.extend_queue(more);
    }

    #[wasm_bindgen(js_name = isWon)]
    #[must_use]
    pub fn is_won(&self) -> bool {
        self.game.is_won()
    }

    #[wasm_bindgen(js_name = isStuck)]
    #[must_use]
    pub fn is_stuck(&self) -> bool {
        self.game.is_stuck()
    }

    #[wasm_bindgen(js_name = needsQueue)]
    #[must_use]
    pub fn needs_queue(&self) -> bool {
        self.game.needs_queue()
    }

    /// Flat `[kind, a, b]` per event since the last call.
    /// kind: 0 park(vehicle, bay) 1 lift(vehicle, bay) 2 board(bay, vehicle)
    /// 3 depart(bay, vehicle) 4 bay added(bay) 5 shuffled
    #[wasm_bindgen(js_name = takeEvents)]
    pub fn take_events(&mut self) -> Vec<i32> {
        let mut out = Vec::new();
        for e in self.game.take_events() {
            out.extend(match e {
                mj::Event::Park { vehicle, bay } => [0, i32::from(vehicle), i32::from(bay)],
                mj::Event::Lift { vehicle, bay } => [1, i32::from(vehicle), i32::from(bay)],
                mj::Event::Board { bay, vehicle } => [2, i32::from(bay), i32::from(vehicle)],
                mj::Event::Depart { bay, vehicle } => [3, i32::from(bay), i32::from(vehicle)],
                mj::Event::BayAdded { bay } => [4, i32::from(bay), 0],
                mj::Event::Shuffled => [5, 0, 0],
            });
        }
        out
    }
}

/// Seats, riders and footprint per vehicle kind, so the renderer never hard-codes them.
#[wasm_bindgen(js_name = mjConstants)]
#[must_use]
pub fn mj_constants() -> String {
    let kinds: Vec<_> = mj::Kind::ALL
        .iter()
        .map(|k| {
            serde_json::json!({
                "kind": k,
                "seats": k.seats(),
                "riders": k.riders(),
                "length": k.length(),
            })
        })
        .collect();
    serde_json::json!({
        "kinds": kinds,
        "maxMoves": mj::MAX_MOVES,
        "maxExtraBays": mj::MAX_EXTRA_BAYS,
        "shuffleWindow": mj::SHUFFLE_WINDOW,
    })
    .to_string()
}

// ------------------------------------------------------- Dead Bridge Assault

fn reward_code(r: db::Reward) -> i32 {
    match r {
        db::Reward::TurretLeft => 0,
        db::Reward::TurretRight => 1,
        db::Reward::Tank => 2,
        db::Reward::Mech => 3,
        db::Reward::Repair => 4,
        db::Reward::Barricade => 5,
        db::Reward::Assist(k) => 10 + i32::from(k.code()),
        db::Reward::Gun(g) => 20 + g as i32,
    }
}

/// A level being played in the browser. The browser steps it at 30 Hz and records the
/// inputs; the server replays the same inputs to verify the result.
#[wasm_bindgen]
pub struct DeadBridge {
    sim: db::Sim,
}

#[wasm_bindgen]
impl DeadBridge {
    #[wasm_bindgen(constructor)]
    pub fn new(script_json: &str) -> Result<DeadBridge, JsError> {
        let script: db::Script = serde_json::from_str(script_json).map_err(js_err)?;
        Ok(Self {
            sim: db::Sim::new(&script).map_err(js_err)?,
        })
    }

    pub fn step(&mut self) {
        self.sim.step();
    }

    #[wasm_bindgen(js_name = setAim)]
    pub fn set_aim(&mut self, lane: u8) {
        self.sim.set_aim(lane);
    }

    /// Sends the unit in the ready slot into action. False if nothing is ready.
    pub fn deploy(&mut self) -> bool {
        self.sim.deploy().is_ok()
    }

    /// Fires an assist (kind 0-6). False if there is no charge.
    #[wasm_bindgen(js_name = useAssist)]
    pub fn use_assist(&mut self, kind: u8) -> bool {
        db::AssistKind::from_code(kind).is_some_and(|k| self.sim.use_assist(k).is_ok())
    }

    /// Adds a charge bought with coins (the server checks the payment on replay).
    #[wasm_bindgen(js_name = buyAssist)]
    pub fn buy_assist(&mut self, kind: u8) -> bool {
        db::AssistKind::from_code(kind).is_some_and(|k| self.sim.buy_assist(k).is_ok())
    }

    #[must_use]
    pub fn tick(&self) -> u32 {
        self.sim.tick()
    }

    /// 0 playing, 1 won, 2 lost.
    #[must_use]
    pub fn status(&self) -> u8 {
        self.sim.status() as u8
    }

    #[must_use]
    pub fn stars(&self) -> u8 {
        self.sim.stars()
    }

    /// Flat `[id, kind, x, y, hp, maxHp]` per zombie; kind 0 walker 1 runner 2 brute 3 boss.
    #[must_use]
    pub fn zombies(&self) -> Vec<i32> {
        let mut out = Vec::with_capacity(self.sim.zombies().len() * 6);
        for z in self.sim.zombies() {
            out.extend([
                i32::try_from(z.id).unwrap_or(i32::MAX),
                z.kind as i32,
                z.x,
                z.y,
                z.hp,
                z.max_hp,
            ]);
        }
        out
    }

    /// Flat `[x, y, kind]` per bullet; kind 0 rifle, 1 turret, 2 tank shell, 3 pellet,
    /// 4 minigun, 5 flame, 6 rocket, 7 mech.
    #[must_use]
    pub fn bullets(&self) -> Vec<i32> {
        self.sim
            .bullets()
            .iter()
            .flat_map(|b| [b.x, b.y, b.kind as i32])
            .collect()
    }

    /// Flat `[index, x, y, hp, maxHp, reward]` per cage. Reward: 0 left turret,
    /// 1 right turret, 2 tank, 3 mech, 4 repair, 5 barricade, 10+k assist k, 20+g gun g.
    #[must_use]
    pub fn cages(&self) -> Vec<i32> {
        self.sim
            .cages()
            .iter()
            .flat_map(|c| {
                [
                    i32::from(c.index),
                    c.x,
                    c.y,
                    c.hp,
                    c.max_hp,
                    reward_code(c.reward),
                ]
            })
            .collect()
    }

    /// Flat `[x, y, hp, kind, ticksLeft]` per power crate.
    #[must_use]
    pub fn crates(&self) -> Vec<i32> {
        let now = self.sim.tick();
        self.sim
            .crates()
            .iter()
            .flat_map(|c| {
                [
                    c.x,
                    c.y,
                    c.hp,
                    i32::from(c.kind.code()),
                    i32::try_from(c.until.saturating_sub(now)).unwrap_or(0),
                ]
            })
            .collect()
    }

    /// `[gunnerX, gun, baseHp, maxHp, wave, waves, spawned, spawns, kills, frozen,
    /// drones, napalm, mechX, then ticks left on: gun, left turret, right turret, tank,
    /// mech, barricade, then the ready slot: reward code (-1 empty) and ticks until it
    /// deploys on its own]`. Gun: 0 rifle 1 shotgun 2 minigun 3 flamethrower 4 rocket 5 laser.
    #[must_use]
    pub fn hud(&self) -> Vec<i32> {
        let (frozen, drones, napalm) = self.sim.effects();
        let (spawned, spawns) = self.sim.progress();
        let n = |v: usize| i32::try_from(v).unwrap_or(i32::MAX);
        let mut out = vec![
            self.sim.gunner_x(),
            self.sim.gun() as i32,
            self.sim.base_hp(),
            i32::from(self.sim.script().base_hp),
            n(self.sim.wave()),
            n(self.sim.script().waves.len()),
            n(spawned),
            n(spawns),
            i32::try_from(self.sim.kills()).unwrap_or(i32::MAX),
            i32::from(frozen),
            i32::from(drones),
            i32::from(napalm),
            self.sim.mech_x(),
        ];
        out.extend(
            self.sim
                .timers()
                .iter()
                .map(|t| i32::try_from(*t).unwrap_or(i32::MAX)),
        );
        let (ready, left) = self.sim.ready().map_or((-1, 0), |(r, left)| {
            (reward_code(r), i32::try_from(left).unwrap_or(i32::MAX))
        });
        out.extend([ready, left]);
        out
    }

    /// Assist charges, one per kind.
    #[must_use]
    pub fn charges(&self) -> Vec<u8> {
        self.sim.charges().to_vec()
    }

    /// Flat `[kind, a, b, c]` per event since the last call.
    /// 0 wave(n) 1 boss 2 hit(x,y,dmg) 3 kill(x,y,zkind) 4 breach(x,_,dmg)
    /// 5 cage opened(x,y,reward) 6 crate opened(x,y,kind) 7 assist(kind) 8 boom(x,y,r)
    /// 9 zap(x,y) 10 blocked(x) 11 crate lost(x,y) 12 beam(x,half)
    /// 13 expired(what: 0 turret, 2 tank, 3 mech, 4 gun, 6 barricade)
    /// 14 unit ready(reward) 15 unit deployed(reward)
    #[wasm_bindgen(js_name = takeEvents)]
    pub fn take_events(&mut self) -> Vec<i32> {
        let mut out = Vec::new();
        for e in self.sim.take_events() {
            out.extend(match e {
                db::Event::Wave { n } => [0, i32::from(n), 0, 0],
                db::Event::Boss => [1, 0, 0, 0],
                db::Event::Hit { x, y, dmg } => [2, x, y, dmg],
                db::Event::Kill { x, y, kind } => [3, x, y, kind as i32],
                db::Event::Breach { x, dmg } => [4, x, 0, dmg],
                db::Event::CageOpened { x, y, reward } => [5, x, y, reward_code(reward)],
                db::Event::CrateOpened { x, y, kind } => [6, x, y, i32::from(kind.code())],
                db::Event::Assist { kind } => [7, i32::from(kind.code()), 0, 0],
                db::Event::Boom { x, y, r } => [8, x, y, r],
                db::Event::Zap { x, y } => [9, x, y, 0],
                db::Event::Blocked { x } => [10, x, 0, 0],
                db::Event::CrateLost { x, y } => [11, x, y, 0],
                db::Event::Beam { x, half } => [12, x, half, 0],
                db::Event::Expired { what } => [13, i32::from(what), 0, 0],
                db::Event::Ready { reward } => [14, reward_code(reward), 0, 0],
                db::Event::Deployed { reward } => [15, reward_code(reward), 0, 0],
            });
        }
        out
    }
}

/// World geometry and timing, so the renderer never hard-codes them.
#[wasm_bindgen(js_name = dbConstants)]
#[must_use]
pub fn db_constants() -> String {
    serde_json::json!({
        "tps": db::TPS,
        "bridgeW": db::BRIDGE_W,
        "lineY": db::LINE_Y,
        "gunnerY": db::GUNNER_Y,
        "lanes": db::LANES,
        "maxCharges": db::MAX_CHARGES,
        "maxLogBytes": db::MAX_LOG_BYTES,
        // Full length of each timer in `hud()`, for the bars.
        "timerTicks": [db::WEAPON_TICKS, db::TURRET_TICKS, db::TURRET_TICKS, db::TANK_TICKS, db::MECH_TICKS, db::BARRICADE_TICKS],
        "crateTicks": db::CRATE_TICKS,
        "readyTicks": db::READY_TICKS,
        "radius": [db::ZKind::Walker.stats().1, db::ZKind::Runner.stats().1, db::ZKind::Brute.stats().1, db::ZKind::Boss.stats().1],
    })
    .to_string()
}

// ------------------------------------------------------------ Proof of work

fn leading_zero_bits(digest: &[u8]) -> u32 {
    let mut bits = 0;
    for byte in digest {
        if *byte == 0 {
            bits += 8;
        } else {
            return bits + byte.leading_zeros();
        }
    }
    bits
}

/// Searches nonces `start..start+count` for `sha256("{challenge}:{nonce}")`
/// with at least `difficulty` leading zero bits. Returns the nonce or -1.
///
/// Called in chunks from a Web Worker so the UI stays responsive.
#[wasm_bindgen(js_name = powSolve)]
#[must_use]
pub fn pow_solve(challenge: &str, difficulty: u32, start: u32, count: u32) -> f64 {
    let prefix = format!("{challenge}:");
    for nonce in start..start.saturating_add(count) {
        let mut hasher = Sha256::new();
        hasher.update(prefix.as_bytes());
        hasher.update(nonce.to_string().as_bytes());
        if leading_zero_bits(&hasher.finalize()) >= difficulty {
            return f64::from(nonce);
        }
    }
    -1.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pow_finds_valid_nonce() {
        let nonce = pow_solve("abc", 8, 0, 100_000);
        assert!(nonce >= 0.0);
        let digest = Sha256::digest(format!("abc:{nonce}").as_bytes());
        assert!(leading_zero_bits(&digest) >= 8);
    }

    #[test]
    fn leading_zeros_counts_bits() {
        assert_eq!(leading_zero_bits(&[0, 0b0001_0000]), 11);
        assert_eq!(leading_zero_bits(&[0xff]), 0);
    }
}
