import { useEffect, useRef, useState } from "react";

import { ApiError, api } from "../api/client";
import type { Board, WsComplete, WsMove, WsStart } from "../api/types";
import { engine, loadEngine } from "../engine/wasm";
import { haptic, sfx } from "../feel/audio";
import { WaterSortView } from "../games/water-sort/WaterSortView";
import { getSettings, useSettings } from "../state/settings";
import { useSession } from "../state/session";
import { BulbIcon, RestartIcon, UndoIcon } from "../ui/icons";
import { IconButton, TopBar } from "../ui/kit";
import { ResultCard } from "./ResultCard";
import { useToast } from "./useToast";

const CAPACITY = 4;

interface Game {
  start: WsStart;
  sim: InstanceType<typeof engine.WaterSort>;
  moves: WsMove[];
  history: string[];
  selected: number | null;
  done: boolean;
}

function isComplete(bottle: number[] | undefined): boolean {
  return !!bottle && bottle.length === CAPACITY && bottle.every((c) => c === bottle[0]);
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
  const [stuck, setStuck] = useState(false);
  const [result, setResult] = useState<WsComplete | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, showToast] = useToast();

  useEffect(() => {
    let cancelled = false;
    let created: WaterSortView | null = null;
    setInfo(null);
    setResult(null);
    setStuck(false);
    setMoves(0);
    setError(null);

    const board = (g: Game) => JSON.parse(g.sim.toJson()) as Board;

    const submit = async (g: Game) => {
      try {
        const res = await api.ws.complete(level, g.start.attempt_id, g.moves);
        await new Promise((r) => setTimeout(r, 650)); // let the last pour finish
        if (cancelled) return;
        sfx.win();
        haptic(30);
        setResult(res);
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
      const current = board(g);

      if (g.selected === null) {
        if (!current[i]?.length || isComplete(current[i])) {
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
      g.history.push(g.sim.toJson());
      g.sim.pour(from, i);
      g.moves.push([from, i]);
      const after = board(g);
      sfx.pour(after[i]?.length ?? 0);
      haptic(10);
      void v.pour(from, i, after).then(() => {
        if (isComplete(after[i]) && !isComplete(current[i])) {
          v.celebrate(i);
          sfx.complete();
        }
      });
      setMoves(g.moves.length);
      if (g.sim.isSolved()) {
        g.done = true;
        setStuck(false);
        void submit(g);
      } else {
        setStuck(!g.sim.hasMoves());
      }
    };

    (async () => {
      await loadEngine();
      const start = await api.ws.start(level);
      if (cancelled || !host.current) return;
      const sim = new engine.WaterSort(JSON.stringify(start.board));
      game.current = { start, sim, moves: [], history: [], selected: null, done: false };
      created = await WaterSortView.create(host.current, start.board, {
        onTap: tap,
        symbols: getSettings().colorSymbols,
      });
      if (cancelled) {
        created.destroy();
        return;
      }
      view.current = created;
      setInfo(start);
      setHints(start.hints_left);
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
  }, [level, round, refresh, onCheckpoint]);

  useEffect(() => {
    view.current?.setSymbols(colorSymbols);
  }, [colorSymbols]);

  const resetTo = (json: string) => {
    const g = game.current;
    if (!g || g.done) return;
    g.sim.free();
    g.sim = new engine.WaterSort(json);
    g.selected = null;
    view.current?.setBoard(JSON.parse(json) as Board);
    setMoves(g.moves.length);
    setStuck(false);
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
    resetTo(JSON.stringify(g.start.board));
  };

  const hint = async () => {
    const g = game.current;
    if (!g || g.done) return;
    try {
      const res = await api.ws.hint(level, g.start.attempt_id, g.moves);
      setHints(res.hints_left);
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

  const count = me?.games["water-sort"].level_count ?? 0;

  return (
    <div className="relative flex h-full flex-col">
      <TopBar
        title={`Level ${level}`}
        onBack={onBack}
        right={
          <div className="flex gap-2">
            <IconButton label="Hint" badge={hints} onClick={hint} disabled={!info || hints <= 0}>
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
        <span>Moves {moves}</span>
        {info && <span>★★★ in {info.three_star_moves} or fewer</span>}
      </div>
      {stuck && (
        <p className="mx-5 mt-2 rounded-xl bg-amber-500/15 p-3 text-center text-sm text-amber-200">
          No moves left. Undo or restart.
        </p>
      )}
      <div ref={host} className="game-surface relative min-h-0 flex-1" />
      {error && (
        <p className="absolute inset-x-5 bottom-6 rounded-xl bg-red-500/20 p-3 text-center text-sm text-red-200">
          {error}
        </p>
      )}
      {toast && (
        <p className="absolute inset-x-5 bottom-6 rounded-xl bg-panel-2 p-3 text-center text-sm">{toast}</p>
      )}
      {result && (
        <ResultCard
          won
          stars={result.stars}
          detail={`${result.moves} moves`}
          hasNext={level < count && result.unlocked_level > level}
          onNext={() => onLevel(level + 1)}
          onRetry={() => setRound((r) => r + 1)}
          onLevels={onBack}
        />
      )}
    </div>
  );
}
