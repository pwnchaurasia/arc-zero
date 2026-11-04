import { useEffect, useRef, useState } from "react";

import { ApiError, api } from "../api/client";
import type { ToComplete, ToMove, ToStart } from "../api/types";
import { engine, loadEngine } from "../engine/wasm";
import { haptic, sfx } from "../feel/audio";
import { TraceOutView } from "../games/traceout/TraceOutView";
import { useSession } from "../state/session";
import { CoinChip } from "../ui/CoinChip";
import { BulbIcon, RestartIcon } from "../ui/icons";
import { Button, IconButton, TopBar } from "../ui/kit";
import { ConfirmSpend, type SpendRequest } from "./ConfirmSpend";
import { ResultCard } from "./ResultCard";
import { useToast } from "./useToast";

type Sim = InstanceType<typeof engine.TraceOut>;

const OP_TAP = 0;
const OP_CONTINUE = 1;
const LIVES = 3;
const DIRS: Record<string, string> = { "0,-1": "up", "1,0": "right", "0,1": "down", "-1,0": "left" };
/** Praise for clean taps in a row (a blocked tap starts the count again). */
const STREAKS: Record<number, [string, number]> = {
  3: ["Nice!", 0x16a34a],
  5: ["Great!", 0x0284c7],
  8: ["Brilliant!", 0x9333ea],
  12: ["On fire!", 0xea580c],
};

/** A droplet: filled while you still have it, an empty outline once lost. */
function Droplet({ full }: { full: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={22}
      height={22}
      aria-hidden="true"
      className={full ? "text-sky-400" : "drop-lost text-line"}
    >
      <path
        d="M12 2.5S5 10.2 5 14.8a7 7 0 0 0 14 0C19 10.2 12 2.5 12 2.5Z"
        fill={full ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      {full && <path d="M9.3 15.2a3 3 0 0 0 2.4 2.8" stroke="white" strokeOpacity="0.75" strokeWidth="1.7" fill="none" strokeLinecap="round" />}
    </svg>
  );
}

interface Game {
  start: ToStart;
  sim: Sim;
  moves: ToMove[];
  /** Continues paid for in this attempt. */
  owned: number;
  spent: number;
  done: boolean;
}

function build(start: ToStart, moves: ToMove[]): Sim {
  const sim = new engine.TraceOut(JSON.stringify(start.data));
  for (const [op, line] of moves) {
    if (op === OP_TAP) sim.tap(line);
    else sim.revive();
  }
  return sim;
}

function arrow(cells: [number, number][]): string {
  const [hx, hy] = cells[cells.length - 1] ?? [0, 0];
  const [px, py] = cells[cells.length - 2] ?? [0, 0];
  return DIRS[`${hx - px},${hy - py}`] ?? "";
}

export function TraceOutScreen({
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
  const view = useRef<TraceOutView | null>(null);
  const game = useRef<Game | null>(null);
  const tapRef = useRef<(line: number) => void>(() => undefined);
  const streak = useRef(0);
  const [round, setRound] = useState(0);
  const [info, setInfo] = useState<ToStart | null>(null);
  const [lives, setLives] = useState(LIVES);
  const [left, setLeft] = useState(0);
  const [present, setPresent] = useState<boolean[]>([]);
  const [out, setOut] = useState(false);
  const [coins, setCoins] = useState<number | undefined>(undefined);
  const [spend, setSpend] = useState<(SpendRequest & { kind: "continue" | "hint" }) | null>(null);
  const [buying, setBuying] = useState(false);
  const [result, setResult] = useState<ToComplete | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, showToast] = useToast();

  const replay = me ? me.games.traceout.stars[String(level)] !== undefined : false;

  const refreshUi = (g: Game) => {
    setLives(g.sim.lives());
    setLeft(g.sim.remaining());
    setPresent(g.start.data.lines.map((_, i) => g.sim.present(i)));
    setOut(g.sim.status() === 2);
  };

  const submit = async (g: Game) => {
    if (g.done) return;
    g.done = true;
    try {
      const res = await api.to.complete(level, g.start.attempt_id, g.moves);
      await new Promise((r) => setTimeout(r, 500));
      if (!game.current) return;
      sfx.win();
      void view.current?.celebrate();
      haptic(30);
      setResult(res);
      setCoins(res.coins);
      void refresh();
      if (res.registration_required) onCheckpoint();
    } catch (e) {
      g.done = false;
      setError(e instanceof ApiError ? e.message : "Could not save this result.");
    }
  };

  useEffect(() => {
    let cancelled = false;
    let created: TraceOutView | null = null;
    setResult(null);
    streak.current = 0;
    setOut(false);
    setError(null);

    const tap = (line: number) => {
      const g = game.current;
      const v = view.current;
      if (!g || !v || g.done || g.sim.status() !== 0 || !g.sim.present(line)) return;
      sfx.unlock();
      const blocker = g.sim.tap(line);
      g.moves.push([OP_TAP, line]);
      if (blocker < 0) {
        streak.current += 1;
        const n = streak.current;
        const cheer = STREAKS[n] ?? (n > 12 && n % 5 === 2 ? (["Unstoppable!", 0xdb2777] as [string, number]) : null);
        if (cheer) v.cheer(cheer[0], cheer[1]);
        sfx.complete();
        haptic(8);
        void v.exit(line);
      } else {
        sfx.invalid();
        haptic(25);
        streak.current = 0;
        void v.bump(line, blocker);
      }
      refreshUi(g);
      if (g.sim.status() === 1) void submit(g);
    };
    tapRef.current = tap;

    (async () => {
      await loadEngine();
      const start = await api.to.start(level);
      if (cancelled || !host.current) return;
      const g: Game = { start, sim: build(start, []), moves: [], owned: 0, spent: 0, done: false };
      game.current = g;
      created = await TraceOutView.create(host.current, start.data, { onTap: tap });
      if (cancelled) {
        created.destroy();
        return;
      }
      view.current = created;
      setInfo(start);
      setCoins(start.coins);
      refreshUi(g);
    })().catch((e: unknown) => {
      if (!cancelled) setError(e instanceof ApiError ? e.message : "Could not load this level.");
    });

    return () => {
      cancelled = true;
      created?.destroy();
      view.current = null;
      game.current?.sim.free();
      game.current = null;
    };
    // `refreshUi` and `submit` only touch refs and stable setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [level, round]);

  /** Starts the level over in this attempt: free, and paid continues stay paid. */
  const restart = () => {
    const g = game.current;
    if (!g || g.done) return;
    g.sim.free();
    g.moves = [];
    g.sim = build(g.start, []);
    view.current?.sync(g.start.data.lines.map(() => true));
    refreshUi(g);
  };

  const usedContinues = (g: Game) => g.moves.filter(([op]) => op === OP_CONTINUE).length;

  const revive = (g: Game) => {
    g.sim.revive();
    g.moves.push([OP_CONTINUE, 0]);
    refreshUi(g);
  };

  const onContinue = () => {
    const g = game.current;
    if (!g || !info) return;
    if (g.owned > usedContinues(g)) {
      revive(g);
      return;
    }
    setSpend({
      kind: "continue",
      title: "Continue",
      what: "Refills your 3 droplets and keeps the board as it is.",
      price: info.prices.continue,
      balance: coins ?? 0,
      reward: replay ? null : info.reward,
      spent: g.spent,
      note: "If you restart, continues you paid for in this attempt can be used again for free.",
    });
  };

  const onHint = () => {
    if (!info || !game.current || game.current.sim.status() !== 0) return;
    setSpend({
      kind: "hint",
      title: "Hint",
      what: "Shows a line that can leave right now.",
      price: info.prices.hint,
      balance: coins ?? 0,
      reward: replay ? null : info.reward,
      spent: game.current.spent,
    });
  };

  const confirmSpend = async () => {
    const g = game.current;
    if (!g || !spend) return;
    setBuying(true);
    try {
      if (spend.kind === "continue") {
        const res = await api.to.buyContinue(level, g.start.attempt_id, spend.price);
        g.owned = res.owned.continue ?? 0;
        g.spent = res.spent;
        setCoins(res.coins);
        revive(g);
      } else {
        const res = await api.to.hint(level, g.start.attempt_id, g.moves, spend.price);
        g.spent = res.spent;
        setCoins(res.coins);
        void view.current?.glow(res.line);
      }
      void refresh();
    } catch (e) {
      showToast(e instanceof ApiError ? e.message : "Could not buy that right now.");
    } finally {
      setBuying(false);
      setSpend(null);
    }
  };

  const count = me?.games.traceout.level_count ?? 0;
  const resultDetail = (r: ToComplete) => {
    const flawless = r.mistakes === 0 ? "Flawless! " : "";
    if (!r.first_clear) return `${flawless}Replay: no coins this time.`;
    const parts = [`+${r.coins_earned} coins`];
    if (r.streak_bonus) parts.push(`+${r.streak_bonus} streak bonus`);
    return flawless + parts.join(" · ");
  };

  return (
    <div className="relative flex h-full flex-col">
      <TopBar
        title={`Level ${level}`}
        onBack={onBack}
        right={
          <div className="flex items-center gap-2">
            <CoinChip balance={coins} />
            <IconButton label="Restart level" onClick={restart} disabled={!info}>
              <RestartIcon />
            </IconButton>
          </div>
        }
      />
      <div className="flex items-center justify-between px-5 text-sm text-muted">
        <span className="flex items-center gap-1" aria-label={`${lives} of ${LIVES} droplets left`}>
          {Array.from({ length: LIVES }, (_, i) => (
            // Keyed by state, so losing a droplet replays its animation.
            <Droplet key={`${i}-${i < lives}`} full={i < lives} />
          ))}
        </span>
        <span>{info ? `${left} lines left` : " "}</span>
        {info && <span>{replay ? "Replay: no coins" : `First clear: ${info.reward} coins`}</span>}
      </div>
      <div className="relative min-h-0 flex-1">
        <div ref={host} className="game-surface absolute inset-0" />
        {out && !result && !spend && (
          <div className="absolute inset-0 z-10 grid place-items-center bg-ink/55 p-6 backdrop-blur-[2px]">
            <div className="pop-in w-full max-w-xs rounded-3xl border border-line bg-panel p-5 text-center shadow-2xl">
              <h2 className="text-2xl font-black">Out of droplets</h2>
              <p className="mt-1 mb-4 text-sm text-muted">Restart for free, or keep this board with a continue.</p>
              <div className="grid gap-3">
                <Button onClick={restart}>Restart level</Button>
                <Button variant="secondary" onClick={onContinue}>
                  Continue · {info?.prices.continue ?? "…"} coins
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>
      {/* The canvas can't be read by screen readers or used by keyboard: one button per line. */}
      <div className="sr-only" role="group" aria-label="Lines on the board">
        {info?.data.lines.map((line, i) =>
          present[i] ? (
            <button key={i} type="button" onClick={() => tapRef.current(i)}>
              {`Line ${i + 1}: arrow ${arrow(line.cells)} at column ${(line.cells[line.cells.length - 1]?.[0] ?? 0) + 1}, row ${(line.cells[line.cells.length - 1]?.[1] ?? 0) + 1}`}
            </button>
          ) : null,
        )}
      </div>
      <div className="flex justify-center gap-3 px-4 pb-[max(env(safe-area-inset-bottom),12px)] pt-2">
        <button
          type="button"
          disabled={!info || !!result || out}
          onClick={onHint}
          className="flex min-h-14 min-w-28 flex-col items-center justify-center rounded-2xl border border-line bg-panel-2 px-3 py-1.5 text-xs font-semibold transition hover:bg-line active:scale-95 disabled:opacity-40"
        >
          <BulbIcon size={20} />
          <span>Hint</span>
          <span className="text-[11px] text-gold">{info ? `${info.prices.hint} coins` : "…"}</span>
        </button>
      </div>
      {error && (
        <p className="absolute inset-x-5 bottom-24 rounded-xl bg-red-500/20 p-3 text-center text-sm text-red-200">{error}</p>
      )}
      {toast && <p className="absolute inset-x-5 bottom-24 rounded-xl bg-panel-2 p-3 text-center text-sm">{toast}</p>}
      <ConfirmSpend request={spend} busy={buying} onConfirm={() => void confirmSpend()} onCancel={() => setSpend(null)} />
      {result && (
        <ResultCard
          won
          stars={result.stars}
          detail={resultDetail(result)}
          hasNext={level < count && result.unlocked_level > level}
          onNext={() => onLevel(level + 1)}
          onRetry={() => setRound((r) => r + 1)}
          onLevels={onBack}
        />
      )}
    </div>
  );
}
