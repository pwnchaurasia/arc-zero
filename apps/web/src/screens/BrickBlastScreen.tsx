import { useEffect, useRef, useState } from "react";

import { ApiError, api } from "../api/client";
import type { BbAssist, BbState, BbTurn, CoinRules } from "../api/types";
import { engine, loadEngine } from "../engine/wasm";
import { sfx } from "../feel/audio";
import { BrickBlastView } from "../games/brick-blast/BrickBlastView";
import { useSession } from "../state/session";
import { CoinChip } from "../ui/CoinChip";
import { BulbIcon, FastIcon, SkipIcon } from "../ui/icons";
import { IconButton, TopBar } from "../ui/kit";
import { ConfirmSpend, type SpendRequest } from "./ConfirmSpend";
import { ResultCard } from "./ResultCard";
import { useToast } from "./useToast";

const SPEEDS = [1, 2, 4] as const;

const ASSISTS: { kind: BbAssist; title: string; what: string; icon: string }[] = [
  { kind: "bonus_balls", title: "+15 balls", what: "15 extra balls for your next shot only.", icon: "＋" },
  { kind: "laser", title: "Laser", what: "Destroys every block in the column you picked.", icon: "⚡" },
  { kind: "hammer", title: "Hammer", what: "Smashes every block in the lowest row.", icon: "🔨" },
];

/** A spend waiting for confirmation: an assist (laser with its column) or a paid hint. */
type Pending = SpendRequest & ({ type: "assist"; kind: BbAssist; col: number } | { type: "hint" });

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
  const [rules, setRules] = useState<CoinRules | null>(null);
  const [coins, setCoins] = useState<number | undefined>(undefined);
  const [spent, setSpent] = useState(0);
  const [picking, setPicking] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [buying, setBuying] = useState(false);
  const replay = me ? me.games["brick-blast"].stars[String(level)] !== undefined : false;
  const reward = rules ? (rules.rewards.find((r) => level >= r.first_level && level <= r.last_level)?.coins ?? 0) : 0;

  useEffect(() => {
    let cancelled = false;
    let created: BrickBlastView | null = null;
    setState(null);
    setResult(null);
    setLost(false);
    setError(null);
    setOffline(false);
    setSpent(0);
    setPicking(false);

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
      created = await BrickBlastView.create(host.current, {
        onFire: (aim) => void fire(aim),
        onColumn: (col) => onColumnRef.current(col),
      });
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

  // Prices and the coin balance for the confirmation popups.
  useEffect(() => {
    api.coins().then(
      (r) => {
        setRules(r);
        setCoins(r.balance);
      },
      () => undefined,
    );
  }, []);

  const onColumnRef = useRef<(col: number) => void>(() => undefined);
  onColumnRef.current = (col: number) => {
    view.current?.setColumnPicking(false);
    setPicking(false);
    askAssist("laser", col);
  };

  const askAssist = (kind: BbAssist, col = 0) => {
    const a = ASSISTS.find((x) => x.kind === kind);
    const price = rules?.prices["brick-blast"]?.[kind];
    if (!a || price === undefined) return;
    setPending({
      type: "assist",
      kind,
      col,
      title: kind === "laser" ? `Laser on column ${col + 1}` : a.title,
      what: a.what,
      price,
      balance: coins ?? 0,
      reward: replay ? null : reward,
      spent,
    });
  };

  const onAssist = (kind: BbAssist) => {
    const r = run.current;
    if (!r || r.busy || r.state.status !== "playing") return;
    if (kind === "bonus_balls" && (r.state.bonus ?? 0) > 0) {
      showToast("Your next shot already has 15 extra balls.");
      return;
    }
    if (kind === "laser") {
      setPicking(true);
      view.current?.setAimEnabled(false);
      view.current?.setColumnPicking(true);
      return;
    }
    askAssist(kind);
  };

  const cancelPicking = () => {
    setPicking(false);
    view.current?.setColumnPicking(false);
    if (run.current?.state.status === "playing") view.current?.setAimEnabled(true);
  };

  const confirmSpend = async () => {
    const r = run.current;
    const p = pending;
    if (!r || !p) return;
    setBuying(true);
    try {
      if (p.type === "hint") {
        const res = await api.bb.hint(r.id, p.price);
        if (res.coins !== null) setCoins(res.coins);
        view.current?.showHintAim(res.aim);
      } else {
        const res = await api.bb.assist(r.id, r.state.turn, p.kind, p.price, p.col);
        if (res.coins !== null) setCoins(res.coins);
        apply(res.state, res);
        sfx.laser();
      }
      setSpent((s) => s + p.price);
      void refresh();
    } catch (e) {
      const synced = stateFromError(e);
      if (synced) apply(synced, null);
      showToast(e instanceof ApiError ? e.message : "Could not do that right now.");
      if (run.current?.state.status === "playing") view.current?.setAimEnabled(true);
    } finally {
      setBuying(false);
      setPending(null);
    }
  };

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
    if (hints <= 0) {
      // Free hints used up today: a hint costs coins, after confirmation.
      if (!rules) return;
      setPending({
        type: "hint",
        title: "a hint",
        what: "Shows a good aim for this shot.",
        price: rules.hint_price,
        balance: coins ?? 0,
        reward: replay ? null : reward,
        spent,
      });
      return;
    }
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
            <div className="flex items-center gap-2">
              <CoinChip balance={coins} />
              <IconButton label={hints > 0 ? "Hint" : "Hint (coins)"} badge={hints} onClick={hint} disabled={!state}>
                <BulbIcon />
              </IconButton>
            </div>
          )
        }
      />
      <div className="flex items-center justify-between px-5 text-sm text-muted">
        <span>Balls {state?.balls ?? "–"}</span>
        <span>Rows left {state?.rows_remaining ?? "–"}</span>
      </div>
      <div ref={host} className="game-surface relative min-h-0 flex-1" />
      {picking && (
        <div className="absolute inset-x-5 top-28 flex items-center justify-between gap-3 rounded-xl bg-sky-950/90 p-3 text-sm text-sky-100 shadow-lg">
          <span>Tap a column for the laser.</span>
          <button type="button" className="font-semibold underline" onClick={cancelPicking}>
            Cancel
          </button>
        </div>
      )}
      {/* Always shown while the level runs (disabled mid-shot) so the board never jumps. */}
      {state?.status === "playing" && (
        <div className="flex justify-center gap-3 px-4 pb-[max(env(safe-area-inset-bottom),12px)] pt-2">
          {ASSISTS.map((a) => (
            <button
              key={a.kind}
              type="button"
              disabled={!rules || playing || picking || !!pending}
              onClick={() => onAssist(a.kind)}
              className="flex min-h-14 min-w-24 flex-col items-center justify-center rounded-2xl border border-line bg-panel-2 px-3 py-1.5 text-xs font-semibold transition hover:bg-line active:scale-95 disabled:opacity-40"
            >
              <span className="text-base leading-none" aria-hidden="true">
                {a.icon}
              </span>
              <span>{a.title}</span>
              <span className="text-[11px] text-gold">{rules?.prices["brick-blast"]?.[a.kind] ?? "…"} coins</span>
            </button>
          ))}
        </div>
      )}
      <ConfirmSpend
        request={pending}
        busy={buying}
        onConfirm={() => void confirmSpend()}
        onCancel={() => {
          setPending(null);
          if (run.current?.state.status === "playing") view.current?.setAimEnabled(true);
        }}
      />
      {!playing && state?.status === "playing" && state.turn === 0 && (
        <p className="pointer-events-none absolute inset-x-0 bottom-24 text-center text-sm text-muted">
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
          detail={result ? winDetail(result) : "A block reached the ground."}
          hasNext={!!result && level < count && (result.unlocked_level ?? 0) > level}
          onNext={() => onLevel(level + 1)}
          onRetry={() => setRound((r) => r + 1)}
          onLevels={onBack}
        />
      )}
    </div>
  );
}

function winDetail(r: BbTurn): string {
  const parts = [`Cleared in ${r.turn} turns`];
  if (r.first_clear === false) parts.push("replay: no coins");
  else if (r.first_clear) {
    parts.push(`+${r.coins_earned} coins`);
    if (r.streak_bonus) parts.push(`+${r.streak_bonus} streak bonus`);
  }
  return parts.join(" · ");
}
