//! Dead Bridge Assault: hold the line at the foot of a bridge while the horde pours down.
//!
//! Rules (see the Dead Bridge Assault design doc):
//! - The gunner stands below the line and fires up the bridge on its own; the player
//!   only steers (an aim lane, 0..=255) and fires assists.
//! - Zombies walk down the bridge. One that reaches [`LINE_Y`] breaks through: it is
//!   gone, but the base loses health. The level is lost at 0 health.
//! - Gold cages descend the sides. Shooting one open unlocks a turret, the tank, a
//!   better gun, a repair, or an assist. Power crates among the horde give assists.
//! - The level is won when every wave (and the boss) is spawned and dead.
//!
//! Real time, but fully deterministic: a fixed 30 Hz step, integer maths, seeded
//! randomness. The browser records only its inputs ([`InputLog`]); the server replays
//! them with this same code, so health, kills and assists cannot be faked.

pub mod bot;

use std::fmt;

use serde::{Deserialize, Serialize};

use crate::isqrt;
use crate::rng::Rng;

pub const TPS: u32 = 30;
/// World units across the bridge.
pub const BRIDGE_W: i32 = 10_000;
/// Zombies that reach this line break through.
pub const LINE_Y: i32 = 16_000;
pub const GUNNER_Y: i32 = 17_000;
/// Aim resolution: lanes across the bridge.
pub const LANES: i32 = 256;
/// Hard cap on a level's length (the scripts last 60-90 s).
pub const MAX_TICKS: u32 = 4 * 60 * TPS;
pub const MAX_ALIVE: usize = 400;
pub const MAX_SPAWNS: usize = 2_000;
pub const MAX_LOG_BYTES: usize = 24_000;
pub const MAX_CHARGES: u8 = 9;

const GUNNER_STEP: i32 = 420;
const BULLET_R: i32 = 90;
const TURRET_X: [i32; 2] = [1_100, 8_900];
const TURRET_Y: i32 = LINE_Y + 500;
const TANK_X: i32 = 7_400;
const FREEZE_TICKS: u32 = 90;
const DRONE_TICKS: u32 = 150;
const NAPALM_TICKS: u32 = 120;
const NAPALM_TOP: i32 = LINE_Y - 6_500;
const LANCE_HALF: i32 = 650;
const CRATE_SPEED: i32 = 32;
const CAGE_SPEED: i32 = 45;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ZKind {
    Walker,
    Runner,
    Brute,
    Boss,
}

impl ZKind {
    /// `(speed per tick, radius, health lost when it breaks through)`.
    #[must_use]
    pub const fn stats(self) -> (i32, i32, i32) {
        match self {
            Self::Walker => (36, 300, 1),
            Self::Runner => (78, 250, 1),
            Self::Brute => (22, 430, 3),
            Self::Boss => (14, 900, 25),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AssistKind {
    /// Bombs walk across the front of the horde.
    Airstrike,
    /// Everything stops for 3 s and takes double damage.
    Freeze,
    /// Three drones zap the toughest zombies for 5 s.
    Drones,
    /// A beam down the gunner's lane.
    Lance,
    /// A burning carpet across the lower bridge for 4 s.
    Napalm,
}

impl AssistKind {
    pub const ALL: [Self; 5] = [
        Self::Airstrike,
        Self::Freeze,
        Self::Drones,
        Self::Lance,
        Self::Napalm,
    ];

    #[must_use]
    pub const fn code(self) -> u8 {
        self as u8
    }

    #[must_use]
    pub fn from_code(code: u8) -> Option<Self> {
        Self::ALL.get(usize::from(code)).copied()
    }
}

/// What a gold cage holds.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Reward {
    TurretLeft,
    TurretRight,
    Tank,
    /// Rifle → twin guns → minigun → twin miniguns.
    Weapon,
    /// +6 base health.
    Repair,
    Assist(AssistKind),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Spawn {
    pub tick: u32,
    pub kind: ZKind,
    pub x: i32,
    pub hp: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CageSpec {
    pub tick: u32,
    pub x: i32,
    /// Where it stops on its way down.
    pub stop_y: i32,
    pub hp: u32,
    pub reward: Reward,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CrateSpec {
    pub tick: u32,
    pub x: i32,
    pub kind: AssistKind,
    pub hp: u32,
}

/// One level. Public: the client simulates the same script the server replays.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Script {
    pub seed: u64,
    pub base_hp: u16,
    /// Start tick of each wave (the last wave ends with the boss).
    pub waves: Vec<u32>,
    pub spawns: Vec<Spawn>,
    pub cages: Vec<CageSpec>,
    pub crates: Vec<CrateSpec>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ScriptError(pub String);

impl fmt::Display for ScriptError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "invalid script: {}", self.0)
    }
}

impl std::error::Error for ScriptError {}

impl Script {
    pub fn validate(&self) -> Result<(), ScriptError> {
        let bad = |m: &str| Err(ScriptError(m.to_owned()));
        if self.base_hp == 0 || self.base_hp > 500 {
            return bad("base health");
        }
        if self.spawns.is_empty() || self.spawns.len() > MAX_SPAWNS {
            return bad("spawn count");
        }
        if self.cages.len() > 64 || self.crates.len() > 128 || self.waves.len() > 16 {
            return bad("too many objects");
        }
        let in_x = |x: i32| (0..=BRIDGE_W).contains(&x);
        let sorted = |t: &[u32]| t.windows(2).all(|w| w[0] <= w[1]);
        let ticks: Vec<u32> = self.spawns.iter().map(|s| s.tick).collect();
        if !sorted(&ticks)
            || !sorted(&self.cages.iter().map(|c| c.tick).collect::<Vec<_>>())
            || !sorted(&self.crates.iter().map(|c| c.tick).collect::<Vec<_>>())
        {
            return bad("events out of order");
        }
        if self
            .spawns
            .iter()
            .any(|s| !in_x(s.x) || s.hp == 0 || s.hp > 2_000_000 || s.tick > MAX_TICKS)
            || self
                .cages
                .iter()
                .any(|c| !in_x(c.x) || c.hp == 0 || !(0..LINE_Y).contains(&c.stop_y))
            || self.crates.iter().any(|c| !in_x(c.x) || c.hp == 0)
        {
            return bad("object out of range");
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Playing,
    Won,
    Lost,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Zombie {
    pub id: u32,
    pub kind: ZKind,
    pub x: i32,
    pub y: i32,
    pub hp: i32,
    pub max_hp: i32,
    /// A sideways sway so the horde doesn't march in straight lines.
    phase: u8,
}

/// Who fired a bullet (for drawing).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Shooter {
    Gun,
    Turret,
    Tank,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Bullet {
    pub x: i32,
    pub y: i32,
    vx: i32,
    vy: i32,
    dmg: i32,
    splash: i32,
    pub by: Shooter,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Cage {
    pub index: u16,
    pub x: i32,
    pub y: i32,
    pub hp: i32,
    pub max_hp: i32,
    pub reward: Reward,
    stop_y: i32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Crate {
    pub x: i32,
    pub y: i32,
    pub hp: i32,
    pub kind: AssistKind,
}

/// Things that happened, in order, for the renderer and the messages.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Event {
    Wave { n: u8 },
    Boss,
    Hit { x: i32, y: i32, dmg: i32 },
    Kill { x: i32, y: i32, kind: ZKind },
    Breach { x: i32, dmg: i32 },
    CageOpened { x: i32, y: i32, reward: Reward },
    CrateOpened { x: i32, y: i32, kind: AssistKind },
    Assist { kind: AssistKind },
    Boom { x: i32, y: i32, r: i32 },
    Zap { x: i32, y: i32 },
}

#[derive(Clone, Debug)]
pub struct Sim {
    script: Script,
    tick: u32,
    rng: Rng,
    next_spawn: usize,
    next_cage: usize,
    next_crate: usize,
    next_wave: usize,
    boss_seen: bool,
    zombies: Vec<Zombie>,
    bullets: Vec<Bullet>,
    cages: Vec<Cage>,
    crates: Vec<Crate>,
    gunner_x: i32,
    aim_x: i32,
    weapon: u8,
    turrets: [bool; 2],
    tank: bool,
    base_hp: i32,
    charges: [u8; 5],
    bought: [u8; 5],
    freeze_until: u32,
    drones_until: u32,
    napalm_until: u32,
    bombs: Vec<(u32, i32, i32)>,
    gun_cd: u32,
    turret_cd: [u32; 2],
    tank_cd: u32,
    status: Status,
    kills: u32,
    next_id: u32,
    events: Vec<Event>,
}

/// `(ticks between shots, pellets, damage, spread)` per weapon tier.
const WEAPONS: [(u32, i32, i32, i32); 4] =
    [(3, 1, 10, 30), (3, 2, 10, 40), (1, 1, 8, 70), (1, 2, 8, 90)];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InputError {
    NoCharge,
    TooManyCharges,
    NotPlaying,
}

impl fmt::Display for InputError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::NoCharge => "no charge left for that assist",
            Self::TooManyCharges => "too many charges",
            Self::NotPlaying => "the level is over",
        })
    }
}

impl std::error::Error for InputError {}

impl Sim {
    pub fn new(script: &Script) -> Result<Self, ScriptError> {
        script.validate()?;
        Ok(Self {
            rng: Rng::new(script.seed),
            script: script.clone(),
            tick: 0,
            next_spawn: 0,
            next_cage: 0,
            next_crate: 0,
            next_wave: 0,
            boss_seen: false,
            zombies: Vec::new(),
            bullets: Vec::new(),
            cages: Vec::new(),
            crates: Vec::new(),
            gunner_x: BRIDGE_W / 2,
            aim_x: BRIDGE_W / 2,
            weapon: 0,
            turrets: [false; 2],
            tank: false,
            base_hp: i32::from(script.base_hp),
            charges: [0; 5],
            bought: [0; 5],
            freeze_until: 0,
            drones_until: 0,
            napalm_until: 0,
            bombs: Vec::new(),
            gun_cd: 0,
            turret_cd: [0; 2],
            tank_cd: 0,
            status: Status::Playing,
            kills: 0,
            next_id: 0,
            events: Vec::new(),
        })
    }

    // ------------------------------------------------------------- reads

    #[must_use]
    pub fn tick(&self) -> u32 {
        self.tick
    }
    #[must_use]
    pub fn status(&self) -> Status {
        self.status
    }
    #[must_use]
    pub fn script(&self) -> &Script {
        &self.script
    }
    #[must_use]
    pub fn zombies(&self) -> &[Zombie] {
        &self.zombies
    }
    #[must_use]
    pub fn bullets(&self) -> &[Bullet] {
        &self.bullets
    }
    #[must_use]
    pub fn cages(&self) -> &[Cage] {
        &self.cages
    }
    #[must_use]
    pub fn crates(&self) -> &[Crate] {
        &self.crates
    }
    #[must_use]
    pub fn gunner_x(&self) -> i32 {
        self.gunner_x
    }
    #[must_use]
    pub fn weapon(&self) -> u8 {
        self.weapon
    }
    #[must_use]
    pub fn turrets(&self) -> [bool; 2] {
        self.turrets
    }
    #[must_use]
    pub fn tank(&self) -> bool {
        self.tank
    }
    #[must_use]
    pub fn base_hp(&self) -> i32 {
        self.base_hp
    }
    #[must_use]
    pub fn charges(&self) -> [u8; 5] {
        self.charges
    }
    /// Assist charges bought with coins (the server checks these were paid for).
    #[must_use]
    pub fn bought(&self) -> [u8; 5] {
        self.bought
    }
    #[must_use]
    pub fn kills(&self) -> u32 {
        self.kills
    }
    /// `(frozen, drones, napalm)` effects currently running.
    #[must_use]
    pub fn effects(&self) -> (bool, bool, bool) {
        (
            self.tick < self.freeze_until,
            self.tick < self.drones_until,
            self.tick < self.napalm_until,
        )
    }
    /// 1-based wave now playing.
    #[must_use]
    pub fn wave(&self) -> usize {
        self.next_wave.max(1)
    }
    /// Spawns released so far out of all.
    #[must_use]
    pub fn progress(&self) -> (usize, usize) {
        (self.next_spawn, self.script.spawns.len())
    }

    /// Stars from base health left: 3 at 80 %+, 2 at 40 %+, else 1.
    #[must_use]
    pub fn stars(&self) -> u8 {
        if self.status != Status::Won {
            return 0;
        }
        let pct = self.base_hp * 100 / i32::from(self.script.base_hp);
        if pct >= 80 {
            3
        } else if pct >= 40 {
            2
        } else {
            1
        }
    }

    pub fn take_events(&mut self) -> Vec<Event> {
        std::mem::take(&mut self.events)
    }

    // ------------------------------------------------------------- inputs

    /// Steers toward a lane (0 = left edge, 255 = right edge).
    pub fn set_aim(&mut self, lane: u8) {
        let margin = 400;
        self.aim_x = margin + i32::from(lane) * (BRIDGE_W - 2 * margin) / (LANES - 1);
    }

    /// A charge bought with coins (recorded, and checked against payments by the server).
    pub fn buy_assist(&mut self, kind: AssistKind) -> Result<(), InputError> {
        let k = usize::from(kind.code());
        if self.charges[k] >= MAX_CHARGES {
            return Err(InputError::TooManyCharges);
        }
        self.charges[k] += 1;
        self.bought[k] += 1;
        Ok(())
    }

    pub fn use_assist(&mut self, kind: AssistKind) -> Result<(), InputError> {
        if self.status != Status::Playing {
            return Err(InputError::NotPlaying);
        }
        let k = usize::from(kind.code());
        if self.charges[k] == 0 {
            return Err(InputError::NoCharge);
        }
        self.charges[k] -= 1;
        self.events.push(Event::Assist { kind });
        match kind {
            AssistKind::Airstrike => {
                // Bombs walk across the front of the horde, the nearest zombies first.
                let mut front: Vec<(i32, i32)> = self.zombies.iter().map(|z| (z.y, z.x)).collect();
                front.sort_unstable_by(|a, b| b.cmp(a));
                if front.is_empty() {
                    front.push((LINE_Y / 2, BRIDGE_W / 2));
                }
                for (i, &(y, x)) in front.iter().take(6).enumerate() {
                    let at = self.tick + 4 + 5 * u32::try_from(i).unwrap_or(0);
                    self.bombs.push((at, x, y + 400));
                }
            }
            AssistKind::Freeze => self.freeze_until = self.tick + FREEZE_TICKS,
            AssistKind::Drones => self.drones_until = self.tick + DRONE_TICKS,
            AssistKind::Napalm => self.napalm_until = self.tick + NAPALM_TICKS,
            AssistKind::Lance => {
                let x = self.gunner_x;
                for i in 0..self.zombies.len() {
                    if (self.zombies[i].x - x).abs() <= LANCE_HALF + self.zombies[i].kind.stats().1
                    {
                        self.hurt(i, 450);
                    }
                }
                self.events.push(Event::Boom {
                    x,
                    y: 0,
                    r: LANCE_HALF,
                });
            }
        }
        Ok(())
    }

    // ------------------------------------------------------------- step

    fn hurt(&mut self, i: usize, dmg: i32) {
        let frozen = self.tick < self.freeze_until;
        let z = &mut self.zombies[i];
        if z.hp <= 0 {
            return;
        }
        let dmg = if frozen { dmg * 2 } else { dmg };
        z.hp -= dmg;
        self.events.push(Event::Hit {
            x: z.x,
            y: z.y,
            dmg,
        });
    }

    fn explode(&mut self, x: i32, y: i32, r: i32, dmg: i32) {
        self.events.push(Event::Boom { x, y, r });
        for i in 0..self.zombies.len() {
            let z = self.zombies[i];
            let reach = i64::from(r + z.kind.stats().1);
            let (dx, dy) = (i64::from(z.x - x), i64::from(z.y - y));
            if dx * dx + dy * dy <= reach * reach {
                self.hurt(i, dmg);
            }
        }
    }

    fn aimed_bullet(
        from: (i32, i32),
        to: (i32, i32),
        speed: i32,
        dmg: i32,
        splash: i32,
        by: Shooter,
    ) -> Bullet {
        let (dx, dy) = (i64::from(to.0 - from.0), i64::from(to.1 - from.1));
        let len = i64::try_from(isqrt(u64::try_from(dx * dx + dy * dy).unwrap_or(0)))
            .unwrap_or(1)
            .max(1);
        let s = i64::from(speed);
        Bullet {
            x: from.0,
            y: from.1,
            vx: i32::try_from(dx * s / len).unwrap_or(0),
            vy: i32::try_from(dy * s / len).unwrap_or(-speed),
            dmg,
            splash,
            by,
        }
    }

    /// Index of the zombie closest to the line (the biggest threat).
    fn front_zombie(&self) -> Option<usize> {
        (0..self.zombies.len())
            .max_by_key(|&i| (self.zombies[i].y, std::cmp::Reverse(self.zombies[i].id)))
    }

    /// Advances one tick.
    pub fn step(&mut self) {
        if self.status != Status::Playing {
            return;
        }
        let t = self.tick;

        // Waves, spawns, cages, crates.
        while self.next_wave < self.script.waves.len() && self.script.waves[self.next_wave] <= t {
            self.next_wave += 1;
            self.events.push(Event::Wave {
                n: u8::try_from(self.next_wave).unwrap_or(u8::MAX),
            });
        }
        while self.next_spawn < self.script.spawns.len()
            && self.script.spawns[self.next_spawn].tick <= t
        {
            let s = self.script.spawns[self.next_spawn];
            self.next_spawn += 1;
            if self.zombies.len() >= MAX_ALIVE {
                continue;
            }
            if s.kind == ZKind::Boss && !self.boss_seen {
                self.boss_seen = true;
                self.events.push(Event::Boss);
            }
            let hp = i32::try_from(s.hp).unwrap_or(i32::MAX);
            self.zombies.push(Zombie {
                id: self.next_id,
                kind: s.kind,
                x: s.x,
                y: -s.kind.stats().1,
                hp,
                max_hp: hp,
                phase: u8::try_from(self.rng.below(64)).unwrap_or(0),
            });
            self.next_id += 1;
        }
        while self.next_cage < self.script.cages.len()
            && self.script.cages[self.next_cage].tick <= t
        {
            let c = self.script.cages[self.next_cage];
            let hp = i32::try_from(c.hp).unwrap_or(i32::MAX);
            self.cages.push(Cage {
                index: u16::try_from(self.next_cage).unwrap_or(u16::MAX),
                x: c.x,
                y: -600,
                hp,
                max_hp: hp,
                reward: c.reward,
                stop_y: c.stop_y,
            });
            self.next_cage += 1;
        }
        while self.next_crate < self.script.crates.len()
            && self.script.crates[self.next_crate].tick <= t
        {
            let c = self.script.crates[self.next_crate];
            self.crates.push(Crate {
                x: c.x,
                y: -400,
                hp: i32::try_from(c.hp).unwrap_or(i32::MAX),
                kind: c.kind,
            });
            self.next_crate += 1;
        }

        // The gunner walks toward the aim.
        self.gunner_x += (self.aim_x - self.gunner_x).clamp(-GUNNER_STEP, GUNNER_STEP);

        // Fire.
        if self.gun_cd == 0 {
            let (interval, pellets, dmg, spread) = WEAPONS[usize::from(self.weapon.min(3))];
            for p in 0..pellets {
                let offset = if pellets == 2 {
                    if p == 0 {
                        -170
                    } else {
                        170
                    }
                } else {
                    0
                };
                let vx = i32::try_from(self.rng.range(-i64::from(spread), i64::from(spread)))
                    .unwrap_or(0);
                self.bullets.push(Bullet {
                    x: self.gunner_x + offset,
                    y: GUNNER_Y - 500,
                    vx,
                    vy: -950,
                    dmg,
                    splash: 0,
                    by: Shooter::Gun,
                });
            }
            self.gun_cd = interval;
        }
        self.gun_cd -= 1;
        for (side, &turret_x) in TURRET_X.iter().enumerate() {
            if !self.turrets[side] {
                continue;
            }
            if self.turret_cd[side] > 0 {
                self.turret_cd[side] -= 1;
                continue;
            }
            if let Some(i) = self.front_zombie() {
                let z = self.zombies[i];
                self.bullets.push(Self::aimed_bullet(
                    (turret_x, TURRET_Y - 300),
                    (z.x, z.y),
                    900,
                    9,
                    0,
                    Shooter::Turret,
                ));
                self.turret_cd[side] = 3;
            }
        }
        if self.tank {
            if self.tank_cd > 0 {
                self.tank_cd -= 1;
            } else if let Some(i) = self.front_zombie() {
                let z = self.zombies[i];
                self.bullets.push(Self::aimed_bullet(
                    (TANK_X, TURRET_Y - 400),
                    (z.x, z.y),
                    600,
                    70,
                    1_000,
                    Shooter::Tank,
                ));
                self.tank_cd = 36;
            }
        }

        // Effects.
        if t < self.drones_until && t.is_multiple_of(4) {
            if let Some(i) = (0..self.zombies.len())
                .max_by_key(|&i| (self.zombies[i].hp, std::cmp::Reverse(self.zombies[i].id)))
            {
                let z = self.zombies[i];
                self.events.push(Event::Zap { x: z.x, y: z.y });
                self.hurt(i, 16);
            }
        }
        if t < self.napalm_until && t.is_multiple_of(6) {
            for i in 0..self.zombies.len() {
                if (NAPALM_TOP..LINE_Y).contains(&self.zombies[i].y) {
                    self.hurt(i, 14);
                }
            }
        }
        let due: Vec<(u32, i32, i32)> = self.bombs.iter().copied().filter(|b| b.0 <= t).collect();
        self.bombs.retain(|b| b.0 > t);
        for (_, x, y) in due {
            self.explode(x, y, 1_200, 160);
        }

        // Bullets.
        let mut bullets = std::mem::take(&mut self.bullets);
        bullets.retain_mut(|b| {
            b.x += b.vx;
            b.y += b.vy;
            if b.y < -1_000 || b.x < -500 || b.x > BRIDGE_W + 500 {
                return false;
            }
            // Cages and crates catch bullets first: shooting them is a choice.
            for c in &mut self.cages {
                if c.hp > 0 && (b.x - c.x).abs() <= 650 && (b.y - c.y).abs() <= 650 {
                    c.hp -= b.dmg;
                    return false;
                }
            }
            for c in &mut self.crates {
                if c.hp > 0 && (b.x - c.x).abs() <= 380 && (b.y - c.y).abs() <= 380 {
                    c.hp -= b.dmg;
                    return false;
                }
            }
            let hit = self.zombies.iter().position(|z| {
                let reach = i64::from(z.kind.stats().1 + BULLET_R);
                let (dx, dy) = (i64::from(z.x - b.x), i64::from(z.y - b.y));
                z.hp > 0 && dx * dx + dy * dy <= reach * reach
            });
            match hit {
                Some(i) => {
                    if b.splash > 0 {
                        let (x, y) = (b.x, b.y);
                        self.explode(x, y, b.splash, b.dmg);
                    } else {
                        self.hurt(i, b.dmg);
                    }
                    false
                }
                None => true,
            }
        });
        self.bullets = bullets;

        // Cages and crates.
        let mut opened = Vec::new();
        self.cages.retain_mut(|c| {
            if c.hp <= 0 {
                opened.push(*c);
                return false;
            }
            c.y = (c.y + CAGE_SPEED).min(c.stop_y);
            true
        });
        for c in opened {
            self.events.push(Event::CageOpened {
                x: c.x,
                y: c.y,
                reward: c.reward,
            });
            match c.reward {
                Reward::TurretLeft => self.turrets[0] = true,
                Reward::TurretRight => self.turrets[1] = true,
                Reward::Tank => self.tank = true,
                Reward::Weapon => self.weapon = (self.weapon + 1).min(3),
                Reward::Repair => {
                    self.base_hp = (self.base_hp + 6).min(i32::from(self.script.base_hp))
                }
                Reward::Assist(kind) => {
                    let k = usize::from(kind.code());
                    self.charges[k] = (self.charges[k] + 1).min(MAX_CHARGES);
                }
            }
        }
        let mut got = Vec::new();
        self.crates.retain_mut(|c| {
            if c.hp <= 0 {
                got.push(*c);
                return false;
            }
            c.y += CRATE_SPEED;
            c.y < LINE_Y
        });
        for c in got {
            let k = usize::from(c.kind.code());
            self.charges[k] = (self.charges[k] + 1).min(MAX_CHARGES);
            self.events.push(Event::CrateOpened {
                x: c.x,
                y: c.y,
                kind: c.kind,
            });
        }

        // The horde advances.
        let frozen = t < self.freeze_until;
        let mut breached = 0;
        let mut events = Vec::new();
        let mut kills = 0;
        self.zombies.retain_mut(|z| {
            if z.hp <= 0 {
                events.push(Event::Kill {
                    x: z.x,
                    y: z.y,
                    kind: z.kind,
                });
                kills += 1;
                return false;
            }
            if !frozen {
                let (speed, r, dmg) = z.kind.stats();
                z.y += speed;
                // A slow sway, so the horde shuffles instead of marching in lines.
                let sway = i32::from(
                    z.phase
                        .wrapping_add(u8::try_from((t / 4) % 64).unwrap_or(0))
                        % 64,
                );
                z.x = (z.x + if sway < 32 { 6 } else { -6 }).clamp(r, BRIDGE_W - r);
                if z.y >= LINE_Y {
                    breached += dmg;
                    events.push(Event::Breach { x: z.x, dmg });
                    return false;
                }
            }
            true
        });
        self.kills += kills;
        self.events.extend(events);
        self.base_hp -= breached;

        self.tick += 1;
        let all_out = self.next_spawn == self.script.spawns.len();
        if self.base_hp <= 0 {
            self.base_hp = 0;
            self.status = Status::Lost;
        } else if all_out && self.zombies.is_empty() {
            self.status = Status::Won;
        } else if self.tick >= MAX_TICKS {
            self.status = Status::Lost;
        }
    }
}

/// The player's inputs for a whole level, as the browser records them.
///
/// Three bytes per record: `[ticks since the previous record, op, arg]`.
/// Ops: 0 aim (arg = lane), 1 use assist (arg = kind), 2 buy assist (arg = kind),
/// 3 nothing (only to bridge gaps longer than 255 ticks).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct InputLog(pub Vec<u8>);

pub const OP_AIM: u8 = 0;
pub const OP_USE: u8 = 1;
pub const OP_BUY: u8 = 2;
pub const OP_WAIT: u8 = 3;

impl InputLog {
    /// Appends a record at absolute tick `at` (records must be in tick order).
    pub fn push(&mut self, last_tick: &mut u32, at: u32, op: u8, arg: u8) {
        let mut gap = at.saturating_sub(*last_tick);
        while gap > 255 {
            self.0.extend([255, OP_WAIT, 0]);
            gap -= 255;
        }
        self.0.extend([u8::try_from(gap).unwrap_or(255), op, arg]);
        *last_tick = at;
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ReplayError {
    Script(ScriptError),
    BadLog(&'static str),
    Input { tick: u32, error: InputError },
}

impl fmt::Display for ReplayError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Script(e) => e.fmt(f),
            Self::BadLog(m) => write!(f, "bad input log: {m}"),
            Self::Input { tick, error } => write!(f, "input at tick {tick}: {error}"),
        }
    }
}

impl std::error::Error for ReplayError {}

/// Replays a whole level from its inputs. After the last input the gunner keeps its
/// aim and the level plays on until it is won or lost.
pub fn replay(script: &Script, log: &InputLog) -> Result<Sim, ReplayError> {
    if log.0.len() > MAX_LOG_BYTES || !log.0.len().is_multiple_of(3) {
        return Err(ReplayError::BadLog("length"));
    }
    let mut sim = Sim::new(script).map_err(ReplayError::Script)?;
    let mut at = 0u32;
    for rec in log.0.chunks_exact(3) {
        at += u32::from(rec[0]);
        if at > MAX_TICKS {
            return Err(ReplayError::BadLog("past the end of the level"));
        }
        while sim.tick < at && sim.status == Status::Playing {
            sim.step();
        }
        if sim.status != Status::Playing {
            break;
        }
        let apply = |sim: &mut Sim| -> Result<(), InputError> {
            match rec[1] {
                OP_AIM => {
                    sim.set_aim(rec[2]);
                    Ok(())
                }
                OP_USE | OP_BUY => {
                    let kind = AssistKind::from_code(rec[2]).ok_or(InputError::NoCharge)?;
                    if rec[1] == OP_USE {
                        sim.use_assist(kind)
                    } else {
                        sim.buy_assist(kind)
                    }
                }
                OP_WAIT => Ok(()),
                _ => Err(InputError::NoCharge),
            }
        };
        apply(&mut sim).map_err(|error| ReplayError::Input { tick: at, error })?;
    }
    while sim.status == Status::Playing {
        sim.step();
    }
    sim.events.clear();
    Ok(sim)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tiny() -> Script {
        Script {
            seed: 7,
            base_hp: 10,
            waves: vec![0],
            spawns: (0..6)
                .map(|i| Spawn {
                    tick: i * 20,
                    kind: ZKind::Walker,
                    x: BRIDGE_W / 2,
                    hp: 40,
                })
                .collect(),
            cages: vec![CageSpec {
                tick: 0,
                x: 1_500,
                stop_y: 6_000,
                hp: 60,
                reward: Reward::TurretLeft,
            }],
            crates: vec![CrateSpec {
                tick: 10,
                x: BRIDGE_W / 2,
                kind: AssistKind::Freeze,
                hp: 20,
            }],
        }
    }

    #[test]
    fn centre_gun_holds_an_easy_line() {
        let sim = replay(&tiny(), &InputLog::default()).unwrap();
        assert_eq!(sim.status(), Status::Won);
        assert_eq!(sim.kills(), 6);
        assert_eq!(sim.stars(), 3);
        // The crate was in the line of fire: its charge was collected.
        assert_eq!(sim.charges()[AssistKind::Freeze.code() as usize], 1);
    }

    #[test]
    fn unguarded_lanes_get_overrun() {
        let mut s = tiny();
        for sp in &mut s.spawns {
            sp.x = 600;
            sp.hp = 4_000;
        }
        s.base_hp = 3;
        // Aim far right: nothing stops the zombies on the left.
        let mut log = InputLog::default();
        let mut last = 0;
        log.push(&mut last, 0, OP_AIM, 255);
        assert_eq!(replay(&s, &log).unwrap().status(), Status::Lost);
    }

    #[test]
    fn steering_to_a_cage_opens_it() {
        let mut log = InputLog::default();
        let mut last = 0;
        log.push(&mut last, 0, OP_AIM, 25);
        let mut sim = Sim::new(&tiny()).unwrap();
        sim.set_aim(25);
        let mut opened = false;
        while sim.status() == Status::Playing {
            sim.step();
            opened |= sim.take_events().iter().any(|e| {
                matches!(
                    e,
                    Event::CageOpened {
                        reward: Reward::TurretLeft,
                        ..
                    }
                )
            });
        }
        assert!(opened);
        assert!(sim.turrets()[0]);
    }

    #[test]
    fn assists_need_charges_and_replays_match() {
        let mut sim = Sim::new(&tiny()).unwrap();
        assert_eq!(sim.use_assist(AssistKind::Lance), Err(InputError::NoCharge));
        sim.buy_assist(AssistKind::Lance).unwrap();
        assert_eq!(sim.bought()[AssistKind::Lance.code() as usize], 1);

        let mut log = InputLog::default();
        let mut last = 0;
        log.push(&mut last, 0, OP_BUY, AssistKind::Airstrike.code());
        log.push(&mut last, 300, OP_USE, AssistKind::Airstrike.code());
        log.push(&mut last, 900, OP_AIM, 10);
        let a = replay(&tiny(), &log).unwrap();
        let b = replay(&tiny(), &log).unwrap();
        assert_eq!(
            (a.status(), a.tick(), a.kills(), a.base_hp()),
            (b.status(), b.tick(), b.kills(), b.base_hp())
        );

        let mut cheat = InputLog::default();
        let mut last = 0;
        cheat.push(&mut last, 5, OP_USE, AssistKind::Napalm.code());
        assert!(matches!(
            replay(&tiny(), &cheat),
            Err(ReplayError::Input { .. })
        ));
        assert!(matches!(
            replay(&tiny(), &InputLog(vec![1, 2])),
            Err(ReplayError::BadLog(_))
        ));
    }

    #[test]
    fn long_gaps_are_bridged() {
        let mut log = InputLog::default();
        let mut last = 0;
        log.push(&mut last, 700, OP_AIM, 128);
        assert_eq!(log.0.len(), 9);
        assert_eq!(log.0[..3], [255, OP_WAIT, 0]);
    }
}
