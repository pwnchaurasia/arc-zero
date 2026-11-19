import { useCallback, useEffect, useRef, useState } from "react";

import { haptic, sfx } from "../feel/audio";
import { type Hud, NeonCoilView, type RunStats } from "../games/neoncoil/NeonCoilView";
import { loadSaved, newlyUnlocked, save, type Skin, SKINS, skinById, unlocked } from "../games/neoncoil/skins";
import type { Dir, StepEvent } from "../games/neoncoil/snake";
import { LockIcon, PauseIcon, PlayIcon, RestartIcon } from "../ui/icons";
import { Button, IconButton, TopBar } from "../ui/kit";

const KEYS: Record<string, Dir> = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  w: "up",
  s: "down",
  a: "left",
  d: "right",
  W: "up",
  S: "down",
  A: "left",
  D: "right",
};
/** A finger moving this far (px) is a swipe; keep moving and it can steer again. */
const SWIPE_PX = 22;
const PAD_KEY = "arc.neoncoil.pad";
const hex = (n: number) => `#${n.toString(16).padStart(6, "0")}`;

type Overlay = "ready" | "paused" | "over" | null;

function readPad(): boolean {
  try {
    return localStorage.getItem(PAD_KEY) === "1";
  } catch {
    return false;
  }
}

function SkinSwatch({ skin, size = 40 }: { skin: Skin; size?: number }) {
  return (
    <span
      aria-hidden="true"
      className="block rounded-full"
      style={{
        width: size,
        height: size * 0.42,
        background: `linear-gradient(90deg, ${hex(skin.tail)}, ${hex(skin.head)})`,
        boxShadow: `0 0 14px ${hex(skin.glow)}88`,
      }}
    />
  );
}

function SkinPicker({ best, chosen, onPick }: { best: number; chosen: string; onPick: (s: Skin) => void }) {
  return (
    <div role="radiogroup" aria-label="Snake skin" className="grid grid-cols-3 gap-2">
      {SKINS.map((s) => {
        const open = unlocked(s, best);
        const on = s.id === chosen;
        return (
          <button
            key={s.id}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={open ? s.name : `${s.name}: locked, best ${s.unlock} to unlock`}
            disabled={!open}
            onClick={() => {
              sfx.unlock();
              sfx.tap();
              onPick(s);
            }}
            className={`flex flex-col items-center gap-1.5 rounded-2xl border px-1 py-2.5 transition active:scale-95 ${
              on ? "border-white/70 bg-white/10" : "border-line bg-panel-2/60 hover:bg-panel-2"
            } ${open ? "" : "opacity-55"}`}
          >
            <SkinSwatch skin={s} />
            <span className="text-[11px] font-semibold leading-tight">{s.name}</span>
            <span className="flex items-center gap-1 text-[10px] text-muted">
              {open ? (on ? "Equipped" : "Tap to use") : (
                <>
                  <LockIcon size={11} /> best {s.unlock}
                </>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-2xl bg-panel-2/70 px-3 py-2 text-center">
      <p className="text-lg font-bold tabular-nums">{value}</p>
      <p className="text-[11px] uppercase tracking-wider text-muted">{label}</p>
    </div>
  );
}

function PadButton({ dir, onTurn, children }: { dir: Dir; onTurn: (d: Dir) => void; children: string }) {
  return (
    <button
      type="button"
      aria-label={`Turn ${dir}`}
      onPointerDown={(e) => {
        e.stopPropagation();
        onTurn(dir);
      }}
      className="grid size-14 place-items-center rounded-2xl border border-line bg-panel-2/80 text-xl text-white shadow-lg active:scale-90 active:bg-line"
    >
      {children}
    </button>
  );
}

export function NeonCoilScreen({ onBack }: { onBack: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<NeonCoilView | null>(null);
  const [saved, setSaved] = useState(loadSaved);
  const [hud, setHud] = useState<Hud>({ score: 0, length: 4, speed: 1, combo: 1, comboLeft: 0 });
  const [overlay, setOverlay] = useState<Overlay>("ready");
  const [result, setResult] = useState<{ stats: RunStats; newBest: boolean; unlockedNow: Skin[] } | null>(null);
  const [pad, setPad] = useState(readPad);
  const [toast, setToast] = useState<string | null>(null);
  const savedRef = useRef(saved);
  savedRef.current = saved;

  const onEvent = useCallback((e: StepEvent) => {
    if (e.ate) {
      if (e.ate.food.golden) sfx.golden();
      else sfx.chomp(e.ate.combo);
      haptic(e.ate.food.golden ? 25 : 10);
    }
    if (e.speedUp) sfx.speedUp();
    if (e.died) {
      sfx.crash();
      haptic(120);
    }
  }, []);

  const onOver = useCallback((stats: RunStats) => {
    const before = savedRef.current.best;
    const newBest = stats.score > before;
    const unlockedNow = newBest ? newlyUnlocked(before, stats.score) : [];
    if (newBest) {
      save({ best: stats.score });
      setSaved((s) => ({ ...s, best: stats.score }));
      sfx.win();
    }
    setResult({ stats, newBest, unlockedNow });
    setOverlay("over");
  }, []);

  useEffect(() => {
    let alive = true;
    let made: NeonCoilView | null = null;
    if (!host.current) return;
    void NeonCoilView.create(host.current, skinById(savedRef.current.skin), { onHud: setHud, onEvent, onOver }).then((v) => {
      if (!alive) return v.destroy();
      made = v;
      view.current = v;
    });
    return () => {
      alive = false;
      made?.destroy();
      view.current = null;
    };
  }, [onEvent, onOver]);

  const play = useCallback(() => {
    sfx.unlock();
    const v = view.current;
    if (!v) return;
    if (v.state === "over" || v.state === "dying") v.reset();
    setResult(null);
    setOverlay(null);
    v.start();
  }, []);

  const pause = useCallback(() => {
    const v = view.current;
    if (v?.state !== "running") return;
    v.pause();
    setOverlay("paused");
  }, []);

  const restart = useCallback(() => {
    view.current?.reset();
    setOverlay("ready");
  }, []);

  const turn = useCallback((d: Dir) => {
    const v = view.current;
    if (!v) return;
    if (v.state === "ready") {
      sfx.unlock();
      setOverlay(null);
    }
    v.turn(d);
  }, []);

  // Keyboard: arrows/WASD steer, Space/P/Esc pause, Enter plays.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const v = view.current;
      if (!v) return;
      const d = KEYS[e.key];
      if (d && (v.state === "running" || v.state === "ready")) {
        e.preventDefault();
        turn(d);
        return;
      }
      if (e.key === " " || e.key === "p" || e.key === "P" || e.key === "Escape") {
        if (v.state === "running") {
          e.preventDefault();
          pause();
        } else if (v.state === "paused" && e.key !== "Escape") {
          e.preventDefault();
          play();
        }
      } else if (e.key === "Enter" && v.state === "over" && document.activeElement === document.body) {
        play();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [turn, pause, play]);

  // Leaving the tab (or locking the phone) pauses.
  useEffect(() => {
    const onHide = () => document.hidden && pause();
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("blur", pause);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("blur", pause);
    };
  }, [pause]);

  // Swipe anywhere on the game: each 22px of travel can steer again without lifting.
  const swipe = useRef<{ x: number; y: number; id: number } | null>(null);
  const onPointerDown = (e: React.PointerEvent) => {
    if (overlay && overlay !== "ready") return;
    swipe.current = { x: e.clientX, y: e.clientY, id: e.pointerId };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const s = swipe.current;
    if (!s || s.id !== e.pointerId) return;
    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < SWIPE_PX) return;
    turn(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : dy > 0 ? "down" : "up");
    swipe.current = { x: e.clientX, y: e.clientY, id: e.pointerId };
  };
  const onPointerUp = () => {
    swipe.current = null;
  };

  const pickSkin = (s: Skin) => {
    save({ skin: s.id });
    setSaved((x) => ({ ...x, skin: s.id }));
    view.current?.setSkin(s);
  };

  const togglePad = () => {
    const next = !pad;
    setPad(next);
    try {
      localStorage.setItem(PAD_KEY, next ? "1" : "0");
    } catch {
      // not remembered
    }
    setToast(next ? "D-pad on" : "Swipe controls");
    setTimeout(() => setToast(null), 1200);
  };

  const skin = skinById(saved.skin);
  const fever = hud.combo >= 5 && hud.comboLeft > 0;
  const running = overlay === null;

  return (
    <div className="flex h-full flex-col bg-[radial-gradient(ellipse_at_top,#131a3a_0%,#0b1020_60%)]">
      <TopBar
        title={<span className="tracking-wide">NeonCoil</span>}
        onBack={onBack}
        right={
          <div className="flex gap-2">
            <IconButton label={pad ? "Use swipes" : "Show D-pad"} onClick={togglePad} className={pad ? "text-accent" : ""}>
              <span aria-hidden="true" className="text-lg leading-none">✛</span>
            </IconButton>
            <IconButton label="Pause" onClick={pause} disabled={!running}>
              <PauseIcon />
            </IconButton>
          </div>
        }
      />

      {/* Score strip */}
      <div className="flex w-full items-end gap-3 px-4 pb-2 sm:px-6">
        <div className="min-w-0">
          <p className="text-[11px] uppercase tracking-[0.2em] text-muted">Score</p>
          <p data-testid="nc-score" className="text-3xl font-black tabular-nums leading-none" style={{ textShadow: `0 0 18px ${hex(skin.glow)}aa` }}>
            {hud.score}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <span
            className={`relative overflow-hidden rounded-full px-3 py-1 text-sm font-bold tabular-nums transition ${
              hud.combo > 1 ? (fever ? "nc-fever bg-fuchsia-500/25 text-fuchsia-200" : "bg-white/10 text-white") : "bg-white/5 text-muted"
            }`}
            aria-label={`Combo ${hud.combo}x`}
          >
            {fever ? "FEVER " : ""}×{hud.combo}
            <span
              className="absolute bottom-0 left-0 h-0.5 bg-current transition-[width] duration-200 ease-linear"
              style={{ width: `${hud.comboLeft * 100}%` }}
            />
          </span>
          <span className="rounded-full bg-white/5 px-3 py-1 text-sm font-semibold text-muted" aria-label={`Speed ${hud.speed}`}>
            ⚡{hud.speed}
          </span>
          <span className="rounded-full bg-white/5 px-3 py-1 text-sm font-semibold text-muted">
            best <span className="tabular-nums text-white">{Math.max(saved.best, hud.score)}</span>
          </span>
        </div>
      </div>

      <div
        className="game-surface relative min-h-0 flex-1"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <div ref={host} className="absolute inset-0" data-testid="nc-board" />

        {toast && (
          <div className="pop-in pointer-events-none absolute left-1/2 top-3 -translate-x-1/2 rounded-full bg-black/70 px-4 py-1.5 text-sm">{toast}</div>
        )}

        {overlay === "ready" && (
          <div className="absolute inset-0 grid place-items-center p-4">
            <div className="pop-in w-full max-w-sm rounded-3xl border border-white/10 bg-panel/85 p-5 shadow-2xl backdrop-blur-md">
              <div className="mb-4 flex items-center gap-3">
                <img src="/games/neoncoil.webp" alt="" className="size-14 rounded-2xl object-cover" />
                <div>
                  <h2 className="text-xl font-black tracking-wide">NeonCoil</h2>
                  <p className="text-sm text-muted">Eat, grow, survive. It only gets faster.</p>
                </div>
              </div>
              <SkinPicker best={saved.best} chosen={saved.skin} onPick={pickSkin} />
              <Button className="mt-4 w-full text-lg" onClick={play} autoFocus>
                <PlayIcon size={20} /> Play
              </Button>
              <p className="mt-3 text-center text-xs text-muted">
                Swipe or use arrow keys · golden fruit = 50 · chain bites for FEVER ×5
              </p>
            </div>
          </div>
        )}

        {overlay === "paused" && (
          <div className="absolute inset-0 grid place-items-center bg-ink/60 p-4 backdrop-blur-sm">
            <div className="pop-in w-full max-w-xs rounded-3xl border border-white/10 bg-panel/90 p-5 text-center shadow-2xl">
              <h2 className="mb-4 text-2xl font-black tracking-widest">PAUSED</h2>
              <Button className="w-full" onClick={play} autoFocus>
                <PlayIcon size={18} /> Resume
              </Button>
              <Button variant="secondary" className="mt-2 w-full" onClick={restart}>
                <RestartIcon size={18} /> Restart
              </Button>
            </div>
          </div>
        )}

        {overlay === "over" && result && (
          <div className="absolute inset-0 grid place-items-center bg-ink/55 p-4 backdrop-blur-sm" role="dialog" aria-label="Game over">
            <div className="pop-in w-full max-w-sm rounded-3xl border border-white/10 bg-panel/90 p-5 text-center shadow-2xl">
              {result.newBest ? (
                <p className="nc-best mb-1 text-sm font-black tracking-[0.3em] text-gold">NEW BEST!</p>
              ) : (
                <p className="mb-1 text-sm font-bold tracking-[0.3em] text-muted">GAME OVER</p>
              )}
              <p data-testid="nc-final" className="text-6xl font-black tabular-nums" style={{ textShadow: `0 0 28px ${hex(skin.glow)}` }}>
                {result.stats.score}
              </p>
              <p className="mb-4 text-sm text-muted">best {saved.best}</p>
              <div className="grid grid-cols-4 gap-2">
                <Stat label="length" value={result.stats.length} />
                <Stat label="time" value={`${Math.floor(result.stats.seconds / 60)}:${String(result.stats.seconds % 60).padStart(2, "0")}`} />
                <Stat label="fruit" value={result.stats.eaten} />
                <Stat label="combo" value={`×${result.stats.maxCombo}`} />
              </div>
              {result.unlockedNow.length > 0 && (
                <div className="mt-4 rounded-2xl border border-gold/40 bg-gold/10 p-3">
                  <p className="mb-2 text-xs font-bold uppercase tracking-widest text-gold">New skin unlocked</p>
                  <div className="flex flex-wrap justify-center gap-3">
                    {result.unlockedNow.map((s) => (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() => pickSkin(s)}
                        className="flex items-center gap-2 rounded-full bg-panel-2 px-3 py-1.5 text-sm font-semibold"
                      >
                        <SkinSwatch skin={s} size={28} /> {s.id === saved.skin ? `${s.name} ✓` : `Use ${s.name}`}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <Button className="mt-4 w-full text-lg" onClick={play} autoFocus>
                <RestartIcon size={20} /> Play again
              </Button>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <Button variant="secondary" onClick={restart}>
                  Skins
                </Button>
                <Button variant="secondary" onClick={onBack}>
                  Home
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>

      {pad && (
        <div className="grid shrink-0 place-items-center py-2" aria-label="D-pad">
          <div className="grid grid-cols-3 gap-1.5">
            <span />
            <PadButton dir="up" onTurn={turn}>▲</PadButton>
            <span />
            <PadButton dir="left" onTurn={turn}>◀</PadButton>
            <span />
            <PadButton dir="right" onTurn={turn}>▶</PadButton>
            <span />
            <PadButton dir="down" onTurn={turn}>▼</PadButton>
            <span />
          </div>
        </div>
      )}
    </div>
  );
}
