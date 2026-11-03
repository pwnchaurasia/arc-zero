import { useEffect, useRef, useState } from "react";

import { ApiError, api } from "../api/client";
import type { DbAssist, DbComplete, DbStart } from "../api/types";
import { dbConstants, engine, loadEngine } from "../engine/wasm";
import { haptic, sfx } from "../feel/audio";
import { ASSISTS, DeadBridgeView, GUNS, HUD } from "../games/dead-bridge/DeadBridgeView";
import { useSession } from "../state/session";
import { CoinChip } from "../ui/CoinChip";
import { Button, IconButton, TopBar } from "../ui/kit";
import { ConfirmSpend, type SpendRequest } from "./ConfirmSpend";
import { ResultCard } from "./ResultCard";
import { useToast } from "./useToast";

type Sim = InstanceType<typeof engine.DeadBridge>;

/** Input-log ops, as the engine reads them (3 bytes: ticks since last, op, arg). */
const OP_AIM = 0;
const OP_USE = 1;
const OP_BUY = 2;
const OP_WAIT = 3;
/** Aim changes are recorded at most this often (ticks), so a long level's log stays small. */
const AIM_EVERY = 2;

interface Hud {
  wave: number;
  waves: number;
  spawned: number;
  spawns: number;
  hp: number;
  maxHp: number;
  kills: number;
  charges: number[];
  gun: number;
  /** Ticks left: gun, left turret, right turret, tank, mech, barricade. */
  timers: number[];
}

/** Records the player's inputs exactly as the server will replay them. */
class InputRecorder {
  private bytes: number[] = [];
  private last = 0;

  push(at: number, op: number, arg: number): void {
    let gap = at - this.last;
    while (gap > 255) {
      this.bytes.push(255, OP_WAIT, 0);
      gap -= 255;
    }
    this.bytes.push(gap, op, arg);
    this.last = at;
  }

  base64(): string {
    let s = "";
    for (const b of this.bytes) s += String.fromCharCode(b);
    return btoa(s);
  }
}

function readHud(sim: Sim): Hud {
  const h = sim.hud();
  return {
    hp: h[HUD.hp] ?? 0,
    maxHp: h[HUD.maxHp] ?? 1,
    wave: h[HUD.wave] ?? 1,
    waves: h[HUD.waves] ?? 3,
    spawned: h[HUD.spawned] ?? 0,
    spawns: h[HUD.spawns] ?? 1,
    kills: h[HUD.kills] ?? 0,
    charges: Array.from(sim.charges()),
    gun: h[HUD.gun] ?? 0,
    timers: Array.from(h.slice(HUD.timers, HUD.timers + 6)),
  };
}

export function DeadBridgeScreen({
  level,
  onBack,
  onLevel,
  onCheckpoint,
}: {
  level: number;
  onBack: () => void;
  onLevel: (level: number) => void;
  onCheckpoint: () => void;
}) {
  const { refresh, me } = useSession();
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<DeadBridgeView | null>(null);
  const game = useRef<{
    start: DbStart;
    sim: Sim;
    rec: InputRecorder;
    lane: number;
    recordedLane: number;
    aimAt: number;
    pendingUse: number[];
    over: boolean;
    spent: number;
  } | null>(null);
  const [round, setRound] = useState(0);
  const [info, setInfo] = useState<DbStart | null>(null);
  const [hud, setHud] = useState<Hud | null>(null);
  const [coins, setCoins] = useState<number | undefined>(undefined);
  const [paused, setPaused] = useState(false);
  const [intro, setIntro] = useState(level <= 3);
  const [result, setResult] = useState<DbComplete | null>(null);
  const [lost, setLost] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<(SpendRequest & { kind: number }) | null>(null);
  const [buying, setBuying] = useState(false);
  const [toast, showToast] = useToast();
  const replay = me ? me.games["dead-bridge"].stars[String(level)] !== undefined : false;

  // The game is paused whenever a card or dialog is open.
  const halted = paused || intro || !!pending || !!result || lost;
  useEffect(() => {
    view.current?.setPaused(halted);
  }, [halted, info]);

  useEffect(() => {
    let cancelled = false;
    let created: DeadBridgeView | null = null;
    setInfo(null);
    setResult(null);
    setLost(false);
    setError(null);
    setHud(null);

    const finish = async (won: boolean) => {
      const g = game.current;
      if (!g || g.over) return;
      g.over = true;
      if (!won) {
        sfx.lose();
        haptic(60);
        setLost(true);
        // Losses are reported too (for level balancing); the server answers "not won".
        void api.db.complete(level, g.start.attempt_id, g.rec.base64()).catch(() => undefined);
        return;
      }
      try {
        const res = await api.db.complete(level, g.start.attempt_id, g.rec.base64());
        if (cancelled) return;
        sfx.win();
        haptic(40);
        setResult(res);
        setCoins(res.coins);
        void refresh();
        if (res.registration_required) onCheckpoint();
      } catch (e) {
        setError(e instanceof ApiError ? e.message : "Could not save this result.");
      }
    };

    const tick = () => {
      const g = game.current;
      if (!g || g.over) return;
      const at = g.sim.tick();
      if (g.lane !== g.recordedLane && at - g.aimAt >= AIM_EVERY) {
        g.sim.setAim(g.lane);
        g.rec.push(at, OP_AIM, g.lane);
        g.recordedLane = g.lane;
        g.aimAt = at;
      }
      for (const k of g.pendingUse.splice(0)) {
        if (g.sim.useAssist(k)) g.rec.push(at, OP_USE, k);
      }
      g.sim.step();
      view.current?.handleEvents(g.sim.takeEvents());
      const status = g.sim.status();
      if (status !== 0) void finish(status === 1);
    };

    (async () => {
      await loadEngine();
      const start = await api.db.start(level);
      if (cancelled || !host.current) return;
      const sim = new engine.DeadBridge(JSON.stringify(start.script));
      game.current = {
        start,
        sim,
        rec: new InputRecorder(),
        lane: 128,
        recordedLane: 128,
        aimAt: -AIM_EVERY,
        pendingUse: [],
        over: false,
        spent: 0,
      };
      created = await DeadBridgeView.create(host.current, dbConstants(), sim, {
        onAim: (lane) => {
          if (game.current) game.current.lane = lane;
        },
        onTick: tick,
      });
      if (cancelled) {
        created.destroy();
        return;
      }
      view.current = created;
      created.setPaused(true);
      setInfo(start);
      setCoins(start.coins);
      setHud(readHud(sim));
    })().catch((e: unknown) => {
      if (!cancelled) setError(e instanceof ApiError ? e.message : "Could not load this level.");
    });

    // The HUD (bars, charges) refreshes ten times a second; the canvas runs at full rate.
    const hudTimer = window.setInterval(() => {
      const g = game.current;
      if (g) setHud(readHud(g.sim));
    }, 100);

    return () => {
      cancelled = true;
      window.clearInterval(hudTimer);
      created?.destroy();
      view.current = null;
      game.current?.sim.free();
      game.current = null;
    };
  }, [level, round, refresh, onCheckpoint]);

  const fireAssist = (kind: number) => {
    const g = game.current;
    if (!g || g.over || !info) return;
    if ((g.sim.charges()[kind] ?? 0) > 0) {
      g.pendingUse.push(kind);
      return;
    }
    const a = ASSISTS[kind];
    if (!a) return;
    setPending({
      kind,
      title: a.name,
      what: ASSIST_WHAT[kind] ?? "",
      price: info.prices[a.key as DbAssist],
      balance: coins ?? 0,
      reward: replay ? null : info.reward,
      spent: g.spent,
      note: "The game is paused while you decide.",
    });
  };

  const confirmSpend = async () => {
    const g = game.current;
    const p = pending;
    const a = p ? ASSISTS[p.kind] : undefined;
    if (!g || !p || !a) return;
    setBuying(true);
    try {
      const res = await api.db.buy(level, g.start.attempt_id, a.key as DbAssist, p.price);
      setCoins(res.coins);
      g.spent = res.spent;
      // A bought charge is recorded like any input, then fired at once.
      if (g.sim.buyAssist(p.kind)) {
        g.rec.push(g.sim.tick(), OP_BUY, p.kind);
        g.pendingUse.push(p.kind);
      }
      void refresh();
    } catch (e) {
      showToast(e instanceof ApiError ? e.message : "Could not buy that right now.");
    } finally {
      setBuying(false);
      setPending(null);
    }
  };

  // Laptop controls: arrows / A-D steer, 1-7 fire assists, P pauses.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const g = game.current;
      if (!g) return;
      if (e.key === "ArrowLeft" || e.key === "a" || e.key === "A") g.lane = Math.max(0, g.lane - 14);
      else if (e.key === "ArrowRight" || e.key === "d" || e.key === "D") g.lane = Math.min(255, g.lane + 14);
      else if (e.key >= "1" && e.key <= String(ASSISTS.length)) fireAssist(Number(e.key) - 1);
      else if (e.key === "p" || e.key === "P" || e.key === "Escape") setPaused((v) => !v);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const count = me?.games["dead-bridge"].level_count ?? 0;
  const hpPct = hud ? Math.max(0, hud.hp / hud.maxHp) : 1;
  const wavePct = hud ? hud.spawned / Math.max(1, hud.spawns) : 0;
  const winDetail = (r: DbComplete) => {
    const parts = [`${r.kills} zombies · ${r.base_hp} HP left`];
    if (!r.first_clear) parts.push("replay: no coins");
    else {
      parts.push(`+${r.coins_earned} coins`);
      if (r.streak_bonus) parts.push(`+${r.streak_bonus} streak bonus`);
    }
    return parts.join(" · ");
  };

  return (
    <div className="relative flex h-full flex-col bg-[#0c1220]">
      <TopBar
        title={
          <>
            <span className="min-[430px]:hidden">Lv </span>
            <span className="hidden min-[430px]:inline">Level </span>
            {level}
          </>
        }
        onBack={onBack}
        right={
          <div className="flex items-center gap-2">
            <CoinChip balance={coins} />
            <IconButton label={paused ? "Resume" : "Pause"} onClick={() => setPaused((v) => !v)} disabled={!info}>
              <span className="text-base font-black">{paused ? "▶" : "❚❚"}</span>
            </IconButton>
          </div>
        }
      />
      {/* Wave progress and base health, like the key art. */}
      <div className="grid grid-cols-2 gap-3 px-4 pb-2 text-[11px] font-bold">
        <div>
          <div className="mb-1 flex justify-between text-amber-200">
            <span>
              Wave {hud?.wave ?? 1}/{hud?.waves ?? 3}
            </span>
            <span>{hud?.kills ?? 0} down</span>
          </div>
          <div className="h-2.5 overflow-hidden rounded-full bg-black/50 ring-1 ring-amber-300/30">
            <div className="h-full rounded-full bg-gradient-to-r from-amber-400 to-orange-500 transition-[width]" style={{ width: `${wavePct * 100}%` }} />
          </div>
        </div>
        <div>
          <div className="mb-1 flex justify-between text-emerald-200">
            <span>Base</span>
            <span>
              {hud?.hp ?? "–"}/{hud?.maxHp ?? "–"} HP
            </span>
          </div>
          <div className="h-2.5 overflow-hidden rounded-full bg-black/50 ring-1 ring-emerald-300/30">
            <div
              className={`h-full rounded-full transition-[width] ${hpPct > 0.5 ? "bg-emerald-400" : hpPct > 0.25 ? "bg-amber-400" : "bg-red-500"}`}
              style={{ width: `${hpPct * 100}%` }}
            />
          </div>
        </div>
      </div>
      {/* Upgrades from cages, each with the time it has left. */}
      <div className="flex min-h-6 flex-wrap justify-center gap-1.5 px-3 pb-1.5">
        {hud &&
          upgrades(hud).map((u) => (
            <span key={u.key} className="relative overflow-hidden rounded-full bg-black/45 px-2.5 py-0.5 text-[10px] font-black ring-1 ring-white/15">
              <span
                className="absolute inset-y-0 left-0 opacity-35"
                style={{ width: `${u.left * 100}%`, background: `#${u.color.toString(16).padStart(6, "0")}` }}
              />
              <span className="relative">{u.label}</span>
            </span>
          ))}
      </div>
      <div className="relative min-h-0 flex-1 touch-none">
        <div ref={host} className="game-surface absolute inset-0" />
        {intro && info && (
          <div className="absolute inset-0 z-10 grid place-items-center bg-ink/70 p-6">
            <div className="pop-in w-full max-w-sm rounded-3xl border border-line bg-panel p-5 text-center shadow-2xl">
              <h2 className="text-2xl font-black">Hold the bridge!</h2>
              <ul className="my-4 grid gap-2 text-left text-sm text-muted">
                <li>👆 Drag (or move the mouse) to steer your gunner. Firing is automatic.</li>
                <li>🟨 Shoot the gold cages for new guns, turrets, a tank or a mech. They last about 25 seconds.</li>
                <li>📦 Break the glowing crates for assists before they fade, then tap them below.</li>
                <li>🧟 Don't let the horde reach the sandbags.</li>
              </ul>
              <Button className="w-full" onClick={() => setIntro(false)}>
                Start
              </Button>
            </div>
          </div>
        )}
        {paused && !intro && !result && !lost && (
          <div className="absolute inset-0 z-10 grid place-items-center bg-ink/60">
            <Button onClick={() => setPaused(false)}>Resume</Button>
          </div>
        )}
      </div>
      <div className="flex justify-center gap-1 px-1.5 pb-[max(env(safe-area-inset-bottom),10px)] pt-2 sm:gap-2">
        {ASSISTS.map((a, k) => {
          const charges = hud?.charges[k] ?? 0;
          return (
            <button
              key={a.key}
              type="button"
              disabled={!info || !!result || lost}
              onClick={() => fireAssist(k)}
              className={`relative flex min-h-14 min-w-0 max-w-24 flex-1 flex-col items-center justify-center rounded-2xl border px-0.5 py-1 text-[9px] font-bold transition active:scale-95 disabled:opacity-40 sm:text-[10px] ${
                charges > 0 ? "border-amber-300/60 bg-amber-400/15" : "border-line bg-panel-2"
              }`}
              style={charges > 0 ? { boxShadow: `0 0 14px #${a.color.toString(16)}55` } : undefined}
            >
              <span className="text-lg leading-none" style={{ color: `#${a.color.toString(16)}` }}>
                {a.glyph}
              </span>
              <span className="max-w-full truncate">{a.name}</span>
              <span className={charges > 0 ? "text-amber-200" : "text-gold"}>
                {charges > 0 ? `×${charges}` : `${info?.prices[a.key as DbAssist] ?? "…"}c`}
              </span>
              <span className="absolute left-1 top-0.5 text-[9px] text-muted max-sm:hidden">{k + 1}</span>
            </button>
          );
        })}
      </div>
      {error && (
        <p className="absolute inset-x-5 bottom-24 rounded-xl bg-red-500/20 p-3 text-center text-sm text-red-200">{error}</p>
      )}
      {toast && <p className="absolute inset-x-5 bottom-24 rounded-xl bg-panel-2 p-3 text-center text-sm">{toast}</p>}
      <ConfirmSpend request={pending} busy={buying} onConfirm={() => void confirmSpend()} onCancel={() => setPending(null)} />
      {(result || lost) && (
        <ResultCard
          won={!!result}
          stars={result?.stars ?? 0}
          detail={result ? winDetail(result) : "The horde broke through."}
          hasNext={!!result && level < count && result.unlocked_level > level}
          onNext={() => onLevel(level + 1)}
          onRetry={() => setRound((r) => r + 1)}
          onLevels={onBack}
        />
      )}
    </div>
  );
}

const ASSIST_WHAT = [
  "Bombs walk across the front of the horde.",
  "The whole horde freezes for 3 seconds and takes double damage.",
  "Three drones zap the toughest zombies for 5 seconds.",
  "A beam from orbit down your gunner's lane.",
  "A burning carpet across the lower bridge for 4 seconds.",
  "Twelve rockets on the toughest zombies.",
  "Hits everything on the bridge at once.",
];

const UNIT_NAMES = ["", "Left turret", "Right turret", "Tank", "Mech", "Barricade"];
const UNIT_COLORS = [0, 0x84cc16, 0x84cc16, 0x65a30d, 0x38bdf8, 0x60a5fa];

/** Active cage upgrades, with the share of their time left. */
function upgrades(hud: Hud): { key: number; label: string; color: number; left: number }[] {
  const { timerTicks: full, tps } = dbConstants();
  const out = [];
  for (let k = 0; k < hud.timers.length; k++) {
    const t = hud.timers[k] ?? 0;
    if (t <= 0) continue;
    const gun = GUNS[hud.gun];
    const label = k === 0 ? (gun?.name ?? "Gun") : (UNIT_NAMES[k] ?? "");
    const color = k === 0 ? (gun?.color ?? 0xffffff) : (UNIT_COLORS[k] ?? 0xffffff);
    out.push({ key: k, label: `${label} ${Math.ceil(t / tps)}s`, color, left: t / (full[k] ?? t) });
  }
  return out;
}
