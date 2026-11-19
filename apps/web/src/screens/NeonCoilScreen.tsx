import { useCallback, useEffect, useRef, useState } from "react";

import { haptic, sfx } from "../feel/audio";
import { fruitGoal, LEVEL_COUNT, layoutNames, SPEED_EVERY } from "../games/neoncoil/levels";
import { type LevelResult, NeonCoilView } from "../games/neoncoil/NeonCoilView";
import {
  chooseSkin,
  loadSaved,
  newlyUnlocked,
  openLevel,
  recordClear,
  type Saved,
  type Skin,
  SKINS,
  skinById,
  totalStars,
  unlocked,
} from "../games/neoncoil/skins";
import type { Dir } from "../games/neoncoil/snake";
import { LockIcon, PauseIcon, PlayIcon, RestartIcon } from "../ui/icons";
import { Button, IconButton, Stars, TopBar } from "../ui/kit";

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
const SWIPE_PX = 18;
const PAD_KEY = "arc.neoncoil.pad";
const hex = (n: number) => `#${n.toString(16).padStart(6, "0")}`;

/** The on-screen arrows are shown unless the player turned them off. */
function readPad(): boolean {
  try {
    return localStorage.getItem(PAD_KEY) !== "0";
  } catch {
    return true;
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

// ------------------------------------------------------------------ level map

function LevelMap({
  saved,
  onPlay,
  onBack,
  onSkin,
}: {
  saved: Saved;
  onPlay: (level: number) => void;
  onBack: () => void;
  onSkin: (s: Skin) => void;
}) {
  const stars = totalStars(saved);
  const open = openLevel(saved);
  const next = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    next.current?.scrollIntoView({ block: "center" });
  }, []);
  return (
    <div className="flex h-full flex-col bg-[radial-gradient(ellipse_at_top,#131a3a_0%,#0b1020_60%)]">
      <TopBar
        title="NeonCoil"
        onBack={onBack}
        right={
          <span className="rounded-full bg-white/10 px-3 py-1.5 text-sm font-bold tabular-nums" aria-label={`${stars} stars`}>
            ★ {stars}/{LEVEL_COUNT * 3}
          </span>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-28">
        <div className="mx-auto max-w-3xl">
          <h2 className="mb-2 text-xs font-bold uppercase tracking-widest text-muted">Skin</h2>
          <div role="radiogroup" aria-label="Snake skin" className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4 pb-1">
            {SKINS.map((s) => {
              const ok = unlocked(s, stars);
              const on = s.id === saved.skin;
              return (
                <button
                  key={s.id}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  aria-label={ok ? s.name : `${s.name}: locked, ${s.unlock} stars to unlock`}
                  disabled={!ok}
                  onClick={() => {
                    sfx.unlock();
                    sfx.tap();
                    onSkin(s);
                  }}
                  className={`flex w-28 shrink-0 flex-col items-center gap-1.5 rounded-2xl border px-2 py-2.5 transition active:scale-95 ${
                    on ? "border-white/70 bg-white/10" : "border-line bg-panel-2/60"
                  } ${ok ? "" : "opacity-50"}`}
                >
                  <SkinSwatch skin={s} />
                  <span className="text-[11px] font-semibold leading-tight">{s.name}</span>
                  <span className="flex items-center gap-1 text-[10px] text-muted">
                    {ok ? (on ? "Equipped" : "Tap to use") : (
                      <>
                        <LockIcon size={11} /> {s.unlock}★
                      </>
                    )}
                  </span>
                </button>
              );
            })}
          </div>

          <h2 className="mb-2 mt-5 text-xs font-bold uppercase tracking-widest text-muted">Levels</h2>
          <div className="grid grid-cols-5 gap-2 sm:grid-cols-6 md:grid-cols-10">
            {Array.from({ length: LEVEL_COUNT }, (_, i) => i + 1).map((n) => {
              const got = saved.stars[n] ?? 0;
              const locked = n > open;
              const current = n === open && got === 0;
              return (
                <button
                  key={n}
                  ref={current ? next : undefined}
                  type="button"
                  aria-label={locked ? `Level ${n}, locked` : `Level ${n}`}
                  disabled={locked}
                  onClick={() => {
                    sfx.unlock();
                    sfx.tap();
                    onPlay(n);
                  }}
                  className={`flex aspect-square flex-col items-center justify-center gap-0.5 rounded-2xl border text-lg font-black transition active:scale-95 ${
                    current
                      ? "nc-current border-accent bg-accent/15 text-white"
                      : locked
                        ? "border-line/60 bg-panel/60 text-muted/60"
                        : "border-line bg-panel-2 text-white hover:bg-line"
                  }`}
                >
                  {locked ? <LockIcon size={16} /> : n}
                  {!locked && <Stars count={got} size={11} />}
                </button>
              );
            })}
          </div>
          <p className="mt-4 text-center text-xs text-muted">
            Eat 20-25 fruit to clear a level. It speeds up every {SPEED_EVERY} fruit. ★★★ for short routes.
          </p>
        </div>
      </div>
      <div className="pointer-events-none fixed inset-x-0 bottom-0 bg-gradient-to-t from-ink via-ink/90 to-transparent px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-6">
        <Button className="pointer-events-auto mx-auto flex w-full max-w-sm text-lg" onClick={() => onPlay(open)}>
          <PlayIcon size={20} /> Play level {open}
        </Button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ playing

function PadButton({
  dir,
  onTurn,
  className,
  children,
}: {
  dir: Dir;
  onTurn: (d: Dir) => void;
  className: string;
  children: string;
}) {
  const [lit, setLit] = useState(false);
  const flash = () => {
    setLit(true);
    setTimeout(() => setLit(false), 120);
  };
  return (
    <button
      type="button"
      aria-label={`Turn ${dir}`}
      onPointerDown={(e) => {
        // Act on touch-down, not on release: no waiting for a click.
        e.preventDefault();
        e.stopPropagation();
        // Let the finger slide onto another arrow (a touch is otherwise held by the
        // first element it pressed).
        if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
        flash();
        onTurn(dir);
      }}
      onPointerEnter={(e) => {
        // Rolling a held finger (or a pressed mouse) onto this arrow turns too.
        if (e.buttons === 0 && e.pointerType === "mouse") return;
        if (e.pointerType !== "mouse" || e.buttons > 0) {
          flash();
          onTurn(dir);
        }
      }}
      onContextMenu={(e) => e.preventDefault()}
      className={`grid touch-none select-none place-items-center rounded-2xl border text-2xl text-white shadow-lg ${className} ${
        lit ? "scale-90 border-accent bg-accent/30" : "border-line bg-panel-2/90"
      } transition-transform duration-75`}
    >
      {children}
    </button>
  );
}

type Overlay = "paused" | "result" | null;

function Play({
  level,
  saved,
  onSaved,
  onMap,
  onLevel,
}: {
  level: number;
  saved: Saved;
  onSaved: (s: Saved) => void;
  onMap: () => void;
  onLevel: (n: number) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<NeonCoilView | null>(null);
  const [eaten, setEaten] = useState(0);
  const [speed, setSpeed] = useState(1);
  const goal = fruitGoal(level);
  const [ready, setReady] = useState(true);
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [result, setResult] = useState<(LevelResult & { unlockedNow: Skin[] }) | null>(null);
  const [pad, setPad] = useState(readPad);
  const savedRef = useRef(saved);
  savedRef.current = saved;
  const eatenRef = useRef(0);

  // A new skin (picked on the result card) applies at once.
  useEffect(() => {
    view.current?.setSkin(skinById(saved.skin));
  }, [saved.skin]);

  const onEnd = useCallback(
    (r: LevelResult) => {
      let unlockedNow: Skin[] = [];
      if (r.cleared) {
        const before = totalStars(savedRef.current);
        const after = recordClear(r.level, r.stars);
        unlockedNow = newlyUnlocked(before, totalStars(after));
        onSaved(after);
        sfx.win();
      }
      setResult({ ...r, unlockedNow });
      setOverlay("result");
    },
    [onSaved],
  );

  useEffect(() => {
    let alive = true;
    let made: NeonCoilView | null = null;
    if (!host.current) return;
    void NeonCoilView.create(host.current, skinById(savedRef.current.skin), {
      onEat: (n, _goal, step) => {
        eatenRef.current = n;
        setEaten(n);
        setSpeed(step);
      },
      onStep: (e) => {
        if (e.ate) {
          // The bite gets higher with each fruit of the level.
          sfx.chomp(((eatenRef.current) % SPEED_EVERY) + 1);
          if ((eatenRef.current + 1) % SPEED_EVERY === 0) setTimeout(() => sfx.complete(), 90);
          haptic(10);
        }
        if (e.died) {
          sfx.crash();
          haptic(120);
        }
      },
      onEnd,
    }).then((v) => {
      if (!alive) return v.destroy();
      made = v;
      view.current = v;
      v.load(level);
    });
    return () => {
      alive = false;
      made?.destroy();
      view.current = null;
    };
    // The view is made once; level changes go through load() below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const restart = useCallback((n: number) => {
    view.current?.load(n);
    setResult(null);
    setOverlay(null);
    setReady(true);
    setEaten(0);
    setSpeed(1);
  }, []);

  useEffect(() => {
    restart(level);
  }, [level, restart]);

  const crashedRef = useRef(false);
  crashedRef.current = overlay === "result" && result !== null && !result.cleared;
  const turn = useCallback(
    (d: Dir) => {
      const v = view.current;
      if (!v) return;
      // After a crash, any arrow starts the level again, already moving.
      if (v.state === "done" && crashedRef.current) restart(level);
      if (v.state === "ready") {
        sfx.unlock();
        setReady(false);
      }
      v.turn(d);
    },
    [restart, level],
  );

  const padTurn = useCallback(
    (d: Dir) => {
      haptic(6);
      turn(d);
    },
    [turn],
  );

  const pause = useCallback(() => {
    if (view.current?.state !== "running") return;
    view.current.pause();
    setOverlay("paused");
  }, []);

  const resume = useCallback(() => {
    view.current?.start();
    setOverlay(null);
  }, []);

  const next = level < LEVEL_COUNT ? level + 1 : null;

  // Keyboard: arrows/WASD steer (and start), Space/P/Esc pause, Enter/Space after a level.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const v = view.current;
      if (!v) return;
      const d = KEYS[e.key];
      if (d && (v.state === "running" || v.state === "ready" || (v.state === "done" && crashedRef.current))) {
        e.preventDefault();
        turn(d);
        return;
      }
      if (e.key === " " || e.key === "p" || e.key === "P" || e.key === "Escape") {
        if (v.state === "running") {
          e.preventDefault();
          pause();
          return;
        }
        if (v.state === "paused" && e.key !== "Escape") {
          e.preventDefault();
          resume();
          return;
        }
      }
      if ((e.key === "Enter" || e.key === " ") && v.state === "done" && result) {
        e.preventDefault();
        if (result.cleared && next) onLevel(next);
        else restart(level);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [turn, pause, resume, restart, onLevel, result, next, level]);

  // Leaving the tab (or locking the phone) pauses.
  useEffect(() => {
    const onHide = () => document.hidden && pause();
    document.addEventListener("visibilitychange", onHide);
    return () => document.removeEventListener("visibilitychange", onHide);
  }, [pause]);

  // Swipe anywhere on the board; keep moving the finger to steer again.
  const swipe = useRef<{ x: number; y: number; id: number } | null>(null);
  const onPointerDown = (e: React.PointerEvent) => {
    if (overlay === "paused" || (overlay === "result" && !crashedRef.current)) return;
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
  const endSwipe = () => {
    swipe.current = null;
  };

  const togglePad = () => {
    const on = !pad;
    setPad(on);
    try {
      localStorage.setItem(PAD_KEY, on ? "1" : "0");
    } catch {
      // not remembered
    }
  };

  const skin = skinById(saved.skin);
  const best = saved.stars[level] ?? 0;
  const walls = layoutNames(level)[0] === "empty" ? "Open arena" : "Mind the walls";

  return (
    <div className="flex h-full flex-col bg-[radial-gradient(ellipse_at_top,#131a3a_0%,#0b1020_60%)]">
      <TopBar
        title={`Level ${level}`}
        onBack={onMap}
        right={
          <div className="flex gap-2">
            <IconButton label={pad ? "Hide arrows" : "Show arrows"} onClick={togglePad} className={pad ? "text-accent" : ""}>
              <span aria-hidden="true" className="text-lg leading-none">✛</span>
            </IconButton>
            <IconButton label="Pause" onClick={pause} disabled={overlay !== null || ready}>
              <PauseIcon />
            </IconButton>
          </div>
        }
      />

      <div className="flex items-center gap-3 px-4 pb-2 sm:px-6">
        <div className="min-w-0 flex-1" aria-label={`${eaten} of ${goal} fruit`} data-testid="nc-fruit">
          <div className="mb-1 flex items-baseline gap-2 text-sm">
            <span className="font-black tabular-nums">
              🍎 {eaten}/{goal}
            </span>
            <span className="truncate text-xs text-muted">{walls}</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-white/10">
            <div
              className="h-full rounded-full bg-gradient-to-r from-[#ff3d7f] to-[#facc15] transition-[width] duration-300"
              style={{ width: `${(eaten / goal) * 100}%` }}
            />
          </div>
        </div>
        <span className="rounded-full bg-white/10 px-2.5 py-1 text-sm font-bold tabular-nums" aria-label={`Speed ${speed}`}>
          ⚡{speed}
        </span>
        <Stars count={best} size={14} />
      </div>

      <div
        className="game-surface relative min-h-0 flex-1"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endSwipe}
        onPointerCancel={endSwipe}
      >
        <div ref={host} className="absolute inset-0" data-testid="nc-board" />

        {ready && overlay === null && (
          <div className="pointer-events-none absolute inset-x-0 bottom-6 flex justify-center px-4">
            <p className="pop-in rounded-full bg-black/70 px-4 py-2 text-center text-sm font-semibold backdrop-blur-sm">
              Eat {goal} 🍎 · {pad ? "tap an arrow" : "swipe"} or press an arrow key to start
            </p>
          </div>
        )}

        {overlay === "paused" && (
          <div className="absolute inset-0 grid place-items-center bg-ink/60 p-4 backdrop-blur-sm">
            <div className="pop-in w-full max-w-xs rounded-3xl border border-white/10 bg-panel/95 p-5 text-center shadow-2xl">
              <h2 className="mb-4 text-2xl font-black tracking-widest">PAUSED</h2>
              <Button className="w-full" onClick={resume} autoFocus>
                <PlayIcon size={18} /> Resume
              </Button>
              <Button variant="secondary" className="mt-2 w-full" onClick={() => restart(level)}>
                <RestartIcon size={18} /> Restart level
              </Button>
              <Button variant="ghost" className="mt-1 w-full" onClick={onMap}>
                Levels
              </Button>
            </div>
          </div>
        )}

        {overlay === "result" && result && (
          <div className="absolute inset-0 grid place-items-center bg-ink/55 p-4 backdrop-blur-sm" role="dialog" aria-label={result.cleared ? "Level cleared" : "Crashed"}>
            <div className="pop-in w-full max-w-sm rounded-3xl border border-white/10 bg-panel/95 p-5 text-center shadow-2xl">
              {result.cleared ? (
                <>
                  <p className="text-sm font-black tracking-[0.3em] text-gold">LEVEL {level} CLEAR</p>
                  <div className="my-3 flex justify-center">
                    <Stars count={result.stars} size={40} />
                  </div>
                  <p className="text-sm text-muted">
                    {result.stars === 3
                      ? "Perfect routes!"
                      : `${result.moves} moves · shortest about ${result.par}. Shorter routes earn more stars.`}
                  </p>
                </>
              ) : (
                <>
                  <p className="text-sm font-black tracking-[0.3em] text-rose-300">CRASHED</p>
                  <p className="my-2 text-5xl font-black tabular-nums" style={{ textShadow: `0 0 24px ${hex(skin.glow)}` }}>
                    {eaten}/{goal}
                  </p>
                  <p className="text-sm text-muted">fruit eaten · press any arrow to go again</p>
                </>
              )}
              {result.unlockedNow.length > 0 && (
                <div className="mt-4 rounded-2xl border border-gold/40 bg-gold/10 p-3">
                  <p className="mb-2 text-xs font-bold uppercase tracking-widest text-gold">New skin unlocked</p>
                  <div className="flex flex-wrap justify-center gap-2">
                    {result.unlockedNow.map((s) => (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() => {
                          onSaved(chooseSkin(s.id));
                        }}
                        className="flex items-center gap-2 rounded-full bg-panel-2 px-3 py-1.5 text-sm font-semibold"
                      >
                        <SkinSwatch skin={s} size={28} /> {s.id === saved.skin ? `${s.name} ✓` : `Use ${s.name}`}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {result.cleared && next ? (
                <Button className="mt-4 w-full text-lg" onClick={() => onLevel(next)} autoFocus>
                  <PlayIcon size={20} /> Next level
                </Button>
              ) : !result.cleared ? (
                <Button className="mt-4 w-full text-lg" onClick={() => restart(level)} autoFocus>
                  <RestartIcon size={20} /> Try again
                </Button>
              ) : (
                <p className="mt-4 font-bold text-gold">All {LEVEL_COUNT} levels cleared! 🏆</p>
              )}
              <div className="mt-2 grid grid-cols-2 gap-2">
                {result.cleared ? (
                  <Button variant="secondary" onClick={() => restart(level)}>
                    Replay
                  </Button>
                ) : (
                  <span />
                )}
                <Button variant="secondary" onClick={onMap} className={result.cleared ? "" : "col-start-1 col-end-3"}>
                  Levels
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>

      {pad && (
        <div className="grid shrink-0 touch-none select-none place-items-center pb-3 pt-2" aria-label="Arrows">
          {/* Compact: tall left/right at the sides, up and down stacked in the middle. */}
          <div className="grid grid-cols-[5rem_5.5rem_5rem] grid-rows-[3.5rem_3.5rem] gap-2">
            <PadButton dir="left" onTurn={padTurn} className="row-span-2">
              ◀
            </PadButton>
            <PadButton dir="up" onTurn={padTurn} className="">
              ▲
            </PadButton>
            <PadButton dir="right" onTurn={padTurn} className="row-span-2">
              ▶
            </PadButton>
            <PadButton dir="down" onTurn={padTurn} className="col-start-2">
              ▼
            </PadButton>
          </div>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ screen

export function NeonCoilScreen({ onBack, level: startAt }: { onBack: () => void; level?: number }) {
  const [saved, setSaved] = useState(loadSaved);
  const [level, setLevel] = useState<number | null>(() =>
    startAt && startAt >= 1 && startAt <= openLevel(loadSaved()) ? startAt : null,
  );

  // The skin applies the next time the board is drawn; keep the view in sync.
  const onSkin = (s: Skin) => setSaved(chooseSkin(s.id));

  if (level === null) {
    return <LevelMap saved={saved} onBack={onBack} onSkin={onSkin} onPlay={setLevel} />;
  }
  return (
    <Play
      level={level}
      saved={saved}
      onSaved={setSaved}
      onMap={() => setLevel(null)}
      onLevel={(n) => setLevel(Math.min(n, openLevel(loadSaved())))}
    />
  );
}
