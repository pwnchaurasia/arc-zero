import { useEffect, useRef, useState } from "react";

import { ApiError, api } from "../api/client";
import type {
  GsAssist,
  GsFinal,
  GsLeaderboard,
  GsLevelResult,
  GsLevelStart,
  GsPeriod,
  GsStart,
  GsView,
} from "../api/types";
import { engine, loadEngine } from "../engine/wasm";
import { haptic, sfx } from "../feel/audio";
import { GridSnapView, shapeSize } from "../games/gridsnap/GridSnapView";
import { useSession } from "../state/session";
import { CoinChip } from "../ui/CoinChip";
import { BombIcon, CrownIcon, FlagIcon, RestartIcon, ShuffleIcon, TrophyIcon } from "../ui/icons";
import { Button, IconButton, Modal, TopBar } from "../ui/kit";
import { ConfirmSpend, type SpendRequest } from "./ConfirmSpend";
import { ResultCard } from "./ResultCard";
import { useToast } from "./useToast";

type Sim = InstanceType<typeof engine.GridSnap>;

const ASSISTS: Record<GsAssist, { title: string; what: string }> = {
  reshuffle: { title: "Reshuffle", what: "Swaps the shapes left in your tray for new ones. At least one will fit." },
  bomb: { title: "Bomb", what: "Clears the 3 × 3 area around the square you picked. No points for the cleared blocks." },
};
const TERMS =
  "Coins aren't refunded. A game with bought help still counts for your best score, but not for the leaderboards.";
const STEPS: Record<string, [number, number]> = {
  ArrowUp: [-1, 0],
  ArrowDown: [1, 0],
  ArrowLeft: [0, -1],
  ArrowRight: [0, 1],
};
/** How long the board stays visible after the last move before "No room!" covers it. */
const STUCK_CARD_DELAY_MS = 1200;
const PERIODS: { id: GsPeriod; label: string }[] = [
  { id: "week", label: "This week" },
  { id: "month", label: "This month" },
  { id: "all", label: "All time" },
];

interface Run {
  id: string;
  /** Actions the server has applied. */
  seq: number;
  /** The server's latest board. */
  view: GsView;
  /** The board as the player sees it, including moves still on their way to the server. */
  sim: Sim;
  /** Moves sent but not answered yet. */
  pending: number;
  /** Bumped when the server's board replaces ours: queued moves from before are dropped. */
  generation: number;
  queue: Promise<void>;
  prices: GsStart["prices"];
  /** Coins spent on help in this game (a level's reward shrinks by this much). */
  spent: number;
}

function tray(sim: Sim): ({ shape: number; color: number } | null)[] {
  const flat = sim.tray();
  return [0, 1, 2].map((i) => {
    const shape = flat[i * 2] ?? -1;
    return shape < 0 ? null : { shape, color: flat[i * 2 + 1] ?? 0 };
  });
}

/** First spot where the shape in `slot` fits, for keyboard play. */
function firstSpot(sim: Sim, slot: number): [number, number] | null {
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) if (sim.canPlace(slot, r, c)) return [r, c];
  return null;
}

/**
 * Endless GridSnap, or one of its levels when `level` is set: the board starts with
 * stones, and clearing all of them wins the level.
 */
export function GridSnapScreen({
  level,
  onBack,
  onCheckpoint,
  onLevel,
}: {
  level?: number;
  onBack: () => void;
  onCheckpoint: () => void;
  onLevel?: (level: number) => void;
}) {
  const { me, refresh } = useSession();
  const [info, setInfo] = useState<GsLevelStart | null>(null);
  const [stones, setStones] = useState(0);
  const [placed, setPlaced] = useState(0);
  const [result, setResult] = useState<GsLevelResult | null>(null);
  const replay = level !== undefined && me ? me.games.gridsnap.stars[String(level)] !== undefined : false;
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<GridSnapView | null>(null);
  const run = useRef<Run | null>(null);
  const keyGhost = useRef<[number, number, number] | null>(null);
  const [round, setRound] = useState(0);
  const [ready, setReady] = useState(false);
  const [score, setScore] = useState(0);
  const [best, setBest] = useState(0);
  const [combo, setCombo] = useState(0);
  const [stuck, setStuck] = useState(false);
  /** Pending "No room!" card: it waits for the last placement's animation to finish. */
  const stuckTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [coins, setCoins] = useState<number | undefined>(undefined);
  const [prices, setPrices] = useState<GsStart["prices"] | null>(null);
  const [spend, setSpend] = useState<(SpendRequest & { kind: GsAssist; at: [number, number] }) | null>(null);
  const [buying, setBuying] = useState(false);
  const [picking, setPicking] = useState(false);
  const [final, setFinal] = useState<GsFinal | null>(null);
  const [confirmEnd, setConfirmEnd] = useState<"end" | "new" | null>(null);
  const [board, setBoard] = useState<GsLeaderboard | null>(null);
  const [period, setPeriod] = useState<GsPeriod | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, showToast] = useToast(3200);
  // Read by callbacks the canvas holds on to, so they never see stale values.
  const coinsRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    coinsRef.current = coins;
  }, [coins]);

  const syncUi = (r: Run) => {
    setScore(r.sim.score());
    setCombo(r.sim.combo());
    setStones(r.sim.stones());
    setPlaced(r.sim.placed());
    const empty = tray(r.sim).every((p) => p === null);
    setWaiting(empty);
    // Let the last shape land and its lines clear before the card covers the board.
    if (stuckTimer.current) clearTimeout(stuckTimer.current);
    stuckTimer.current = null;
    if (r.pending === 0 && r.view.status === "stuck") {
      stuckTimer.current = setTimeout(() => {
        const now = run.current;
        setStuck(now === r && now.pending === 0 && now.view.status === "stuck");
      }, STUCK_CARD_DELAY_MS);
    } else {
      setStuck(false);
    }
    // A won level stays locked even before the server confirms it.
    view.current?.setLocked(empty || r.sim.status() === 3 || (r.pending === 0 && r.view.status !== "playing"));
  };

  /** The server confirmed a level's last stone: celebrate and show the result. */
  const won = (res: GsLevelResult) => {
    // The last lines clear and the fireworks play before the result card covers them.
    const r = run.current;
    setTimeout(() => run.current === r && setResult(res), 1600);
    setCoins(res.coins);
    sfx.win();
    haptic(30);
    void view.current?.celebrate();
    void refresh();
    if (res.registration_required) onCheckpoint();
  };

  /** Makes the server's board the one on screen. */
  const adopt = (r: Run, v: GsView, deal: boolean) => {
    r.view = v;
    r.sim.free();
    r.sim = new engine.GridSnap(JSON.stringify(v));
    view.current?.setState(v.cells, v.tray, deal);
    keyGhost.current = null;
    view.current?.showKeyGhost(null);
    syncUi(r);
  };

  /** A rejected or retried move: the server's answer carries its board. */
  const resync = (r: Run, e: unknown): boolean => {
    if (!(e instanceof ApiError)) return false;
    const d = e.details as { seq?: unknown; view?: unknown };
    if (typeof d.seq !== "number" || typeof d.view !== "object" || d.view === null) return false;
    r.seq = d.seq;
    r.pending = 0;
    r.generation += 1;
    adopt(r, d.view as GsView, true);
    return true;
  };

  const send = (r: Run, slot: number, row: number, col: number) => {
    const generation = r.generation;
    r.pending += 1;
    r.queue = r.queue.then(async () => {
      if (generation !== r.generation || run.current !== r) return;
      for (let attempt = 0; ; attempt++) {
        try {
          const res = await api.gs.place(r.id, r.seq, slot, row, col);
          r.seq = res.seq;
          r.pending -= 1;
          if (r.pending === 0) adopt(r, res.view, true);
          else r.view = res.view;
          if (res.result) won(res.result);
          return;
        } catch (e) {
          if (resync(r, e)) {
            showToast("Your board was updated from the server.");
            return;
          }
          // Offline for a moment: the same request is safe to repeat (the server checks `seq`).
          if (e instanceof ApiError && e.status === 0 && attempt < 4) {
            await new Promise((ok) => setTimeout(ok, 800 * (attempt + 1)));
            continue;
          }
          r.pending = 0;
          r.generation += 1;
          setError(e instanceof ApiError ? e.message : "Could not reach the server.");
          return;
        }
      }
    });
  };

  const place = (slot: number, row: number, col: number) => {
    const r = run.current;
    const v = view.current;
    if (!r || !v || !r.sim.canPlace(slot, row, col)) return;
    const piece = tray(r.sim)[slot];
    if (!piece) return;
    sfx.unlock();
    const [rows = 0, cols = 0, points = 0, chain = 0] = Array.from(r.sim.place(slot, row, col));
    if (rows || cols) {
      sfx.blast(chain);
      haptic(25);
    } else {
      sfx.tap();
      haptic(8);
    }
    void v.place(slot, row, col, piece, { rows, cols, points, combo: chain }, Array.from(r.sim.cells()));
    syncUi(r);
    send(r, slot, row, col);
  };

  const begin = async (start: GsStart | GsLevelStart) => {
    const old = run.current;
    old?.sim.free();
    const sim = new engine.GridSnap(JSON.stringify(start.view));
    const r: Run = {
      id: start.run_id,
      seq: start.seq,
      view: start.view,
      sim,
      pending: 0,
      generation: 0,
      queue: Promise.resolve(),
      prices: start.prices,
      spent: 0,
    };
    run.current = r;
    setCoins(start.coins);
    setPrices(start.prices);
    setFinal(null);
    setResult(null);
    view.current?.setState(start.view.cells, start.view.tray, true);
    syncUi(r);
    if ("level" in start) {
      setInfo(start);
    } else {
      setBest(start.best);
      if (start.previous) showToast(`Your last game was saved: ${start.previous.score} points.`);
    }
  };

  /** A level's fresh try (the one being left is closed, so it counts as not cleared). */
  const retry = async () => {
    if (level === undefined) return;
    const old = run.current;
    try {
      await old?.queue;
      if (old && old.sim.status() !== 3) void api.gs.end(old.id).catch(() => undefined);
      await begin(await api.gs.startLevel(level));
    } catch (e) {
      showToast(e instanceof ApiError ? e.message : "Could not restart the level.");
    }
  };

  useEffect(() => {
    let cancelled = false;
    let created: GridSnapView | null = null;
    setReady(false);
    setError(null);
    (async () => {
      await loadEngine();
      // A level always starts fresh; endless continues an open game, else starts one.
      const start =
        level !== undefined ? await api.gs.startLevel(level) : ((await api.gs.current()) ?? (await api.gs.start()));
      if (cancelled || !host.current) return;
      created = await GridSnapView.create(host.current, {
        rules: {
          canPlace: (s, row, col) => run.current?.sim.canPlace(s, row, col) ?? false,
          wouldClear: (s, row, col) => {
            const [a = 0, b = 0] = Array.from(run.current?.sim.wouldClear(s, row, col) ?? []);
            return [a, b];
          },
          fits: (s) => run.current?.sim.fits(s) ?? false,
        },
        onPlace: place,
        onPick: pickBomb,
      });
      if (cancelled) {
        created.destroy();
        return;
      }
      view.current = created;
      await begin(start);
      setReady(true);
    })().catch((e: unknown) => {
      if (!cancelled) setError(e instanceof ApiError ? e.message : "Could not load GridSnap.");
    });
    return () => {
      cancelled = true;
      if (stuckTimer.current) clearTimeout(stuckTimer.current);
      created?.destroy();
      view.current = null;
      run.current?.sim.free();
      run.current = null;
    };
    // `place`, `begin` and `pickBomb` only touch refs and stable setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [round]);

  // Keyboard play: 1-3 pick a shape, arrows move it, Enter places, Escape cancels.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const r = run.current;
      const v = view.current;
      if (!r || !v || final || result || spend || picking) return;
      const g = keyGhost.current;
      if (e.key >= "1" && e.key <= "3") {
        const slot = Number(e.key) - 1;
        if (!tray(r.sim)[slot]) return;
        const [row, col] = firstSpot(r.sim, slot) ?? [0, 0];
        keyGhost.current = [slot, row, col];
      } else if (g && e.key.startsWith("Arrow")) {
        const p = tray(r.sim)[g[0]];
        if (!p) return;
        const { w, h } = shapeSize(p.shape);
        const [dr, dc] = STEPS[e.key] ?? [0, 0];
        keyGhost.current = [g[0], Math.min(Math.max(g[1] + dr, 0), 8 - h), Math.min(Math.max(g[2] + dc, 0), 8 - w)];
      } else if (g && (e.key === "Enter" || e.key === " ")) {
        keyGhost.current = null;
        v.showKeyGhost(null);
        place(g[0], g[1], g[2]);
        e.preventDefault();
        return;
      } else if (e.key === "Escape") {
        keyGhost.current = null;
      } else {
        return;
      }
      e.preventDefault();
      v.showKeyGhost(keyGhost.current);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [final, result, spend, picking]);

  const ask = (kind: GsAssist, at: [number, number] = [0, 0]) => {
    const r = run.current;
    if (!r) return;
    setSpend({
      kind,
      at,
      title: ASSISTS[kind].title,
      what: ASSISTS[kind].what,
      price: r.prices[kind],
      balance: coinsRef.current ?? 0,
      // On a level, help comes off the first-clear reward like in the other games.
      reward: info && !replay ? info.reward : null,
      spent: r.spent,
      terms: level === undefined ? TERMS : undefined,
    });
  };

  function pickBomb(row: number, col: number) {
    view.current?.setPicking(false);
    setPicking(false);
    ask("bomb", [row, col]);
  }

  const onAssist = (kind: GsAssist) => {
    const r = run.current;
    if (!r || final) return;
    const used = kind === "bomb" ? r.view.bombs : r.view.reshuffles;
    if (used >= 3) {
      showToast(`You've used ${ASSISTS[kind].title} 3 times in this game.`);
      return;
    }
    if (kind === "reshuffle" && tray(r.sim).every((p) => p === null)) return;
    if (kind === "bomb") {
      setPicking(true);
      view.current?.setPicking(true);
      return;
    }
    ask(kind);
  };

  const confirmSpend = async () => {
    const r = run.current;
    if (!r || !spend) return;
    setBuying(true);
    try {
      await r.queue;
      const [row, col] = spend.at;
      const res = await api.gs.assist(r.id, r.seq, spend.kind, spend.price, row, col);
      r.seq = res.seq;
      r.spent += spend.price;
      if (res.coins !== null) setCoins(res.coins);
      void refresh();
      sfx.complete();
      if (spend.kind === "bomb") {
        await view.current?.explode(row, col, res.view.cells);
        adopt(r, res.view, false);
      } else {
        adopt(r, res.view, true);
      }
      if (res.result) won(res.result);
    } catch (e) {
      if (!resync(r, e)) showToast(e instanceof ApiError ? e.message : "Could not buy that right now.");
    } finally {
      setBuying(false);
      setSpend(null);
    }
  };

  const endGame = async () => {
    const r = run.current;
    setConfirmEnd(null);
    if (!r) return;
    try {
      await r.queue;
      const res = await api.gs.end(r.id);
      setFinal(res);
      setBest(res.best);
      setCoins(res.coins);
      view.current?.setLocked(true);
      if (res.new_best) sfx.win();
      else sfx.lose();
      void refresh();
    } catch (e) {
      showToast(e instanceof ApiError ? e.message : "Could not end the game right now.");
    }
  };

  const onNewGame = () => {
    if (score > 0 && !final) setConfirmEnd("new");
    else void newGame();
  };

  const newGame = async () => {
    setConfirmEnd(null);
    try {
      await run.current?.queue;
      await begin(await api.gs.start());
      void refresh();
    } catch (e) {
      showToast(e instanceof ApiError ? e.message : "Could not start a new game.");
    }
  };

  const openBoard = async (p: GsPeriod) => {
    setPeriod(p);
    setBoard(null);
    try {
      setBoard(await api.gs.leaderboard(p));
    } catch (e) {
      setPeriod(null);
      showToast(e instanceof ApiError ? e.message : "Could not load the leaderboard.");
    }
  };

  const assistsUsed = (k: GsAssist) => (k === "bomb" ? run.current?.view.bombs : run.current?.view.reshuffles) ?? 0;

  return (
    <div className="relative flex h-full flex-col">
      <TopBar
        title={level === undefined ? "GridSnap" : `Level ${level}`}
        onBack={onBack}
        right={
          <div className="flex items-center gap-2">
            <CoinChip balance={coins} />
            {level === undefined ? (
              <>
                <IconButton label="Leaderboards" onClick={() => void openBoard("week")}>
                  <TrophyIcon />
                </IconButton>
                <IconButton label="New game" onClick={onNewGame} disabled={!ready}>
                  <RestartIcon />
                </IconButton>
              </>
            ) : (
              <IconButton label="Restart level" onClick={() => void retry()} disabled={!ready}>
                <RestartIcon />
              </IconButton>
            )}
          </div>
        }
      />
      {level !== undefined ? (
        <div className="flex items-end justify-between px-5">
          <span className="text-sm text-muted">
            Shapes <span className="font-bold text-white tabular-nums">{placed}</span>
            {info ? ` / ${info.par}` : ""}
          </span>
          <span className="flex flex-col items-center leading-none" aria-live="polite" aria-label={`${stones} stones left`}>
            <span className="text-4xl font-black tabular-nums">{stones}</span>
            <span className="mt-1 text-[11px] uppercase tracking-wider text-muted">stones left</span>
          </span>
          <span className="text-right text-sm text-muted">
            {info ? (replay ? "Replay" : `First clear: ${info.reward}`) : ""}
          </span>
        </div>
      ) : (
      <div className="flex items-end justify-between px-5">
        <span className="flex items-center gap-1.5 text-sm font-bold text-gold">
          <CrownIcon size={18} />
          <span className="tabular-nums">{Math.max(best, score)}</span>
        </span>
        <span className="text-4xl font-black tabular-nums" aria-live="polite" aria-label={`Score ${score}`}>
          {score}
        </span>
        <span className="min-w-12 text-right text-sm font-bold text-sky-300">{combo >= 2 ? `×${combo}` : ""}</span>
      </div>
      )}
      <div className="relative min-h-0 flex-1">
        <div ref={host} className="game-surface absolute inset-0 touch-none" />
        {stuck && !final && !result && !spend && !picking && (
          <div className="absolute inset-0 z-10 grid place-items-center bg-ink/55 p-6 backdrop-blur-[2px]">
            <div className="pop-in w-full max-w-xs rounded-3xl border border-line bg-panel p-5 text-center shadow-2xl">
              <h2 className="text-2xl font-black">No room!</h2>
              <p className="mt-1 mb-4 text-sm text-muted">
                {level === undefined
                  ? "None of your shapes fit. Use coins to keep going, or end the game."
                  : "None of your shapes fit. Use coins to keep going, or try the level again."}
              </p>
              <div className="grid gap-3">
                <Button onClick={() => onAssist("reshuffle")} disabled={assistsUsed("reshuffle") >= 3}>
                  <ShuffleIcon size={18} /> Reshuffle · {prices?.reshuffle ?? "…"}
                </Button>
                <Button variant="secondary" onClick={() => onAssist("bomb")} disabled={assistsUsed("bomb") >= 3}>
                  <BombIcon size={18} /> Bomb · {prices?.bomb ?? "…"}
                </Button>
                {level === undefined ? (
                  <Button variant="ghost" onClick={() => void endGame()}>
                    End game
                  </Button>
                ) : (
                  <Button variant="ghost" onClick={() => void retry()}>
                    Try again
                  </Button>
                )}
              </div>
            </div>
          </div>
        )}
        <div className="pointer-events-none absolute inset-x-3 bottom-3 grid gap-2 [&>*]:pointer-events-auto">
          {picking && (
            <div className="flex items-center justify-between gap-3 rounded-xl bg-amber-950/90 p-3 text-sm text-amber-100 shadow-lg backdrop-blur">
              <span>Tap where to drop the bomb.</span>
              <button
                type="button"
                className="font-semibold underline"
                onClick={() => {
                  setPicking(false);
                  view.current?.setPicking(false);
                }}
              >
                Cancel
              </button>
            </div>
          )}
          {waiting && !stuck && !final && ready && (
            <p className="mx-auto rounded-full bg-panel-2/90 px-3 py-1 text-xs text-muted">Dealing…</p>
          )}
        </div>
      </div>
      <p className="sr-only">
        Drag a shape from the tray onto the board. With a keyboard: press 1, 2 or 3 to pick a shape, arrow keys to move
        it, Enter to place it.
      </p>
      <div className="flex justify-center gap-3 px-4 pb-[max(env(safe-area-inset-bottom),12px)] pt-2">
        {(["reshuffle", "bomb"] as const).map((kind) => {
          const Icon = kind === "bomb" ? BombIcon : ShuffleIcon;
          return (
            <button
              key={kind}
              type="button"
              disabled={!ready || !!final || !!result || picking}
              onClick={() => onAssist(kind)}
              className="flex min-h-14 min-w-24 flex-col items-center justify-center rounded-2xl border border-line bg-panel-2 px-3 py-1.5 text-xs font-semibold transition hover:bg-line active:scale-95 disabled:opacity-40"
            >
              <Icon size={20} />
              <span>{ASSISTS[kind].title}</span>
              <span className="text-[11px] text-gold">{prices ? `${prices[kind]} coins` : "…"}</span>
            </button>
          );
        })}
        <button
          type="button"
          disabled={!ready || !!final || !!result}
          onClick={() => (level === undefined ? setConfirmEnd("end") : void retry())}
          className="flex min-h-14 min-w-24 flex-col items-center justify-center rounded-2xl border border-line bg-panel-2 px-3 py-1.5 text-xs font-semibold transition hover:bg-line active:scale-95 disabled:opacity-40"
        >
          {level === undefined ? <FlagIcon size={20} /> : <RestartIcon size={20} />}
          <span>{level === undefined ? "End game" : "Restart"}</span>
          <span className="text-[11px] text-muted">{level === undefined ? "save score" : "free"}</span>
        </button>
      </div>
      {error && (
        <p className="absolute inset-x-5 bottom-24 rounded-xl bg-red-500/20 p-3 text-center text-sm text-red-200">
          {error}{" "}
          <button type="button" className="font-semibold underline" onClick={() => setRound((n) => n + 1)}>
            Reload
          </button>
        </p>
      )}
      {toast && <p className="absolute inset-x-5 bottom-24 rounded-xl bg-panel-2 p-3 text-center text-sm">{toast}</p>}

      <ConfirmSpend request={spend} busy={buying} onConfirm={() => void confirmSpend()} onCancel={() => setSpend(null)} />

      <Modal
        open={confirmEnd !== null}
        onClose={() => setConfirmEnd(null)}
        title={confirmEnd === "new" ? "Start a new game?" : "End this game?"}
      >
        <div className="grid gap-4">
          <p className="text-muted">This game ends with {score} points. Your score is saved.</p>
          <div className="grid grid-cols-2 gap-3">
            <Button variant="secondary" onClick={() => setConfirmEnd(null)}>
              Keep playing
            </Button>
            <Button onClick={() => void (confirmEnd === "new" ? newGame() : endGame())}>
              {confirmEnd === "new" ? "New game" : "End game"}
            </Button>
          </div>
        </div>
      </Modal>

      <Modal open={period !== null} onClose={() => setPeriod(null)} title="Leaderboards">
        <div className="grid gap-4">
          <div className="grid grid-cols-3 gap-1 rounded-2xl bg-panel-2 p-1 text-sm">
            {PERIODS.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => void openBoard(p.id)}
                className={`rounded-xl px-2 py-2 font-semibold ${period === p.id ? "bg-accent text-ink" : "text-muted"}`}
              >
                {p.label}
              </button>
            ))}
          </div>
          {!board && <p className="text-center text-muted">Loading…</p>}
          {board && board.entries.length === 0 && (
            <p className="text-center text-muted">No scores yet. Be the first!</p>
          )}
          {board && board.entries.length > 0 && (
            <ol className="grid gap-1">
              {board.entries.map((e) => (
                <li
                  key={e.rank}
                  className={`flex items-center gap-3 rounded-xl px-3 py-2 ${e.you ? "bg-accent/15 text-accent" : "bg-panel-2"}`}
                >
                  <span className="w-6 text-right font-bold tabular-nums text-muted">{e.rank}</span>
                  <span className="min-w-0 flex-1 truncate font-semibold">{e.name}</span>
                  <span className="font-bold tabular-nums">{e.score}</span>
                </li>
              ))}
            </ol>
          )}
          {board?.you && !board.entries.some((e) => e.you) && (
            <p className="rounded-xl bg-accent/15 px-3 py-2 text-sm text-accent">
              You: #{board.you.rank} with {board.you.score}
            </p>
          )}
          {board && !board.signed_in && (
            <Button
              variant="secondary"
              onClick={() => {
                setPeriod(null);
                onCheckpoint();
              }}
            >
              Save your progress to join the leaderboards
            </Button>
          )}
          {board?.signed_in && !me?.name && (
            <p className="text-xs text-muted">You show as "Anonymous player". Pick a name in Settings.</p>
          )}
          <p className="text-xs text-muted">Best score per player. Games with bought help don't count. Weeks start on Monday (UTC).</p>
        </div>
      </Modal>

      {result && level !== undefined && (
        <ResultCard
          won
          stars={result.stars}
          detail={[
            `${result.placed} shapes (3 stars: ${result.par} or fewer)`,
            result.coins_earned + result.streak_bonus > 0 ? `+${result.coins_earned + result.streak_bonus} coins` : "",
          ]
            .filter(Boolean)
            .join(" · ")}
          hasNext={level < (me?.games.gridsnap.level_count ?? 0) && result.unlocked_level > level}
          onNext={() => onLevel?.(level + 1)}
          onRetry={() => void retry()}
          onLevels={onBack}
        />
      )}

      {final && level === undefined && (
        <div className="absolute inset-0 z-20 grid place-items-center bg-ink/70 p-6 backdrop-blur-sm">
          <div className="pop-in w-full max-w-sm rounded-3xl border border-line bg-panel p-6 text-center">
            <h2 className="text-3xl font-black">{final.new_best ? "New best!" : "Game over"}</h2>
            <p className="my-3 text-5xl font-black tabular-nums">{final.score}</p>
            <p className="text-muted">
              {final.lines} lines · best {final.best}
              {final.coins_earned > 0 ? ` · +${final.coins_earned} coins` : ""}
            </p>
            {!final.ranked && (
              <p className="mt-2 text-xs text-muted">
                {me?.signed_in ? "Bought help was used: this game isn't on the leaderboards." : "Save your progress to get on the leaderboards."}
              </p>
            )}
            <div className="mt-5 grid gap-3">
              <Button onClick={() => void newGame()}>Play again</Button>
              <Button variant="secondary" onClick={() => void openBoard("week")}>
                Leaderboards
              </Button>
              <Button variant="ghost" onClick={onBack}>
                All games
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
