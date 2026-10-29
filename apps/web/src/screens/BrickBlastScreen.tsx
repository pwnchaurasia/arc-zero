import { useEffect, useRef, useState } from "react";

import { ApiError, api } from "../api/client";
import type { BbState, BbTurn } from "../api/types";
import { engine, loadEngine } from "../engine/wasm";
import { sfx } from "../feel/audio";
import { BrickBlastView } from "../games/brick-blast/BrickBlastView";
import { useSession } from "../state/session";
import { BulbIcon, FastIcon, SkipIcon } from "../ui/icons";
import { IconButton, TopBar } from "../ui/kit";
import { ResultCard } from "./ResultCard";
import { useToast } from "./useToast";

const SPEEDS = [1, 2, 4] as const;

function stateFromError(e: unknown): BbState | null {
  if (e instanceof ApiError && e.details.state && typeof e.details.state === "object") {
    return e.details.state as BbState;
  }
  return null;
}

export function BrickBlastScreen({
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
  const view = useRef<BrickBlastView | null>(null);
  const run = useRef<{ id: string; state: BbState; busy: boolean } | null>(null);
  const pendingRetry = useRef<{ turn: number; aim: number } | null>(null);
  const [round, setRound] = useState(0);
  const [state, setState] = useState<BbState | null>(null);
  const [hints, setHints] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1);
  const [result, setResult] = useState<BbTurn | null>(null);
  const [lost, setLost] = useState(false);
  const [offline, setOffline] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, showToast] = useToast();

  useEffect(() => {
    let cancelled = false;
    let created: BrickBlastView | null = null;
    setState(null);
    setResult(null);
    setLost(false);
    setError(null);
    setOffline(false);

    const settle = (next: BbState, turnResult: BbTurn | null) => {
      const r = run.current;
      if (!r || cancelled) return;
      r.state = next;
      r.busy = false;
      setState(next);
      view.current?.setState(next);
      if (next.status === "won") {
        sfx.win();
        if (turnResult) setResult(turnResult);
        void refresh();
        if (turnResult?.registration_required) onCheckpoint();
      } else if (next.status === "lost") {
        sfx.lose();
        setLost(true);
      } else {
        view.current?.setAimEnabled(true);
      }
    };

    const fire = async (aim: number) => {
      const r = run.current;
      const v = view.current;
      if (!r || !v || r.busy || r.state.status !== "playing") return;
      r.busy = true;
      v.setAimEnabled(false);
      setPlaying(true);

      // Animate locally while the server simulates the same turn; the server wins.
      const sim = new engine.BrickTurn(JSON.stringify(r.state), aim);
      const server = api.bb.turn(r.id, r.state.turn, aim).then(
        (ok) => ({ ok }),
        (err: unknown) => ({ err }),
      );
      let finished = false;
      try {
        await v.play(sim);
        const res = await server;
        if (cancelled) return;
        if ("ok" in res) {
          if (res.ok.new_row) sim.provideRow(JSON.stringify(res.ok.new_row));
          const local = JSON.parse(sim.finish()) as { hash: string };
          finished = true;
          if (local.hash !== res.ok.hash) {
            console.warn("brick blast: local simulation diverged; using server state");
          }
          settle(res.ok.state, res.ok);
        } else {
          const synced = stateFromError(res.err);
          if (synced) {
            showToast("Re-synced with the server.");
            settle(synced, null);
          } else {
            pendingRetry.current = { turn: r.state.turn, aim };
            setOffline(true);
          }
        }
      } finally {
        if (!finished) sim.free();
        setPlaying(false);
      }
    };

    (async () => {
      await loadEngine();
      const start = await api.bb.start(level);
      if (cancelled || !host.current) return;
      run.current = { id: start.run_id, state: start.state, busy: false };
      created = await BrickBlastView.create(host.current, { onFire: (aim) => void fire(aim) });
      if (cancelled) {
        created.destroy();
        return;
      }
      view.current = created;
      created.setState(start.state);
      created.setAimEnabled(true);
      setState(start.state);
      setHints(start.hints_left);
    })().catch((e: unknown) => {
      if (!cancelled) setError(e instanceof ApiError ? e.message : "Could not load this level.");
    });

    return () => {
      cancelled = true;
      created?.destroy();
      view.current = null;
      run.current = null;
    };
  }, [level, round, refresh, onCheckpoint, showToast]);

  useEffect(() => {
    view.current?.setSpeed(speed);
  }, [speed, playing]);

  /** Re-sends a turn that may or may not have reached the server, then shows the truth. */
  const retry = async () => {
    const r = run.current;
    const p = pendingRetry.current;
    if (!r || !p) return;
    try {
      const res = await api.bb.turn(r.id, p.turn, p.aim);
      apply(res.state, res);
    } catch (e) {
      const synced = stateFromError(e);
      if (synced) apply(synced, null);
      else return;
    }
    pendingRetry.current = null;
    setOffline(false);
  };

  const apply = (next: BbState, res: BbTurn | null) => {
    const r = run.current;
    if (!r) return;
    r.state = next;
    r.busy = false;
    setState(next);
    view.current?.setState(next);
    if (next.status === "won" && res) setResult(res);
    else if (next.status === "lost") setLost(true);
    else view.current?.setAimEnabled(true);
  };

  const hint = async () => {
    const r = run.current;
    if (!r || r.busy) return;
    try {
      const res = await api.bb.hint(r.id);
      setHints(res.hints_left);
      view.current?.showHintAim(res.aim);
    } catch (e) {
      showToast(e instanceof ApiError ? e.message : "Hint unavailable.");
    }
  };

  const count = me?.games["brick-blast"].level_count ?? 0;

  return (
    <div className="relative flex h-full flex-col">
      <TopBar
        title={`Level ${level}`}
        onBack={onBack}
        right={
          playing ? (
            <div className="flex gap-2">
              <IconButton
                label={`Speed ${speed}×`}
                onClick={() => setSpeed((s) => SPEEDS[(SPEEDS.indexOf(s) + 1) % SPEEDS.length] ?? 1)}
              >
                <span className="flex items-center text-xs font-bold">
                  <FastIcon size={16} />
                  {speed}×
                </span>
              </IconButton>
              <IconButton label="Skip to end of turn" onClick={() => view.current?.skip()}>
                <SkipIcon />
              </IconButton>
            </div>
          ) : (
            <IconButton label="Hint" badge={hints} onClick={hint} disabled={!state || hints <= 0}>
              <BulbIcon />
            </IconButton>
          )
        }
      />
      <div className="flex items-center justify-between px-5 text-sm text-muted">
        <span>Balls {state?.balls ?? "–"}</span>
        <span>Rows left {state?.rows_remaining ?? "–"}</span>
      </div>
      <div ref={host} className="game-surface relative min-h-0 flex-1" />
      {!playing && state?.status === "playing" && state.turn === 0 && (
        <p className="pointer-events-none absolute inset-x-0 bottom-8 text-center text-sm text-muted">
          Drag to aim, release to fire
        </p>
      )}
      {offline && (
        <div className="absolute inset-x-5 bottom-6 flex items-center justify-between gap-3 rounded-xl bg-panel-2 p-3 text-sm">
          <span>Connection lost.</span>
          <button type="button" className="font-bold text-accent" onClick={() => void retry()}>
            Retry
          </button>
        </div>
      )}
      {error && (
        <p className="absolute inset-x-5 bottom-6 rounded-xl bg-red-500/20 p-3 text-center text-sm text-red-200">
          {error}
        </p>
      )}
      {toast && (
        <p className="absolute inset-x-5 bottom-6 rounded-xl bg-panel-2 p-3 text-center text-sm">{toast}</p>
      )}
      {(result || lost) && (
        <ResultCard
          won={!!result}
          stars={result?.stars ?? 0}
          detail={result ? `Cleared in ${result.turn} turns` : "A block reached the ground."}
          hasNext={!!result && level < count && (result.unlocked_level ?? 0) > level}
          onNext={() => onLevel(level + 1)}
          onRetry={() => setRound((r) => r + 1)}
          onLevels={onBack}
        />
      )}
    </div>
  );
}
