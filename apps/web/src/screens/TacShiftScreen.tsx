import { useCallback, useEffect, useRef, useState } from "react";

import { ApiError, api } from "../api/client";
import type { TsAssist, TsMode, TsOutcome, TsProgress, TsState, TsTier } from "../api/types";
import { loadEngine } from "../engine/wasm";
import { haptic, sfx } from "../feel/audio";
import { Board3, BoardUltimate } from "../games/tacshift/Boards";
import { Challenge } from "../games/tacshift/Challenge";
import { applyLocal, vanishing } from "../games/tacshift/rules";
import { useSession } from "../state/session";
import { CoinChip } from "../ui/CoinChip";
import { RestartIcon, UndoIcon } from "../ui/icons";
import { Button, Modal, TopBar } from "../ui/kit";
import { ConfirmSpend, type SpendRequest } from "./ConfirmSpend";
import { useToast } from "./useToast";

type Tab = TsMode | "local";

const TABS: { id: Tab; label: string }[] = [
  { id: "infinity", label: "Infinity" },
  { id: "classic", label: "Classic" },
  { id: "ultimate", label: "Ultimate" },
  { id: "local", label: "2 Players" },
];

const RULES: Record<TsMode, string> = {
  infinity: "You keep only 3 marks. A 4th makes your oldest fade away, so there are no draws.",
  classic: "Three in a row wins. Hard plays perfectly: hold it to a draw to earn its coins.",
  ultimate: "Nine boards. Where you play sends your opponent to that board. Win three boards in a row.",
};

const TIERS: { id: TsTier; label: string }[] = [
  { id: "easy", label: "Easy" },
  { id: "medium", label: "Medium" },
  { id: "hard", label: "Hard" },
];

/** The AI "thinks" at least this long, so its reply never lands mid-tap. */
const AI_DELAY_MS = 320;
/** The winning line glows before the result card. */
const RESULT_DELAY_MS = 900;
const RADAR_MS = 2000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Match {
  id: string;
  seq: number;
  state: TsState;
  mode: TsMode;
  tier: TsTier;
  prices: Record<TsAssist, number>;
  reward: number;
  spent: number;
}

export function TacShiftScreen({ onBack }: { onBack: () => void }) {
  const { refresh } = useSession();
  const [ready, setReady] = useState(false);
  const [tab, setTab] = useState<Tab>("infinity");
  const [tier, setTier] = useState<TsTier>("easy");
  const [progress, setProgress] = useState<TsProgress | null>(null);
  const [match, setMatch] = useState<Match | null>(null);
  const [thinking, setThinking] = useState(false);
  const [starting, setStarting] = useState(false);
  const [radar, setRadar] = useState<number | null>(null);
  const [outcome, setOutcome] = useState<TsOutcome | null>(null);
  const [coins, setCoins] = useState<number | undefined>(undefined);
  const [spend, setSpend] = useState<(SpendRequest & { kind: TsAssist }) | null>(null);
  const [buying, setBuying] = useState(false);
  const [toast, showToast] = useToast();
  const radarTimer = useRef<number | undefined>(undefined);

  const loadProgress = useCallback(() => {
    api.ts.progress().then(setProgress, () => undefined);
  }, []);

  useEffect(() => {
    void loadEngine().then(() => setReady(true));
    loadProgress();
    return () => window.clearTimeout(radarTimer.current);
  }, [loadProgress]);

  const tierInfo = (mode: TsMode, t: TsTier) => progress?.tiers.find((x) => x.mode === mode && x.tier === t);

  const switchTab = (t: Tab) => {
    if (thinking) return;
    setTab(t);
    setMatch(null);
    setOutcome(null);
    setRadar(null);
    if (t !== "local") {
      // Start on the easiest tier still paying, so the next goal is obvious.
      const next = TIERS.find((x) => !tierInfo(t, x.id)?.earned);
      setTier(next?.id ?? "hard");
    }
  };

  const startMatch = async () => {
    if (tab === "local") return;
    setStarting(true);
    try {
      const m = await api.ts.start(tab, tier);
      setMatch({ id: m.match_id, seq: m.seq, state: m.state, mode: tab, tier, prices: m.prices, reward: m.reward, spent: 0 });
      setCoins(m.coins);
      setOutcome(null);
      setRadar(null);
    } catch (e) {
      showToast(e instanceof ApiError ? e.message : "Could not start a match.");
    } finally {
      setStarting(false);
    }
  };

  const finish = async (o: TsOutcome) => {
    await sleep(RESULT_DELAY_MS);
    if (o.result === "won") {
      sfx.win();
      haptic(30);
    } else if (o.result === "lost") {
      sfx.lose();
      haptic(20);
    }
    setOutcome(o);
    setCoins(o.coins);
    loadProgress();
    void refresh();
  };

  const playAi = async (cell: number) => {
    const m = match;
    if (!m || thinking || m.state.status !== "playing" || m.state.turn !== 1) return;
    sfx.unlock();
    const mine = applyLocal(m.state, cell);
    if (!mine) {
      sfx.invalid();
      return;
    }
    // Show the player's mark at once; the server's answer brings the AI's.
    sfx.mark(true);
    haptic(8);
    if (mine.vanished >= 0) sfx.vanish();
    setMatch({ ...m, state: mine.state });
    setRadar(null);
    setThinking(true);
    const asked = performance.now();
    try {
      const res = await api.ts.move(m.id, m.seq, cell);
      await sleep(Math.max(0, AI_DELAY_MS - (performance.now() - asked)));
      if (res.ai) {
        sfx.mark(false);
        if (res.ai.vanished !== null) sfx.vanish();
      }
      setMatch((cur) => (cur && cur.id === m.id ? { ...cur, seq: res.seq, state: res.state } : cur));
      if (res.outcome) await finish(res.outcome);
    } catch (e) {
      const sync = e instanceof ApiError && e.code === "out_of_sync" ? (e.details as { seq?: number; state?: TsState }) : null;
      setMatch((cur) =>
        cur && cur.id === m.id
          ? sync?.state && sync.seq !== undefined
            ? { ...cur, seq: sync.seq, state: sync.state }
            : { ...cur, state: m.state }
          : cur,
      );
      showToast(e instanceof ApiError ? e.message : "That move didn't go through. Try again.");
    } finally {
      setThinking(false);
    }
  };

  const ask = (kind: TsAssist) => {
    if (!match) return;
    setSpend({
      kind,
      title: kind === "undo" ? "Undo turn" : "Tactical radar",
      what:
        kind === "undo"
          ? "Takes back your last move and the AI's reply. Works after a loss too."
          : "Shows the strongest move the AI knows for you, for 2 seconds.",
      price: match.prices[kind],
      balance: coins ?? 0,
      reward: match.reward > 0 ? match.reward : null,
      spent: match.spent,
      note: "Coins spent come off this tier's first-win reward.",
    });
  };

  const confirmSpend = async () => {
    const m = match;
    if (!m || !spend) return;
    setBuying(true);
    try {
      const res = await api.ts.assist(m.id, m.seq, spend.kind, spend.price);
      setCoins(res.coins);
      setMatch({ ...m, seq: res.seq, state: res.state, spent: res.spent });
      if (spend.kind === "undo") {
        setOutcome(null);
        sfx.tap();
      } else if (res.cell !== null) {
        setRadar(res.cell);
        window.clearTimeout(radarTimer.current);
        radarTimer.current = window.setTimeout(() => setRadar(null), RADAR_MS);
      }
      void refresh();
    } catch (e) {
      showToast(e instanceof ApiError ? e.message : "Could not buy that right now.");
    } finally {
      setBuying(false);
      setSpend(null);
    }
  };

  const status = (s: TsState) => {
    if (s.status !== "playing") return " ";
    const turn = s.turn === 1 ? "Your move" : "AI is thinking…";
    if (s.mode !== "ultimate") return turn;
    return s.active === null ? `${turn} · any open board` : `${turn} · board ${s.active + 1}`;
  };

  const board = (s: TsState, onCell: (c: number) => void, locked: boolean) =>
    s.mode === "ultimate" ? (
      <BoardUltimate state={s} onCell={onCell} locked={locked} radar={radar} />
    ) : (
      <Board3 state={s} onCell={onCell} locked={locked} vanishing={vanishing(s)} radar={radar} />
    );

  const outcomeText = (o: TsOutcome) => {
    if (o.first_win) {
      const bonus = o.streak_bonus ? ` · +${o.streak_bonus} streak bonus` : "";
      return `First ${o.result === "draw" ? "draw against Unbeatable" : "win at this tier"}: +${o.coins_earned} coins${bonus}`;
    }
    if (o.result === "won") return "Already earned this tier's coins. Try a harder one!";
    if (o.result === "draw") return "Nobody got three in a row.";
    return match?.mode === "infinity" ? "Watch which of your marks fades next." : "Undo your last move, or try again.";
  };

  const playingState = match?.state;

  return (
    <div className="relative flex h-full flex-col">
      <TopBar title="TacShift" onBack={onBack} right={<CoinChip balance={coins} />} />

      <div role="tablist" aria-label="Mode" className="mx-4 grid grid-cols-4 gap-1 rounded-2xl bg-panel p-1">
        {TABS.map((t) => (
          <button
            type="button"
            role="tab"
            key={t.id}
            aria-selected={tab === t.id}
            onClick={() => switchTab(t.id)}
            className={`rounded-xl px-1 py-2 text-xs font-bold transition sm:text-sm ${tab === t.id ? "bg-accent text-ink" : "text-muted hover:text-white"}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="mx-auto flex min-h-0 w-full max-w-md flex-1 flex-col px-4 pt-3">
        {tab === "local" && <Challenge ready={ready} />}
        {tab !== "local" && !playingState && (
          <div className="grid gap-3 overflow-y-auto pb-4">
            <p className="text-sm text-muted">{RULES[tab]}</p>
            <div className="grid gap-2">
              {TIERS.map((t) => {
                const info = tierInfo(tab, t.id);
                const unbeatable = tab === "classic" && t.id === "hard";
                return (
                  <button
                    type="button"
                    key={t.id}
                    aria-pressed={tier === t.id}
                    onClick={() => setTier(t.id)}
                    className={`flex items-center justify-between rounded-2xl border px-4 py-3 text-left transition active:scale-[0.98] ${
                      tier === t.id ? "border-accent bg-accent/10" : "border-line bg-panel-2"
                    }`}
                  >
                    <span>
                      <span className="block font-extrabold">{unbeatable ? "Unbeatable" : t.label}</span>
                      <span className="text-xs text-muted">{unbeatable ? "Draw to earn" : "Win to earn"}</span>
                    </span>
                    <span className={`text-sm font-bold ${info?.earned ? "text-emerald-300" : "text-gold"}`}>
                      {info ? (info.earned ? "✓ Earned" : `+${info.coins} coins`) : "…"}
                    </span>
                  </button>
                );
              })}
            </div>
            <Button onClick={() => void startMatch()} disabled={!ready || starting}>
              {starting ? "…" : "Play as X"}
            </Button>
          </div>
        )}

        {tab !== "local" && playingState && match && (
          <>
            <div className="mb-2 flex items-center justify-between text-sm">
              <span className={`font-semibold ${thinking ? "animate-pulse text-rose-300" : "text-white"}`}>{status(playingState)}</span>
              <span className="text-muted">
                {`${match.tier === "hard" && match.mode === "classic" ? "Unbeatable" : TIERS.find((t) => t.id === match.tier)?.label} · ${match.reward ? `+${match.reward}` : "earned"}`}
              </span>
            </div>
            <div className="mx-auto w-full" style={{ maxWidth: "min(100%, calc(100dvh - 300px))" }}>
              {board(playingState, (c) => void playAi(c), thinking || playingState.status !== "playing")}
            </div>
            <div className="mt-3 grid grid-cols-3 gap-2 pb-[max(env(safe-area-inset-bottom),12px)]">
              <button
                type="button"
                onClick={() => ask("undo")}
                disabled={thinking || match.state.plies === 0 || (outcome !== null && outcome.result !== "lost")}
                className="flex min-h-14 flex-col items-center justify-center rounded-2xl border border-line bg-panel-2 text-xs font-semibold disabled:opacity-40"
              >
                <UndoIcon size={20} />
                <span>Undo · <span className="text-gold">{match.prices.undo}</span></span>
              </button>
              <button
                type="button"
                onClick={() => ask("radar")}
                disabled={thinking || match.state.status !== "playing"}
                className="flex min-h-14 flex-col items-center justify-center rounded-2xl border border-line bg-panel-2 text-xs font-semibold disabled:opacity-40"
              >
                <span aria-hidden="true" className="text-lg leading-none">◎</span>
                <span>Radar · <span className="text-gold">{match.prices.radar}</span></span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setMatch(null);
                  setOutcome(null);
                }}
                disabled={thinking}
                className="flex min-h-14 flex-col items-center justify-center rounded-2xl border border-line bg-panel-2 text-xs font-semibold disabled:opacity-40"
              >
                <RestartIcon size={20} />
                <span>New game</span>
              </button>
            </div>
          </>
        )}
      </div>

      {toast && <p className="absolute inset-x-5 bottom-24 z-30 rounded-xl bg-panel-2 p-3 text-center text-sm">{toast}</p>}
      <ConfirmSpend request={spend} busy={buying} onConfirm={() => void confirmSpend()} onCancel={() => setSpend(null)} />

      <Modal open={outcome !== null} onClose={() => setOutcome(null)} title={outcome?.result === "won" ? "You win!" : outcome?.result === "lost" ? "The AI wins" : "Draw"}>
        {outcome && (
          <div className="grid gap-3">
            <p className="text-muted">{outcomeText(outcome)}</p>
            <Button onClick={() => void startMatch()}>Rematch</Button>
            {outcome.result === "lost" && match && (
              <Button variant="secondary" onClick={() => { setOutcome(null); ask("undo"); }}>
                Undo last move · {match.prices.undo}
              </Button>
            )}
            <Button variant="ghost" onClick={() => { setOutcome(null); setMatch(null); }}>
              Change tier
            </Button>
          </div>
        )}
      </Modal>
    </div>
  );
}
