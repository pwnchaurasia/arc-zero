import { useEffect, useRef, useState } from "react";

import { ApiError, api } from "../api/client";
import type { Board, WsComplete, WsMove, WsStart } from "../api/types";
import { engine, loadEngine } from "../engine/wasm";
import { haptic, sfx } from "../feel/audio";
import { HIDDEN, WaterSortView } from "../games/water-sort/WaterSortView";
import { getSettings, useSettings } from "../state/settings";
import { useSession } from "../state/session";
import { CoinChip } from "../ui/CoinChip";
import { BulbIcon, RestartIcon, UndoIcon } from "../ui/icons";
import { IconButton, TopBar } from "../ui/kit";
import { ConfirmSpend, type SpendRequest } from "./ConfirmSpend";
import { ResultCard } from "./ResultCard";
import { useToast } from "./useToast";

/** The engine's "add an empty bottle" move (the paid assist). */
const ADD_BOTTLE: WsMove = [254, 254];

type Sim = InstanceType<typeof engine.WaterSort>;

interface Game {
  start: WsStart;
  sim: Sim;
  moves: WsMove[];
  /** Board before each move, for undo. */
  history: Board[];
  selected: number | null;
  done: boolean;
  /** Extra bottles bought in this attempt (undo gives them back to use again). */
  bottlesOwned: number;
  spent: number;
}

function makeSim(capacity: number, board: Board): Sim {
  return new engine.WaterSort(JSON.stringify({ capacity, bottles: board }));
}

function isComplete(bottle: number[] | undefined, capacity: number): boolean {
  return !!bottle && bottle.length === capacity && bottle.every((c) => c === bottle[0] && c !== HIDDEN);
}

function bottlesUsed(moves: WsMove[]): number {
  return moves.filter(([a, b]) => a === ADD_BOTTLE[0] && b === ADD_BOTTLE[1]).length;
}

export function WaterSortScreen({
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
  const view = useRef<WaterSortView | null>(null);
  const game = useRef<Game | null>(null);
  const [round, setRound] = useState(0);
  const [info, setInfo] = useState<WsStart | null>(null);
  const [moves, setMoves] = useState(0);
  const [hints, setHints] = useState(0);
  const [coins, setCoins] = useState<number | undefined>(undefined);
  const [stuck, setStuck] = useState(false);
  const [result, setResult] = useState<WsComplete | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<(SpendRequest & { type: "bottle" | "hint" }) | null>(null);
  const [buying, setBuying] = useState(false);
  const [toast, showToast] = useToast();
  const replay = me ? me.games["water-sort"].stars[String(level)] !== undefined : false;

  const board = (g: Game) => (JSON.parse(g.sim.toJson()) as { bottles: Board }).bottles;

  /** Hidden levels: the server shows what the latest moves uncovered. */
  const syncWithServer = async (g: Game, animation: Promise<void> = Promise.resolve()) => {
    if (!g.start.hidden) return;
    const asked = g.moves.length;
    try {
      const [{ board: seen }] = await Promise.all([api.ws.reveal(level, g.start.attempt_id, g.moves), animation]);
      // A later move or undo already asked again; its answer wins.
      if (game.current !== g || g.moves.length !== asked) return;
      g.sim.free();
      g.sim = makeSim(g.start.capacity, seen);
      view.current?.reveal(seen);
      setStuck(!g.sim.hasMoves());
    } catch (e) {
      showToast(e instanceof ApiError ? e.message : "Connection problem. Try again.");
    }
  };

  useEffect(() => {
    let cancelled = false;
    let created: WaterSortView | null = null;
    setInfo(null);
    setResult(null);
    setStuck(false);
    setMoves(0);
    setError(null);

    const submit = async (g: Game) => {
      try {
        const res = await api.ws.complete(level, g.start.attempt_id, g.moves);
        await new Promise((r) => setTimeout(r, 650)); // let the last pour finish
        if (cancelled) return;
        sfx.win();
        haptic(30);
        setResult(res);
        if (res.coins !== null) setCoins(res.coins);
        void refresh();
        if (res.registration_required) onCheckpoint();
      } catch (e) {
        g.done = false;
        setError(e instanceof ApiError ? e.message : "Could not save this result.");
      }
    };

    const tap = (i: number) => {
      const g = game.current;
      const v = view.current;
      if (!g || !v || g.done) return;
      sfx.unlock();
      v.showHint(null);
      const capacity = g.start.capacity;
      const current = board(g);

      if (g.selected === null) {
        const top = current[i]?.at(-1);
        if (!current[i]?.length || isComplete(current[i], capacity) || top === HIDDEN) {
          v.shake(i);
          return;
        }
        g.selected = i;
        v.select(i);
        sfx.tap();
        haptic(6);
        return;
      }
      if (g.selected === i) {
        g.selected = null;
        v.select(null);
        return;
      }
      const from = g.selected;
      g.selected = null;
      v.select(null);
      if (g.sim.canPour(from, i) < 0) {
        sfx.invalid();
        haptic(25);
        v.shake(i);
        return;
      }
      g.history.push(current);
      g.sim.pour(from, i);
      g.moves.push([from, i]);
      const after = board(g);
      sfx.pour(after[i]?.length ?? 0);
      haptic(10);
      const animation = v.pour(from, i, after).then(() => {
        if (isComplete(after[i], capacity) && !isComplete(current[i], capacity)) {
          v.celebrate(i);
          sfx.complete();
        }
      });
      setMoves(g.moves.length - bottlesUsed(g.moves));
      if (g.sim.isSolved()) {
        g.done = true;
        setStuck(false);
        void submit(g);
      } else if (g.start.hidden) {
        void syncWithServer(g, animation);
      } else {
        setStuck(!g.sim.hasMoves());
      }
    };

    (async () => {
      await loadEngine();
      const start = await api.ws.start(level);
      if (cancelled || !host.current) return;
      const sim = makeSim(start.capacity, start.board);
      game.current = {
        start,
        sim,
        moves: [],
        history: [],
        selected: null,
        done: false,
        bottlesOwned: 0,
        spent: 0,
      };
      created = await WaterSortView.create(host.current, start.board, {
        onTap: tap,
        symbols: getSettings().colorSymbols,
        capacity: start.capacity,
      });
      if (cancelled) {
        created.destroy();
        return;
      }
      view.current = created;
      setInfo(start);
      setHints(start.hints_left);
      setCoins(start.coins);
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
    // `syncWithServer` and `showToast` only touch refs and stable setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [level, round, refresh, onCheckpoint]);

  useEffect(() => {
    view.current?.setSymbols(colorSymbols);
  }, [colorSymbols]);

  const resetTo = (b: Board) => {
    const g = game.current;
    if (!g || g.done) return;
    g.sim.free();
    g.sim = makeSim(g.start.capacity, b);
    g.selected = null;
    view.current?.setBoard(b);
    setMoves(g.moves.length - bottlesUsed(g.moves));
    setStuck(false);
    // Colours seen on the undone path stay visible.
    void syncWithServer(g);
  };

  const undo = () => {
    const g = game.current;
    const prev = g?.history.pop();
    if (!g || prev === undefined) return;
    g.moves.pop();
    resetTo(prev);
  };

  const restart = () => {
    const g = game.current;
    if (!g) return;
    g.moves = [];
    g.history = [];
    resetTo(g.start.board);
  };

  const addBottle = (g: Game) => {
    g.history.push(board(g));
    g.sim.addBottle();
    g.moves.push(ADD_BOTTLE);
    view.current?.setBoard(board(g));
    setStuck(false);
    sfx.complete();
  };

  const onBottle = () => {
    const g = game.current;
    if (!g || g.done) return;
    const used = bottlesUsed(g.moves);
    if (used >= 2) {
      showToast("You can add at most 2 bottles to a level.");
      return;
    }
    // Already paid for in this attempt (e.g. before an undo): free to add again.
    if (g.bottlesOwned > used) {
      addBottle(g);
      return;
    }
    setPending({
      type: "bottle",
      title: "an extra bottle",
      what: "Adds one empty bottle for the rest of this attempt.",
      price: g.start.prices.extra_bottle ?? 60,
      balance: coins ?? 0,
      reward: replay ? null : g.start.reward,
      spent: g.spent,
      note: "Undo gives the bottle back to use again in this attempt.",
    });
  };

  const showHint = async (pay?: number) => {
    const g = game.current;
    if (!g || g.done) return;
    try {
      const res = await api.ws.hint(level, g.start.attempt_id, g.moves, pay);
      setHints(res.hints_left);
      if (res.coins !== null) setCoins(res.coins);
      if (pay) g.spent += pay;
      if (res.dead_end) {
        setStuck(true);
        showToast("No way forward from here. Undo or restart (hint not used).");
      } else if (res.move) {
        view.current?.showHint(res.move);
      }
    } catch (e) {
      showToast(e instanceof ApiError ? e.message : "Hint unavailable.");
    }
  };

  const hint = () => {
    const g = game.current;
    if (!g || g.done) return;
    if (hints > 0) {
      void showHint();
      return;
    }
    setPending({
      type: "hint",
      title: "a hint",
      what: "Shows a good next pour.",
      price: g.start.hint_price,
      balance: coins ?? 0,
      reward: replay ? null : g.start.reward,
      spent: g.spent,
    });
  };

  const confirmSpend = async () => {
    const g = game.current;
    const p = pending;
    if (!g || !p) return;
    setBuying(true);
    try {
      if (p.type === "hint") {
        await showHint(p.price);
      } else {
        const res = await api.ws.buy(level, g.start.attempt_id, p.price);
        g.bottlesOwned = res.owned.extra_bottle ?? g.bottlesOwned + 1;
        g.spent = res.spent;
        setCoins(res.coins);
        addBottle(g);
      }
      void refresh();
    } catch (e) {
      showToast(e instanceof ApiError ? e.message : "Could not do that right now.");
    } finally {
      setBuying(false);
      setPending(null);
    }
  };

  const count = me?.games["water-sort"].level_count ?? 0;
  const resultDetail = (r: WsComplete) => {
    const parts = [`${r.moves} moves`];
    if (!r.first_clear) parts.push("replay: no coins");
    else {
      parts.push(`+${r.coins_earned} coins`);
      if (r.streak_bonus) parts.push(`+${r.streak_bonus} streak bonus`);
    }
    return parts.join(" · ");
  };

  return (
    <div className="relative flex h-full flex-col">
      <TopBar
        title={
          // Four buttons share this header on phones: keep the title short there.
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
            <IconButton label={hints > 0 ? "Hint" : "Hint (coins)"} badge={hints} onClick={hint} disabled={!info}>
              <BulbIcon />
            </IconButton>
            <IconButton label="Undo" onClick={undo} disabled={!info || moves === 0}>
              <UndoIcon />
            </IconButton>
            <IconButton label="Restart" onClick={restart} disabled={!info || moves === 0}>
              <RestartIcon />
            </IconButton>
          </div>
        }
      />
      <div className="flex items-center justify-between px-5 text-sm text-muted">
        <span>
          Moves {moves}
          {info?.hidden ? " · hidden colours" : ""}
        </span>
        {info && <span>★★★ in {info.three_star_moves} or fewer</span>}
      </div>
      {stuck && (
        <p className="mx-5 mt-2 rounded-xl bg-amber-500/15 p-3 text-center text-sm text-amber-200">
          No moves left. Undo, restart, or add a bottle.
        </p>
      )}
      <div ref={host} className="game-surface relative min-h-0 flex-1" />
      <div className="flex justify-center px-4 pb-[max(env(safe-area-inset-bottom),12px)] pt-2">
        <button
          type="button"
          disabled={!info || !!result || !!pending}
          onClick={onBottle}
          className="flex min-h-14 min-w-32 flex-col items-center justify-center rounded-2xl border border-line bg-panel-2 px-4 py-1.5 text-xs font-semibold transition hover:bg-line active:scale-95 disabled:opacity-40"
        >
          <span>+ Empty bottle</span>
          <span className="text-[11px] text-gold">{info?.prices.extra_bottle ?? "…"} coins</span>
        </button>
      </div>
      {error && (
        <p className="absolute inset-x-5 bottom-24 rounded-xl bg-red-500/20 p-3 text-center text-sm text-red-200">
          {error}
        </p>
      )}
      {toast && (
        <p className="absolute inset-x-5 bottom-24 rounded-xl bg-panel-2 p-3 text-center text-sm">{toast}</p>
      )}
      <ConfirmSpend
        request={pending}
        busy={buying}
        onConfirm={() => void confirmSpend()}
        onCancel={() => setPending(null)}
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
