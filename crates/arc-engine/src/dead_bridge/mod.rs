//! Dead Bridge Assault: hold the line at the foot of a bridge while the horde pours down.
//!
//! Rules (see the Dead Bridge Assault design doc):
//! - The gunner stands below the line and fires up the bridge on its own; the player
//!   only steers (an aim lane, 0..=255) and fires assists.
//! - Zombies walk down the bridge. One that reaches [`LINE_Y`] breaks through: it is
//!   gone, but the base loses health. The level is lost at 0 health.
//! - Gold cages descend the sides. Shooting one open gives a weapon, a unit (turret,
//!   tank, mech), a repair, a barricade or an assist. Weapons and units are temporary:
//!   when their time runs out the gunner is back to the rifle until the next cage.
//! - Power crates drift down among the horde and fade if not shot in time.
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
/// Hard cap on a level's length (the scripts last 2-4 minutes).
pub const MAX_TICKS: u32 = 6 * 60 * TPS;
pub const MAX_ALIVE: usize = 500;
pub const MAX_SPAWNS: usize = 4_000;
pub const MAX_LOG_BYTES: usize = 24_000;
pub const MAX_CHARGES: u8 = 9;
/// Seeds must survive a JSON round trip through the browser, whose numbers are doubles.
pub const MAX_SEED: u64 = (1 << 53) - 1;
/// How long a weapon or unit from a cage lasts.
pub const WEAPON_TICKS: u32 = 25 * TPS;
pub const TURRET_TICKS: u32 = 25 * TPS;
pub const TANK_TICKS: u32 = 22 * TPS;
pub const MECH_TICKS: u32 = 20 * TPS;
pub const BARRICADE_TICKS: u32 = 10 * TPS;
/// Power crates fade if not shot within this time.
pub const CRATE_TICKS: u32 = 8 * TPS;
/// A unit waiting in the ready slot deploys on its own after this long.
pub const READY_TICKS: u32 = 15 * TPS;

const GUNNER_STEP: i32 = 420;
const BULLET_R: i32 = 90;
const TURRET_X: [i32; 2] = [1_100, 8_900];
const TURRET_Y: i32 = LINE_Y + 500;
const TANK_X: i32 = 7_400;
const MECH_OFFSET: i32 = 1_500;
const FREEZE_TICKS: u32 = 90;
const DRONE_TICKS: u32 = 150;
const NAPALM_TICKS: u32 = 120;
const NAPALM_TOP: i32 = LINE_Y - 6_500;
const LANCE_HALF: i32 = 650;
const LASER_HALF: i32 = 260;
const CRATE_SPEED: i32 = 30;
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
            Self::Boss => (6, 900, 40),
        }
    }
}

/// The gunner's weapon. Everything but the rifle comes from a cage and is temporary.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Gun {
    Rifle,
    /// A wide spread at short range.
    Shotgun,
    /// Very fast fire.
    Minigun,
    /// A short cone of fire that sets zombies burning.
    Flamethrower,
    /// Rockets that explode on impact.
    Rocket,
    /// A beam that pierces everything in the lane.
    Laser,
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
    /// A beam from orbit down the gunner's lane.
    Lance,
    /// A burning carpet across the lower bridge for 4 s.
    Napalm,
    /// Twelve rockets on the toughest zombies.
    Barrage,
    /// Hits everything on the bridge. Rare.
    Nuke,
}

impl AssistKind {
    pub const ALL: [Self; 7] = [
        Self::Airstrike,
        Self::Freeze,
        Self::Drones,
        Self::Lance,
        Self::Napalm,
        Self::Barrage,
        Self::Nuke,
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
    /// A combat mech that walks beside the gunner with twin heavy guns.
    Mech,
    Gun(Gun),
    /// +6 base health.
    Repair,
    /// Breaches do no damage for 10 s.
    Barricade,
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
        if self.seed > MAX_SEED {
            return bad("seed");
        }
        if self.spawns.is_empty() || self.spawns.len() > MAX_SPAWNS {
            return bad("spawn count");
        }
        if self.cages.len() > 128 || self.crates.len() > 256 || self.waves.len() > 16 {
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
    /// Burning (from the flamethrower) until this tick.
    pub burn_until: u32,
    /// A sideways sway so the horde doesn't march in straight lines.
    phase: u8,
}

/// What a bullet is (for damage rules and drawing).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Shot {
    Rifle,
    Turret,
    Shell,
    Pellet,
    Minigun,
    Flame,
    Rocket,
    Mech,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Bullet {
    pub x: i32,
    pub y: i32,
    vx: i32,
    vy: i32,
    dmg: i32,
    splash: i32,
    /// Ticks left before it fizzles (short-range weapons); 0 = until it hits.
    life: u16,
    pub kind: Shot,
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
    /// Fades away at this tick.
    pub until: u32,
}

/// Things that happened, in order, for the renderer and the messages.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Event {
    Wave {
        n: u8,
    },
    Boss,
    Hit {
        x: i32,
        y: i32,
        dmg: i32,
    },
    Kill {
        x: i32,
        y: i32,
        kind: ZKind,
    },
    Breach {
        x: i32,
        dmg: i32,
    },
    /// A breach the barricade stopped.
    Blocked {
        x: i32,
    },
    CageOpened {
        x: i32,
        y: i32,
        reward: Reward,
    },
    CrateOpened {
        x: i32,
        y: i32,
        kind: AssistKind,
    },
    CrateLost {
        x: i32,
        y: i32,
    },
    Assist {
        kind: AssistKind,
    },
    Boom {
        x: i32,
        y: i32,
        r: i32,
    },
    /// A beam down a lane (laser, lance).
    Beam {
        x: i32,
        half: i32,
    },
    Zap {
        x: i32,
        y: i32,
    },
    /// A temporary upgrade ran out: 0 turret, 2 tank, 3 mech, 4 gun, 6 barricade.
    Expired {
        what: u8,
    },
    /// A unit from a cage is waiting in the ready slot.
    Ready {
        reward: Reward,
    },
    /// The ready unit went into action (by the player, or on its own).
    Deployed {
        reward: Reward,
    },
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
    gun: Gun,
    gun_until: u32,
    turret_until: [u32; 2],
    tank_until: u32,
    mech_until: u32,
    mech_x: i32,
    barricade_until: u32,
    /// A unit (turret, tank, mech, barricade) waiting for the player to deploy it, and
    /// the tick it deploys on its own.
    ready: Option<(Reward, u32)>,
    base_hp: i32,
    charges: [u8; 7],
    bought: [u8; 7],
    freeze_until: u32,
    drones_until: u32,
    napalm_until: u32,
    /// `(tick, x, y, radius, damage)` explosions still to come.
    bombs: Vec<(u32, i32, i32, i32, i32)>,
    gun_cd: u32,
    turret_cd: [u32; 2],
    tank_cd: u32,
    mech_cd: u32,
    status: Status,
    kills: u32,
    next_id: u32,
    events: Vec<Event>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InputError {
    NoCharge,
    TooManyCharges,
    NotPlaying,
    NothingReady,
}

impl fmt::Display for InputError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::NoCharge => "no charge left for that assist",
            Self::TooManyCharges => "too many charges",
            Self::NotPlaying => "the level is over",
            Self::NothingReady => "no unit is ready",
        })
    }
}

impl std::error::Error for InputError {}

fn active(until: u32, t: u32) -> bool {
    t < until
}

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
            gun: Gun::Rifle,
            gun_until: 0,
            turret_until: [0; 2],
            tank_until: 0,
            mech_until: 0,
            mech_x: BRIDGE_W / 2,
            barricade_until: 0,
            ready: None,
            base_hp: i32::from(script.base_hp),
            charges: [0; 7],
            bought: [0; 7],
            freeze_until: 0,
            drones_until: 0,
            napalm_until: 0,
            bombs: Vec::new(),
            gun_cd: 0,
            turret_cd: [0; 2],
            tank_cd: 0,
            mech_cd: 0,
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
    pub fn mech_x(&self) -> i32 {
        self.mech_x
    }
    #[must_use]
    pub fn gun(&self) -> Gun {
        self.gun
    }
    /// Ticks left on each temporary upgrade: `[gun, left turret, right turret, tank,
    /// mech, barricade]` (0 = not active).
    #[must_use]
    pub fn timers(&self) -> [u32; 6] {
        let left = |until: u32| until.saturating_sub(self.tick);
        [
            left(self.gun_until),
            left(self.turret_until[0]),
            left(self.turret_until[1]),
            left(self.tank_until),
            left(self.mech_until),
            left(self.barricade_until),
        ]
    }
    #[must_use]
    pub fn ready(&self) -> Option<(Reward, u32)> {
        self.ready.map(|(r, at)| (r, at.saturating_sub(self.tick)))
    }
    #[must_use]
    pub fn base_hp(&self) -> i32 {
        self.base_hp
    }
    #[must_use]
    pub fn charges(&self) -> [u8; 7] {
        self.charges
    }
    /// Assist charges bought with coins (the server checks these were paid for).
    #[must_use]
    pub fn bought(&self) -> [u8; 7] {
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
            active(self.freeze_until, self.tick),
            active(self.drones_until, self.tick),
            active(self.napalm_until, self.tick),
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

    /// Sends the unit in the ready slot into action.
    pub fn deploy(&mut self) -> Result<(), InputError> {
        if self.status != Status::Playing {
            return Err(InputError::NotPlaying);
        }
        let (reward, _) = self.ready.take().ok_or(InputError::NothingReady)?;
        self.activate(reward);
        self.events.push(Event::Deployed { reward });
        Ok(())
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

    /// Live zombies' positions, highest `key` first (ties by id, so it's deterministic).
    fn ranked(&self, key: impl Fn(&Zombie) -> i32) -> Vec<(i32, i32)> {
        let mut zs: Vec<&Zombie> = self.zombies.iter().filter(|z| z.hp > 0).collect();
        zs.sort_by_key(|z| (std::cmp::Reverse(key(z)), z.id));
        zs.iter().map(|z| (z.x, z.y)).collect()
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
        let t = self.tick;
        match kind {
            AssistKind::Airstrike => {
                // Bombs walk across the front of the horde, the nearest zombies first.
                let mut front = self.ranked(|z| z.y);
                if front.is_empty() {
                    front.push((BRIDGE_W / 2, LINE_Y / 2));
                }
                for (i, &(x, y)) in front.iter().take(6).enumerate() {
                    let at = t + 4 + 5 * u32::try_from(i).unwrap_or(0);
                    self.bombs.push((at, x, y + 400, 1_200, 170));
                }
            }
            AssistKind::Barrage => {
                let tough = self.ranked(|z| z.hp);
                for i in 0..12 {
                    let Some(&(x, y)) = tough.get(i % tough.len().max(1)) else {
                        break;
                    };
                    let at = t + 3 + 2 * u32::try_from(i).unwrap_or(0);
                    self.bombs.push((at, x, y + 300, 750, 150));
                }
            }
            AssistKind::Nuke => {
                self.events.push(Event::Boom {
                    x: BRIDGE_W / 2,
                    y: LINE_Y / 2,
                    r: BRIDGE_W,
                });
                for i in 0..self.zombies.len() {
                    self.hurt(i, 900);
                }
            }
            AssistKind::Freeze => self.freeze_until = t + FREEZE_TICKS,
            AssistKind::Drones => self.drones_until = t + DRONE_TICKS,
            AssistKind::Napalm => self.napalm_until = t + NAPALM_TICKS,
            AssistKind::Lance => {
                let x = self.gunner_x;
                self.beam(x, LANCE_HALF, 500);
            }
        }
        Ok(())
    }

    // ------------------------------------------------------------- step

    fn hurt(&mut self, i: usize, dmg: i32) {
        let frozen = active(self.freeze_until, self.tick);
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

    /// Damages everything in a lane: zombies, cages and crates (laser, lance).
    fn beam(&mut self, x: i32, half: i32, dmg: i32) {
        self.events.push(Event::Beam { x, half });
        for i in 0..self.zombies.len() {
            if (self.zombies[i].x - x).abs() <= half + self.zombies[i].kind.stats().1 {
                self.hurt(i, dmg);
            }
        }
        for c in &mut self.cages {
            if (c.x - x).abs() <= half + 500 {
                c.hp -= dmg;
            }
        }
        for c in &mut self.crates {
            if (c.x - x).abs() <= half + 300 {
                c.hp -= dmg;
            }
        }
    }

    fn aimed(
        from: (i32, i32),
        to: (i32, i32),
        speed: i32,
        dmg: i32,
        splash: i32,
        kind: Shot,
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
            life: 0,
            kind,
        }
    }

    fn straight(x: i32, y: i32, vx: i32, vy: i32, dmg: i32, kind: Shot) -> Bullet {
        Bullet {
            x,
            y,
            vx,
            vy,
            dmg,
            splash: 0,
            life: 0,
            kind,
        }
    }

    /// Index of the zombie closest to the line (the biggest threat).
    fn front_zombie(&self) -> Option<usize> {
        (0..self.zombies.len())
            .max_by_key(|&i| (self.zombies[i].y, std::cmp::Reverse(self.zombies[i].id)))
    }

    fn fire_gun(&mut self) {
        let t = self.tick;
        if !active(self.gun_until, t) && self.gun != Gun::Rifle {
            self.gun = Gun::Rifle;
            self.events.push(Event::Expired { what: 4 });
        }
        if self.gun_cd > 0 {
            self.gun_cd -= 1;
            return;
        }
        let (gx, gy) = (self.gunner_x, GUNNER_Y - 500);
        let jitter = |rng: &mut Rng, s: i64| i32::try_from(rng.range(-s, s)).unwrap_or(0);
        match self.gun {
            Gun::Rifle => {
                let vx = jitter(&mut self.rng, 40);
                self.bullets
                    .push(Self::straight(gx, gy, vx, -1_000, 10, Shot::Rifle));
                self.gun_cd = 2;
            }
            Gun::Minigun => {
                for off in [-120, 120] {
                    let vx = jitter(&mut self.rng, 110);
                    self.bullets
                        .push(Self::straight(gx + off, gy, vx, -1_050, 9, Shot::Minigun));
                }
                self.gun_cd = 1;
            }
            Gun::Shotgun => {
                for k in -3..=3 {
                    let vx = k * 75 + jitter(&mut self.rng, 20);
                    let mut b = Self::straight(gx, gy, vx, -950, 12, Shot::Pellet);
                    b.life = 11;
                    self.bullets.push(b);
                }
                self.gun_cd = 6;
            }
            Gun::Flamethrower => {
                for _ in 0..3 {
                    let vx = jitter(&mut self.rng, 230);
                    // Reaches about two-thirds of the way up the bridge.
                    let mut b = Self::straight(gx, gy, vx, -620, 5, Shot::Flame);
                    b.life = 19;
                    self.bullets.push(b);
                }
                self.gun_cd = 0;
            }
            Gun::Rocket => {
                let mut b = Self::straight(gx, gy, 0, -760, 60, Shot::Rocket);
                b.splash = 1_000;
                self.bullets.push(b);
                self.gun_cd = 9;
            }
            Gun::Laser => {
                self.beam(gx, LASER_HALF, 28);
                self.gun_cd = 4;
            }
        }
    }

    fn fire_units(&mut self) {
        let t = self.tick;
        for (side, &turret_x) in TURRET_X.iter().enumerate() {
            let until = self.turret_until[side];
            if until != 0 && !active(until, t) {
                self.turret_until[side] = 0;
                self.events.push(Event::Expired { what: 0 });
                continue;
            }
            if !active(until, t) {
                continue;
            }
            if self.turret_cd[side] > 0 {
                self.turret_cd[side] -= 1;
                continue;
            }
            if let Some(i) = self.front_zombie() {
                let z = self.zombies[i];
                self.bullets.push(Self::aimed(
                    (turret_x, TURRET_Y - 300),
                    (z.x, z.y),
                    950,
                    11,
                    0,
                    Shot::Turret,
                ));
                self.turret_cd[side] = 2;
            }
        }
        if self.tank_until != 0 && !active(self.tank_until, t) {
            self.tank_until = 0;
            self.events.push(Event::Expired { what: 2 });
        }
        if active(self.tank_until, t) {
            if self.tank_cd > 0 {
                self.tank_cd -= 1;
            } else if let Some(i) = self.front_zombie() {
                let z = self.zombies[i];
                self.bullets.push(Self::aimed(
                    (TANK_X, TURRET_Y - 400),
                    (z.x, z.y),
                    650,
                    90,
                    1_100,
                    Shot::Shell,
                ));
                self.tank_cd = 26;
            }
        }
        if self.mech_until != 0 && !active(self.mech_until, t) {
            self.mech_until = 0;
            self.events.push(Event::Expired { what: 3 });
        }
        if active(self.mech_until, t) {
            // The mech walks a little to one side of the gunner, covering the next lane.
            let side = if self.gunner_x < BRIDGE_W / 2 {
                MECH_OFFSET
            } else {
                -MECH_OFFSET
            };
            let want = (self.gunner_x + side).clamp(700, BRIDGE_W - 700);
            self.mech_x += (want - self.mech_x).clamp(-200, 200);
            if self.mech_cd > 0 {
                self.mech_cd -= 1;
            } else {
                for off in [-160, 160] {
                    self.bullets.push(Self::straight(
                        self.mech_x + off,
                        GUNNER_Y - 900,
                        0,
                        -1_000,
                        16,
                        Shot::Mech,
                    ));
                }
                self.mech_cd = 2;
            }
        }
        if self.barricade_until != 0 && !active(self.barricade_until, t) {
            self.barricade_until = 0;
            self.events.push(Event::Expired { what: 6 });
        }
    }

    /// Units wait in the ready slot; everything else takes effect at once. The slot holds
    /// one unit, so a new one sends the waiting one into action.
    fn open_cage(&mut self, reward: Reward) {
        if matches!(
            reward,
            Reward::TurretLeft
                | Reward::TurretRight
                | Reward::Tank
                | Reward::Mech
                | Reward::Barricade
        ) {
            if let Some((old, _)) = self.ready.take() {
                self.activate(old);
                self.events.push(Event::Deployed { reward: old });
            }
            self.ready = Some((reward, self.tick + READY_TICKS));
            self.events.push(Event::Ready { reward });
        } else {
            self.activate(reward);
        }
    }

    fn activate(&mut self, reward: Reward) {
        let t = self.tick;
        match reward {
            Reward::TurretLeft => self.turret_until[0] = t + TURRET_TICKS,
            Reward::TurretRight => self.turret_until[1] = t + TURRET_TICKS,
            Reward::Tank => self.tank_until = t + TANK_TICKS,
            Reward::Mech => {
                if !active(self.mech_until, t) {
                    self.mech_x = self.gunner_x;
                }
                self.mech_until = t + MECH_TICKS;
            }
            Reward::Gun(gun) => {
                self.gun = gun;
                self.gun_until = t + WEAPON_TICKS;
                self.gun_cd = 0;
            }
            Reward::Repair => {
                self.base_hp = (self.base_hp + 6).min(i32::from(self.script.base_hp));
            }
            Reward::Barricade => self.barricade_until = t + BARRICADE_TICKS,
            Reward::Assist(kind) => {
                let k = usize::from(kind.code());
                self.charges[k] = (self.charges[k] + 1).min(MAX_CHARGES);
            }
        }
    }

    /// Advances one tick.
    pub fn step(&mut self) {
        if self.status != Status::Playing {
            return;
        }
        let t = self.tick;

        if let Some((reward, at)) = self.ready {
            if t >= at {
                self.ready = None;
                self.activate(reward);
                self.events.push(Event::Deployed { reward });
            }
        }

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
                burn_until: 0,
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
                until: t + CRATE_TICKS,
            });
            self.next_crate += 1;
        }

        // The gunner walks toward the aim, then everything fires.
        self.gunner_x += (self.aim_x - self.gunner_x).clamp(-GUNNER_STEP, GUNNER_STEP);
        self.fire_gun();
        self.fire_units();

        // Effects.
        if active(self.drones_until, t) && t.is_multiple_of(4) {
            if let Some(i) = (0..self.zombies.len())
                .max_by_key(|&i| (self.zombies[i].hp, std::cmp::Reverse(self.zombies[i].id)))
            {
                let z = self.zombies[i];
                self.events.push(Event::Zap { x: z.x, y: z.y });
                self.hurt(i, 18);
            }
        }
        if active(self.napalm_until, t) && t.is_multiple_of(6) {
            for i in 0..self.zombies.len() {
                if (NAPALM_TOP..LINE_Y).contains(&self.zombies[i].y) {
                    self.hurt(i, 16);
                }
            }
        }
        if t.is_multiple_of(6) {
            for i in 0..self.zombies.len() {
                if active(self.zombies[i].burn_until, t) {
                    self.hurt(i, 4);
                }
            }
        }
        let due: Vec<(u32, i32, i32, i32, i32)> =
            self.bombs.iter().copied().filter(|b| b.0 <= t).collect();
        self.bombs.retain(|b| b.0 > t);
        for (_, x, y, r, dmg) in due {
            self.explode(x, y, r, dmg);
        }

        // Bullets.
        let mut bullets = std::mem::take(&mut self.bullets);
        let mut splashes = Vec::new();
        let frozen_now = active(self.freeze_until, t);
        bullets.retain_mut(|b| {
            b.x += b.vx;
            b.y += b.vy;
            if b.life > 0 {
                b.life -= 1;
                if b.life == 0 {
                    return false;
                }
            }
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
            let Some(i) = hit else {
                return true;
            };
            if b.splash > 0 {
                splashes.push((b.x, b.y, b.splash, b.dmg));
                return false;
            }
            let z = &mut self.zombies[i];
            let dmg = if frozen_now { b.dmg * 2 } else { b.dmg };
            z.hp -= dmg;
            self.events.push(Event::Hit {
                x: z.x,
                y: z.y,
                dmg,
            });
            if b.kind == Shot::Flame {
                // Fire passes through and leaves them burning.
                z.burn_until = t + 2 * TPS;
                return true;
            }
            false
        });
        self.bullets = bullets;
        for (x, y, r, dmg) in splashes {
            self.explode(x, y, r, dmg);
        }

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
            self.open_cage(c.reward);
        }
        let mut got = Vec::new();
        let mut lost = Vec::new();
        self.crates.retain_mut(|c| {
            if c.hp <= 0 {
                got.push(*c);
                return false;
            }
            c.y += CRATE_SPEED;
            if t >= c.until || c.y >= LINE_Y {
                lost.push(*c);
                return false;
            }
            true
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
        for c in lost {
            self.events.push(Event::CrateLost { x: c.x, y: c.y });
        }

        // The horde advances.
        let frozen = active(self.freeze_until, t);
        let barricade = active(self.barricade_until, t);
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
                    if barricade && z.kind != ZKind::Boss {
                        events.push(Event::Blocked { x: z.x });
                    } else {
                        breached += dmg;
                        events.push(Event::Breach { x: z.x, dmg });
                    }
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
pub const OP_DEPLOY: u8 = 4;

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
                OP_DEPLOY => sim.deploy(),
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

    fn run_until(script: &Script, lane: u8, until: impl Fn(&Sim) -> bool) -> Sim {
        let mut sim = Sim::new(script).unwrap();
        sim.set_aim(lane);
        while sim.status() == Status::Playing && !until(&sim) {
            sim.step();
        }
        sim
    }

    #[test]
    fn seeds_fit_in_a_browser_number() {
        let mut script = tiny();
        script.seed = MAX_SEED;
        assert!(Sim::new(&script).is_ok());
        script.seed = MAX_SEED + 1;
        assert!(Sim::new(&script).is_err());
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
        let mut log = InputLog::default();
        let mut last = 0;
        log.push(&mut last, 0, OP_AIM, 255);
        assert_eq!(replay(&s, &log).unwrap().status(), Status::Lost);
    }

    #[test]
    fn units_from_cages_run_out() {
        let mut s = tiny();
        // A long level so the turret's time can run out.
        s.spawns.push(Spawn {
            tick: 3_000,
            kind: ZKind::Walker,
            x: 5_000,
            hp: 10,
        });
        let mut sim = run_until(&s, 25, |s| s.timers()[1] > 0);
        assert!(
            sim.timers()[1] > TURRET_TICKS - 5,
            "the turret was just unlocked"
        );
        let mut expired = false;
        while sim.status() == Status::Playing {
            sim.step();
            expired |= sim
                .take_events()
                .iter()
                .any(|e| matches!(e, Event::Expired { what: 0 }));
        }
        assert!(expired, "the turret should expire");
        assert_eq!(sim.timers()[1], 0);
    }

    #[test]
    fn every_gun_kills_and_reverts_to_the_rifle() {
        for gun in [
            Gun::Shotgun,
            Gun::Minigun,
            Gun::Flamethrower,
            Gun::Rocket,
            Gun::Laser,
        ] {
            let mut s = tiny();
            s.cages[0] = CageSpec {
                tick: 0,
                x: 5_000,
                stop_y: 2_000,
                hp: 20,
                reward: Reward::Gun(gun),
            };
            s.spawns.push(Spawn {
                tick: 1_200,
                kind: ZKind::Brute,
                x: 5_000,
                hp: 200,
            });
            let mut sim = Sim::new(&s).unwrap();
            let mut seen_gun = false;
            while sim.status() == Status::Playing {
                sim.step();
                seen_gun |= sim.gun() == gun;
            }
            assert!(seen_gun, "{gun:?} was never picked up");
            assert_eq!(sim.status(), Status::Won, "{gun:?}");
            assert_eq!(sim.gun(), Gun::Rifle, "{gun:?} should run out");
        }
    }

    #[test]
    fn crates_fade_if_ignored() {
        let mut s = tiny();
        s.crates[0].x = 9_000;
        // Keep the level running past the crate's lifetime.
        s.spawns.push(Spawn {
            tick: 600,
            kind: ZKind::Walker,
            x: 5_000,
            hp: 10,
        });
        let mut sim = Sim::new(&s).unwrap();
        let mut lost = false;
        while sim.status() == Status::Playing {
            sim.step();
            lost |= sim
                .take_events()
                .iter()
                .any(|e| matches!(e, Event::CrateLost { .. }));
        }
        assert!(lost);
        assert_eq!(sim.charges()[AssistKind::Freeze.code() as usize], 0);
    }

    #[test]
    fn barricade_blocks_breaches() {
        let mut s = tiny();
        s.cages[0] = CageSpec {
            tick: 0,
            x: 5_000,
            stop_y: 1_000,
            hp: 10,
            reward: Reward::Barricade,
        };
        for sp in &mut s.spawns {
            sp.x = 600;
            sp.hp = 4_000;
            sp.kind = ZKind::Runner;
        }
        let mut sim = Sim::new(&s).unwrap();
        while sim.status() == Status::Playing && sim.tick() < 300 {
            sim.step();
            if sim.ready().is_some() {
                sim.deploy().unwrap();
            }
        }
        assert_eq!(
            sim.base_hp(),
            10,
            "runners arriving behind the barricade do no damage"
        );
    }

    #[test]
    fn units_wait_in_the_ready_slot() {
        let mut s = tiny();
        s.cages = vec![
            CageSpec {
                tick: 0,
                x: 5_000,
                stop_y: 1_000,
                hp: 10,
                reward: Reward::Tank,
            },
            CageSpec {
                tick: 200,
                x: 5_000,
                stop_y: 1_000,
                hp: 10,
                reward: Reward::Mech,
            },
        ];
        s.spawns.push(Spawn {
            tick: 3_000,
            kind: ZKind::Walker,
            x: 5_000,
            hp: 10,
        });
        let mut sim = Sim::new(&s).unwrap();
        assert_eq!(sim.deploy(), Err(InputError::NothingReady));
        while sim.ready().is_none() {
            sim.step();
        }
        assert_eq!(sim.ready().map(|r| r.0), Some(Reward::Tank));
        assert_eq!(sim.timers()[3], 0, "the tank waits until deployed");
        // A second unit sends the waiting tank in and takes its place.
        while sim.ready().map(|r| r.0) != Some(Reward::Mech) {
            sim.step();
        }
        assert!(sim.timers()[3] > 0, "the tank went in on its own");
        assert_eq!(sim.timers()[4], 0);
        // Left alone, the mech deploys itself after READY_TICKS.
        for _ in 0..=READY_TICKS {
            sim.step();
        }
        assert!(sim.ready().is_none());
        assert!(sim.timers()[4] > 0);

        // Deploying is an input, and it replays.
        let mut sim = Sim::new(&s).unwrap();
        let mut log = InputLog::default();
        let mut last = 0;
        while sim.ready().is_none() {
            sim.step();
        }
        let at = sim.tick();
        sim.deploy().unwrap();
        log.push(&mut last, at, OP_DEPLOY, 0);
        while sim.status() == Status::Playing {
            sim.step();
        }
        let again = replay(&s, &log).unwrap();
        assert_eq!((again.status(), again.kills()), (sim.status(), sim.kills()));
        // Deploying with nothing ready is a bad log.
        let mut bad = InputLog::default();
        let mut last = 0;
        bad.push(&mut last, 1, OP_DEPLOY, 0);
        assert!(replay(&s, &bad).is_err());
    }

    #[test]
    fn assists_need_charges_and_replays_match() {
        let mut sim = Sim::new(&tiny()).unwrap();
        assert_eq!(sim.use_assist(AssistKind::Lance), Err(InputError::NoCharge));
        sim.buy_assist(AssistKind::Lance).unwrap();
        assert_eq!(sim.bought()[AssistKind::Lance.code() as usize], 1);

        let mut log = InputLog::default();
        let mut last = 0;
        for kind in [AssistKind::Airstrike, AssistKind::Barrage, AssistKind::Nuke] {
            log.push(&mut last, 0, OP_BUY, kind.code());
        }
        log.push(&mut last, 100, OP_USE, AssistKind::Barrage.code());
        log.push(&mut last, 300, OP_USE, AssistKind::Airstrike.code());
        log.push(&mut last, 400, OP_USE, AssistKind::Nuke.code());
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
