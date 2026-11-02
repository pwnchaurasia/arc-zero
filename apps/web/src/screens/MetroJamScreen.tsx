import { useEffect, useRef, useState } from "react";

import { ApiError, api } from "../api/client";
import type { MjAssist, MjComplete, MjLevelData, MjMove, MjStart } from "../api/types";
import { engine, loadEngine } from "../engine/wasm";
import { haptic, sfx } from "../feel/audio";
import { MetroJamView, mjColor, type MjSnapshot } from "../games/metro-jam/MetroJamView";
import { getSettings, useSettings } from "../state/settings";
import { useSession } from "../state/session";
import { CoinChip } from "../ui/CoinChip";
import { LiftIcon, ParkingIcon, RestartIcon, ShuffleIcon } from "../ui/icons";
import { Button, IconButton, TopBar } from "../ui/kit";
import { ConfirmSpend, type SpendRequest } from "./ConfirmSpend";
import { ResultCard } from "./ResultCard";
import { useToast } from "./useToast";

type Sim = InstanceType<typeof engine.MetroJam>;

/** Move ops, as the engine numbers them. */
const OP = { tap: 0, airlift: 1, shuffle: 2, extra_bay: 3 } as const;

const ASSISTS: { kind: MjAssist; title: string; what: string; Icon: typeof ParkingIcon }[] = [
  { kind: "extra_bay", title: "Extra bay", what: "Adds one more parking bay for the rest of this attempt.", Icon: ParkingIcon },
  { kind: "airlift", title: "Airlift", what: "Lifts one car of your choice out of the jam into a free bay, even if it's blocked.", Icon: LiftIcon },
  { kind: "shuffle", title: "Shuffle", what: "Commuters you can see who match a parked car step to the front of the queue.", Icon: ShuffleIcon },
];

interface Game {
  start: MjStart;
  /** The queue as far as the server has revealed it. */
  known: number[];
  sim: Sim;
  moves: MjMove[];
  owned: Partial<Record<MjAssist, number>>;
  spent: number;
  done: boolean;
}

function build(data: MjLevelData, known: number[], moves: MjMove[]): Sim {
  const sim = new engine.MetroJam(JSON.stringify({ ...data, queue: known }));
  for (const [op, v] of moves) sim.apply(op, v);
  sim.takeEvents();
  return sim;
}

function snapshot(g: Game): MjSnapshot {
  const flat = g.sim.bays();
  const bays: [number, number][] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) bays.push([flat[i] ?? -1, flat[i + 1] ?? 0]);
  return {
    onGrid: g.start.data.vehicles.map((_, i) => g.sim.onGrid(i)),
    bays,
    waiting: Array.from(g.sim.waiting()),
    remaining: g.start.data.queue_len - g.sim.boarded(),
  };
}

function used(moves: MjMove[], kind: MjAssist): number {
  return moves.filter(([op]) => op === OP[kind]).length;
}

export function MetroJamScreen({
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
  const { colorSymbols } = useSettings();
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<MetroJamView | null>(null);
  const game = useRef<Game | null>(null);
  const picking = useRef(false);
  /** The animations still playing; the win screen waits for them. */
  const animating = useRef<Promise<void>>(Promise.resolve());
  /** The canvas and the hidden per-car buttons share one tap handler. */
  const tapRef = useRef<(vehicle: number) => void>(() => undefined);
  const [round, setRound] = useState(0);
  const [info, setInfo] = useState<MjStart | null>(null);
  const [moveCount, setMoveCount] = useState(0);
  const [stuck, setStuck] = useState(false);
  /** The player chose "Use coins" on the stuck card: hide it and point at the assists. */
  const [choosingAssist, setChoosingAssist] = useState(false);
  const [airlifting, setAirlifting] = useState(false);
  const [coins, setCoins] = useState<number | undefined>(undefined);
  const [owned, setOwned] = useState<Partial<Record<MjAssist, number>>>({});
  const [spend, setSpend] = useState<(SpendRequest & { kind: MjAssist }) | null>(null);
  const [buying, setBuying] = useState(false);
  const [result, setResult] = useState<MjComplete | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, showToast] = useToast();

  const replay = me ? me.games["metro-jam"].stars[String(level)] !== undefined : false;

  const refreshUi = (g: Game) => {
    setMoveCount(g.moves.length);
    const isStuck = g.sim.isStuck();
    setStuck(isStuck);
    if (!isStuck) setChoosingAssist(false);
    setOwned({ ...g.owned });
  };

  const submit = async (g: Game) => {
    if (g.done) return;
    g.done = true;
    try {
      const res = await api.mj.complete(level, g.start.attempt_id, g.moves);
      // Let the player watch the last commuters board and the last car leave.
      await animating.current;
      await new Promise((r) => setTimeout(r, 600));
      if (!game.current) return;
      sfx.win();
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

  /** Hard levels hide the far end of the queue: ask the server for what is now visible. */
  const reveal = async (g: Game) => {
    if (g.start.data.visible >= g.start.data.queue_len) return;
    try {
      const { queue } = await api.mj.reveal(level, g.start.attempt_id, g.moves);
      if (game.current !== g || queue.length <= g.known.length) return;
      const more = queue.slice(g.known.length);
      g.known = queue;
      g.sim.extendQueue(new Uint8Array(more));
      animating.current = view.current?.play(Array.from(g.sim.takeEvents()), snapshot(g)) ?? Promise.resolve();
      refreshUi(g);
      if (g.sim.isWon()) void submit(g);
    } catch (e) {
      showToast(e instanceof ApiError ? e.message : "Connection problem. Try again.");
    }
  };

  const apply = (g: Game, op: number, vehicle: number) => {
    g.sim.apply(op, vehicle);
    g.moves.push([op, vehicle]);
    animating.current = view.current?.play(Array.from(g.sim.takeEvents()), snapshot(g)) ?? Promise.resolve();
    refreshUi(g);
    if (g.sim.isWon()) void submit(g);
    else void reveal(g);
  };

  useEffect(() => {
    let cancelled = false;
    let created: MetroJamView | null = null;
    setInfo(null);
    setResult(null);
    setStuck(false);
    setMoveCount(0);
    setError(null);
    setAirlifting(false);
    picking.current = false;

    const tap = (vehicle: number) => {
      const g = game.current;
      const v = view.current;
      if (!g || !v || g.done) return;
      sfx.unlock();
      if (picking.current) {
        picking.current = false;
        setAirlifting(false);
        apply(g, OP.airlift, vehicle);
        sfx.complete();
        haptic(12);
        return;
      }
      const blocker = g.sim.blocker(vehicle);
      if (blocker === -3) return;
      if (blocker !== -1) {
        v.bump(vehicle, blocker);
        sfx.invalid();
        haptic(25);
        return;
      }
      if (!Array.from(g.sim.tappable()).includes(vehicle)) {
        sfx.invalid();
        haptic(25);
        showToast("Every bay is full. Use an assist, or replay the level.");
        return;
      }
      sfx.tap();
      haptic(8);
      apply(g, OP.tap, vehicle);
    };
    tapRef.current = tap;

    (async () => {
      await loadEngine();
      const start = await api.mj.start(level);
      if (cancelled || !host.current) return;
      const g: Game = {
        start,
        known: start.data.queue,
        sim: build(start.data, start.data.queue, []),
        moves: [],
        owned: {},
        spent: 0,
        done: false,
      };
      game.current = g;
      created = await MetroJamView.create(host.current, start.data, snapshot(g), {
        onTap: tap,
        symbols: getSettings().colorSymbols,
      });
      if (cancelled) {
        created.destroy();
        return;
      }
      view.current = created;
      setInfo(start);
      setCoins(start.coins);
      setOwned({});
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
    // `apply` and `showToast` only touch refs and stable setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [level, round]);

  useEffect(() => {
    view.current?.setSymbols(colorSymbols);
  }, [colorSymbols]);

  const rebuild = (moves: MjMove[]) => {
    const g = game.current;
    if (!g || g.done) return;
    g.sim.free();
    g.moves = moves;
    g.sim = build(g.start.data, g.known, moves);
    view.current?.sync(snapshot(g));
    animating.current = Promise.resolve();
    picking.current = false;
    setAirlifting(false);
    refreshUi(g);
  };

  const restart = () => rebuild([]);

  /** Whether the assist would do anything right now (never charge for a no-op). */
  const usable = (g: Game, kind: MjAssist): string | null => {
    const probe = build(g.start.data, g.known, g.moves);
    try {
      if (kind === "airlift") {
        return Array.from(probe.bays()).some((v, i) => i % 2 === 0 && v === -1)
          ? null
          : "Airlift needs a free bay. Add a bay first.";
      }
      probe.apply(OP[kind], 0);
      return null;
    } catch {
      return kind === "shuffle" ? "Nothing to shuffle right now." : "No more bays can be added.";
    } finally {
      probe.free();
    }
  };

  const runAssist = (g: Game, kind: MjAssist) => {
    if (kind === "airlift") {
      picking.current = true;
      setAirlifting(true);
      return;
    }
    apply(g, OP[kind], 0);
  };

  const onAssist = (kind: MjAssist) => {
    const g = game.current;
    if (!g || g.done) return;
    const problem = usable(g, kind);
    if (problem) {
      showToast(problem);
      return;
    }
    // Already paid for in this attempt (e.g. before a replay): free to use again.
    if ((g.owned[kind] ?? 0) > used(g.moves, kind)) {
      runAssist(g, kind);
      return;
    }
    const a = ASSISTS.find((x) => x.kind === kind);
    if (!a) return;
    setSpend({
      kind,
      title: a.title,
      what: a.what,
      price: g.start.prices[kind],
      balance: coins ?? 0,
      reward: replay ? null : g.start.reward,
      spent: g.spent,
      note: "If you replay the level, assists you paid for in this attempt can be used again for free.",
    });
  };

  const confirmSpend = async () => {
    const g = game.current;
    if (!g || !spend) return;
    setBuying(true);
    try {
      const res = await api.mj.buy(level, g.start.attempt_id, spend.kind, spend.price);
      g.owned = res.owned;
      g.spent = res.spent;
      setCoins(res.coins);
      setOwned({ ...res.owned });
      void refresh();
      setSpend(null);
      runAssist(g, spend.kind);
    } catch (e) {
      setSpend(null);
      showToast(e instanceof ApiError ? e.message : "Could not buy that right now.");
    } finally {
      setBuying(false);
    }
  };

  const count = me?.games["metro-jam"].level_count ?? 0;
  const resultDetail = (r: MjComplete) => {
    if (!r.first_clear) return "Replay: no coins this time.";
    const parts = [`+${r.coins_earned} coins`];
    if (r.streak_bonus) parts.push(`+${r.streak_bonus} streak bonus`);
    return parts.join(" · ");
  };
  const hidden = info ? info.data.visible < info.data.queue_len : false;

  return (
    <div className="relative flex h-full flex-col">
      <TopBar
        title={`Level ${level}`}
        onBack={onBack}
        right={
          <div className="flex items-center gap-2">
            <CoinChip balance={coins} />
            <IconButton label="Replay level" onClick={restart} disabled={!info || moveCount === 0}>
              <RestartIcon />
            </IconButton>
          </div>
        }
      />
      <div className="flex items-center justify-between px-5 text-sm text-muted">
        <span>{info ? `${info.data.bays} bays · ${info.data.queue_len} commuters` : " "}</span>
        {info && <span>{replay ? "Replay: no coins" : `First clear: ${info.reward} coins`}</span>}
      </div>
      <div className="relative min-h-0 flex-1">
        <div ref={host} className="game-surface absolute inset-0" />
        {stuck && !choosingAssist && !airlifting && !result && (
          <div className="absolute inset-0 z-10 grid place-items-center bg-ink/55 p-6 backdrop-blur-[2px]">
            <div className="pop-in w-full max-w-xs rounded-3xl border border-line bg-panel p-5 text-center shadow-2xl">
              <h2 className="text-2xl font-black">Stuck!</h2>
              <p className="mt-1 mb-4 text-sm text-muted">No car can park. Replay the level, or use coins on an assist.</p>
              <div className="grid gap-3">
                <Button onClick={restart}>Replay level</Button>
                <Button variant="secondary" onClick={() => setChoosingAssist(true)}>
                  Use coins
                </Button>
              </div>
            </div>
          </div>
        )}
        {/* Messages float over the scene so it never jumps. */}
        <div className="pointer-events-none absolute inset-x-3 bottom-3 grid gap-2 [&>*]:pointer-events-auto">
        {stuck && choosingAssist && !airlifting && (
          <p className="rounded-xl bg-amber-950/90 p-3 text-center text-sm text-amber-100 shadow-lg backdrop-blur">
            Pick an assist below, or replay the level.
          </p>
        )}
        {airlifting && (
          <div className="flex items-center justify-between gap-3 rounded-xl bg-sky-950/90 p-3 text-sm text-sky-100 shadow-lg backdrop-blur">
            <span>Tap any car to lift it into a bay.</span>
            <button
              type="button"
              className="font-semibold underline"
              onClick={() => {
                picking.current = false;
                setAirlifting(false);
              }}
            >
              Cancel
            </button>
          </div>
        )}
        </div>
      </div>
      {/* The canvas can't be read by screen readers or used by keyboard: one button per car. */}
      <div className="sr-only" role="group" aria-label="Cars in the jam">
        {info?.data.vehicles.map((v, i) =>
          game.current?.sim.onGrid(i) ? (
            <button key={i} type="button" onClick={() => tapRef.current(i)}>
              {`Car ${i + 1}: ${mjColor(v.color).name} ${v.kind}`}
            </button>
          ) : null,
        )}
      </div>
      <div className="flex justify-center gap-3 px-4 pb-[max(env(safe-area-inset-bottom),12px)] pt-2">
        {ASSISTS.map(({ kind, title, Icon }) => {
          const left = (owned[kind] ?? 0) - used(game.current?.moves ?? [], kind);
          return (
            <button
              key={kind}
              type="button"
              disabled={!info || !!result}
              onClick={() => onAssist(kind)}
              className={`relative flex min-h-14 min-w-24 flex-col items-center justify-center rounded-2xl border bg-panel-2 px-3 py-1.5 text-xs font-semibold transition hover:bg-line active:scale-95 disabled:opacity-40 ${
                stuck && choosingAssist ? "animate-pulse border-gold" : "border-line"
              }`}
            >
              <Icon size={20} />
              <span>{title}</span>
              <span className="text-[11px] text-gold">{left > 0 ? "paid · free now" : `${info?.prices[kind] ?? "…"} coins`}</span>
            </button>
          );
        })}
      </div>
      {hidden && (
        <p className="sr-only">Only the next {info?.data.visible} commuters are visible on this level.</p>
      )}
      {error && (
        <p className="absolute inset-x-5 bottom-24 rounded-xl bg-red-500/20 p-3 text-center text-sm text-red-200">
          {error}
        </p>
      )}
      {toast && (
        <p className="absolute inset-x-5 bottom-24 rounded-xl bg-panel-2 p-3 text-center text-sm">{toast}</p>
      )}
      <ConfirmSpend
        request={spend}
        busy={buying}
        onConfirm={() => void confirmSpend()}
        onCancel={() => setSpend(null)}
      />
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
