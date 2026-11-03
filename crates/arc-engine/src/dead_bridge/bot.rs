//! A sensible player, used by the level generator to prove each level beatable and
//! to measure how close it runs.
//!
//! It guards the lane of the nearest zombie, breaks cages and crates when the front
//! is quiet, and fires assists when the horde gets close. `slack` makes it react late
//! (in ticks), like a less careful player.

use super::{AssistKind, InputLog, Sim, Status, ZKind, BRIDGE_W, LANES, LINE_Y, OP_AIM, OP_USE};

#[derive(Clone, Debug)]
pub struct BotRun {
    pub status: Status,
    pub base_hp: i32,
    pub ticks: u32,
    /// The inputs it played (replaying them gives the same result).
    pub log: InputLog,
}

fn lane(x: i32) -> u8 {
    let margin = 400;
    let v = (x - margin) * (LANES - 1) / (BRIDGE_W - 2 * margin);
    u8::try_from(v.clamp(0, LANES - 1)).unwrap_or(0)
}

/// Plays a whole level. Deterministic for a given script and slack.
#[must_use]
pub fn play(script: &super::Script, slack: u32) -> BotRun {
    let Ok(mut sim) = Sim::new(script) else {
        return BotRun {
            status: Status::Lost,
            base_hp: 0,
            ticks: 0,
            log: InputLog::default(),
        };
    };
    let mut log = InputLog::default();
    let mut last = 0u32;
    let mut aim: Option<u8> = None;
    let decide_every = 3 + slack;
    while sim.status() == Status::Playing {
        let t = sim.tick();
        if t % decide_every == 0 {
            let front = sim.zombies().iter().max_by_key(|z| z.y).copied();
            // Cages are worth a detour unless the horde is close; crates only when it's calm.
            let near = |pct: i32| front.is_some_and(|z| z.y > LINE_Y * pct / 100);
            let crate_x = sim
                .crates()
                .iter()
                .filter(|c| c.y > 1_500)
                .max_by_key(|c| c.y)
                .map(|c| c.x);
            let boss = sim
                .zombies()
                .iter()
                .find(|z| z.kind == ZKind::Boss && z.y > LINE_Y * 45 / 100)
                .map(|z| z.x);
            let target = if near(72) {
                front.map(|z| z.x)
            } else if boss.is_some() {
                boss
            } else if let Some(c) = sim.cages().iter().find(|c| c.y > 1_500) {
                Some(c.x)
            } else if near(55) {
                front.map(|z| z.x)
            } else {
                crate_x.or(front.map(|z| z.x))
            };
            if let Some(x) = target {
                let l = lane(x);
                if aim != Some(l) {
                    aim = Some(l);
                    sim.set_aim(l);
                    log.push(&mut last, t, OP_AIM, l);
                }
            }
            // Assists when the horde is close, or the boss is on the bridge.
            let close = front.is_some_and(|z| z.y > LINE_Y * 80 / 100);
            let boss = sim.zombies().iter().any(|z| z.kind == ZKind::Boss);
            if close || boss {
                let order = [
                    AssistKind::Nuke,
                    AssistKind::Lance,
                    AssistKind::Barrage,
                    AssistKind::Airstrike,
                    AssistKind::Freeze,
                    AssistKind::Napalm,
                    AssistKind::Drones,
                ];
                if let Some(&k) = order
                    .iter()
                    .find(|k| sim.charges()[usize::from(k.code())] > 0)
                {
                    if sim.use_assist(k).is_ok() {
                        log.push(&mut last, t, OP_USE, k.code());
                    }
                }
            }
        }
        sim.step();
        sim.take_events();
    }
    BotRun {
        status: sim.status(),
        base_hp: sim.base_hp(),
        ticks: sim.tick(),
        log,
    }
}

#[cfg(test)]
mod tests {
    use super::super::{replay, CageSpec, Reward, Script, Spawn};
    use super::*;

    #[test]
    fn bot_wins_a_fair_level_and_its_log_replays() {
        let script = Script {
            seed: 3,
            base_hp: 15,
            waves: vec![0, 300],
            spawns: (0..40u32)
                .map(|i| Spawn {
                    tick: i * 15,
                    kind: if i % 7 == 0 {
                        ZKind::Runner
                    } else {
                        ZKind::Walker
                    },
                    x: 800 + i32::try_from(i * 211 % 8_400).unwrap_or(0),
                    hp: 50,
                })
                .collect(),
            cages: vec![CageSpec {
                tick: 30,
                x: 8_500,
                stop_y: 5_000,
                hp: 120,
                reward: Reward::Gun(super::super::Gun::Minigun),
            }],
            crates: vec![],
        };
        let run = play(&script, 0);
        assert_eq!(run.status, Status::Won, "hp left {}", run.base_hp);
        let again = replay(&script, &run.log).unwrap();
        assert_eq!(
            (again.status(), again.base_hp(), again.tick()),
            (run.status, run.base_hp, run.ticks)
        );
    }
}
