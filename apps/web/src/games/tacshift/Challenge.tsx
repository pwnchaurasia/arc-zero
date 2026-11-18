import { useEffect, useState } from "react";

import type { TsMode, TsState } from "../../api/types";
import { haptic, sfx } from "../../feel/audio";
import { RestartIcon, UndoIcon } from "../../ui/icons";
import { Button, Modal } from "../../ui/kit";
import { Board3, BoardUltimate } from "./Boards";
import { applyLocal, emptyState, PLAIN_RULES, vanishing } from "./rules";

/**
 * Two people, one phone, a best-of-N match. Nothing goes to the server: it's offline
 * play with no coins. The match in progress is kept on this device only, so a reload
 * doesn't lose it.
 *
 * X always moves first, so the players swap marks every game: whoever was O starts the
 * next one. Draws don't count; play goes on until someone has won a majority.
 */

const KEY = "arc.ts.challenge";
const LENGTHS = [1, 3, 5, 7] as const;
const NAME_MAX = 12;
/** The winning line glows before the card. */
const CARD_DELAY_MS = 900;

interface Match {
  names: [string, string];
  mode: TsMode;
  bestOf: number;
  scores: [number, number];
  draws: number;
  /** Games played so far, draws included: decides who is X. */
  game: number;
  /** Who was X in the first game (0 or 1); rematches swap it. */
  firstX: 0 | 1;
  state: TsState;
  history: TsState[];
}

const toWin = (bestOf: number) => Math.floor(bestOf / 2) + 1;
/** The player (0 or 1) holding X in game `game`. */
const xPlayer = (m: Pick<Match, "game" | "firstX">) => ((m.game + m.firstX) % 2) as 0 | 1;
const playerOf = (m: Match, mark: number) => (mark === 1 ? xPlayer(m) : 1 - xPlayer(m)) as 0 | 1;

function load(): Match | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Match) : null;
  } catch {
    return null;
  }
}

function save(m: Match | null): void {
  try {
    if (m) localStorage.setItem(KEY, JSON.stringify(m));
    else localStorage.removeItem(KEY);
  } catch {
    // storage blocked: the match just won't survive a reload
  }
}

export function Challenge({ ready }: { ready: boolean }) {
  const [names, setNames] = useState<[string, string]>(["", ""]);
  const [mode, setMode] = useState<TsMode>("infinity");
  const [bestOf, setBestOf] = useState<number>(3);
  const [match, setMatch] = useState<Match | null>(() => load());
  // Reopened after a game ended (e.g. a reload): show its card again.
  const [card, setCard] = useState<"game" | "match" | null>(() => {
    const m = load();
    if (!m || m.state.status === "playing") return null;
    return m.scores.some((n) => n >= toWin(m.bestOf)) ? "match" : "game";
  });
  const [quitting, setQuitting] = useState(false);

  useEffect(() => save(match), [match]);

  const label = (i: 0 | 1) => match?.names[i] ?? names[i] ?? "";
  const winner = match ? ([0, 1] as const).find((i) => match.scores[i] >= toWin(match.bestOf)) : undefined;

  const start = (m: Pick<Match, "names" | "mode" | "bestOf" | "firstX">) => {
    sfx.unlock();
    setMatch({ ...m, scores: [0, 0], draws: 0, game: 0, state: emptyState(m.mode), history: [] });
    setCard(null);
  };

  const play = (cell: number) => {
    if (!match || match.state.status !== "playing" || card) return;
    sfx.unlock();
    const next = applyLocal(match.state, cell);
    if (!next) {
      sfx.invalid();
      return;
    }
    sfx.mark(match.state.turn === 1);
    haptic(8);
    if (next.vanished >= 0) sfx.vanish();
    const s = next.state;
    if (s.status === "playing") {
      setMatch({ ...match, state: s, history: [...match.history, match.state] });
      return;
    }
    const scores: [number, number] = [...match.scores];
    let draws = match.draws;
    if (s.status === "draw") draws += 1;
    else scores[playerOf(match, s.status === "x_won" ? 1 : 2)] += 1;
    const ended = { ...match, state: s, history: [], scores, draws };
    setMatch(ended);
    const over = scores.some((n) => n >= toWin(match.bestOf));
    window.setTimeout(() => {
      if (s.status !== "draw") sfx.win();
      haptic(over ? 40 : 20);
      setCard(over ? "match" : "game");
    }, CARD_DELAY_MS);
  };

  const nextGame = () => {
    if (!match) return;
    setMatch({ ...match, game: match.game + 1, state: emptyState(match.mode), history: [] });
    setCard(null);
  };

  const undo = () => {
    const previous = match?.history.at(-1);
    if (!match || !previous || match.state.status !== "playing") return;
    setMatch({ ...match, state: previous, history: match.history.slice(0, -1) });
    sfx.tap();
  };

  const quit = () => {
    setQuitting(false);
    setCard(null);
    setMatch(null);
  };

  if (!match) {
    const filled = (i: 0 | 1) => names[i].trim() || `Player ${i + 1}`;
    return (
      <div className="grid gap-3 overflow-y-auto pb-4">
        <p className="text-sm text-muted">Challenge a friend on this phone. Pass it after every move.</p>
        <div className="grid grid-cols-2 gap-2">
          {([0, 1] as const).map((i) => (
            <label key={i} className="grid min-w-0 gap-1 text-xs font-semibold text-muted">
              Player {i + 1}
              <input
                value={names[i]}
                maxLength={NAME_MAX}
                placeholder={`Player ${i + 1}`}
                onChange={(e) => setNames((n) => (i === 0 ? [e.target.value, n[1]] : [n[0], e.target.value]))}
                className="min-h-11 w-full min-w-0 rounded-xl border border-line bg-panel-2 px-3 text-base text-white placeholder:text-muted"
              />
            </label>
          ))}
        </div>
        <div>
          <p className="mb-1 text-xs font-semibold text-muted">Rules</p>
          <div className="grid grid-cols-3 gap-1 rounded-2xl bg-panel p-1">
            {(["infinity", "classic", "ultimate"] as const).map((m) => (
              <button
                type="button"
                key={m}
                aria-pressed={mode === m}
                onClick={() => setMode(m)}
                className={`rounded-xl py-2 text-xs font-bold capitalize ${mode === m ? "bg-panel-2 text-white ring-1 ring-accent" : "text-muted"}`}
              >
                {m}
              </button>
            ))}
          </div>
          <p className="mt-1 text-xs text-muted">{PLAIN_RULES[mode]}</p>
        </div>
        <div>
          <p className="mb-1 text-xs font-semibold text-muted">Match</p>
          <div className="grid grid-cols-4 gap-1 rounded-2xl bg-panel p-1">
            {LENGTHS.map((n) => (
              <button
                type="button"
                key={n}
                aria-pressed={bestOf === n}
                onClick={() => setBestOf(n)}
                className={`rounded-xl py-2 text-xs font-bold ${bestOf === n ? "bg-panel-2 text-white ring-1 ring-accent" : "text-muted"}`}
              >
                {n === 1 ? "1 game" : `Best of ${n}`}
              </button>
            ))}
          </div>
          <p className="mt-1 text-xs text-muted">
            {bestOf === 1 ? "One game decides it." : `First to ${toWin(bestOf)} wins. Draws don't count.`} Players swap X and O
            every game, so both get to start.
          </p>
        </div>
        <Button
          onClick={() => start({ names: [filled(0), filled(1)], mode, bestOf, firstX: 0 })}
          disabled={!ready}
        >
          Start challenge
        </Button>
      </div>
    );
  }

  const s = match.state;
  const x = xPlayer(match);
  const turnPlayer = s.turn === 1 ? x : ((1 - x) as 0 | 1);
  const status =
    s.status === "playing"
      ? `${label(turnPlayer)} (${s.turn === 1 ? "X" : "O"}) to move${s.mode === "ultimate" ? (s.active === null ? " · any open board" : ` · board ${s.active + 1}`) : ""}`
      : " ";
  const gameWinner = s.status === "draw" || s.status === "playing" ? null : playerOf(match, s.status === "x_won" ? 1 : 2);

  return (
    <>
      <div className="mb-2 grid grid-cols-[1fr_auto_1fr] items-center gap-2 rounded-2xl bg-panel px-3 py-2" aria-label="Score">
        {([0, 1] as const).map((i) => (
          <div key={i} className={`min-w-0 ${i === 1 ? "order-3 text-right" : ""}`}>
            <p className={`truncate text-sm font-bold ${turnPlayer === i && s.status === "playing" ? "text-white" : "text-muted"}`}>
              {label(i)} <span className={i === x ? "text-cyan-400" : "text-rose-400"}>{i === x ? "X" : "O"}</span>
            </p>
            <p className="text-2xl font-black tabular-nums">{match.scores[i]}</p>
          </div>
        ))}
        <p className="order-2 text-center text-[11px] leading-tight text-muted">
          {match.bestOf === 1 ? "1 game" : `first to ${toWin(match.bestOf)}`}
          <br />
          game {match.game + 1}
          {match.draws ? ` · ${match.draws} draw${match.draws === 1 ? "" : "s"}` : ""}
        </p>
      </div>
      <p className="mb-2 text-sm font-semibold">{status}</p>
      <div className="mx-auto w-full" style={{ maxWidth: "min(100%, calc(100dvh - 330px))" }}>
        {s.mode === "ultimate" ? (
          <BoardUltimate state={s} onCell={play} locked={s.status !== "playing" || !!card} radar={null} />
        ) : (
          <Board3 state={s} onCell={play} locked={s.status !== "playing" || !!card} vanishing={vanishing(s)} radar={null} />
        )}
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 pb-[max(env(safe-area-inset-bottom),12px)]">
        <button
          type="button"
          onClick={undo}
          disabled={!match.history.length || s.status !== "playing"}
          className="flex min-h-14 flex-col items-center justify-center rounded-2xl border border-line bg-panel-2 text-xs font-semibold disabled:opacity-40"
        >
          <UndoIcon size={20} />
          <span>Undo · free</span>
        </button>
        <button
          type="button"
          onClick={() => setQuitting(true)}
          className="flex min-h-14 flex-col items-center justify-center rounded-2xl border border-line bg-panel-2 text-xs font-semibold"
        >
          <RestartIcon size={20} />
          <span>End challenge</span>
        </button>
      </div>

      <Modal
        open={card === "game"}
        onClose={() => undefined}
        dismissable={false}
        title={gameWinner === null ? "A draw" : `${label(gameWinner)} wins game ${match.game + 1}!`}
      >
        <div className="grid gap-3">
          <p className="text-center text-3xl font-black tabular-nums">
            {match.scores[0]} – {match.scores[1]}
          </p>
          <p className="text-center text-sm text-muted">
            {gameWinner === null && "Draws don't count. "}
            Next: {label(xPlayer({ game: match.game + 1, firstX: match.firstX }))} plays X and goes first.
          </p>
          <Button onClick={nextGame}>Next game</Button>
        </div>
      </Modal>

      <Modal open={card === "match"} onClose={() => undefined} dismissable={false} title="🏆 Challenge over">
        {winner !== undefined && (
          <div className="grid gap-3 text-center">
            <p className="text-2xl font-black">{label(winner)} wins!</p>
            <p className="text-3xl font-black tabular-nums">
              {match.scores[winner]} – {match.scores[winner === 0 ? 1 : 0]}
            </p>
            <Button
              onClick={() =>
                start({
                  names: match.names,
                  mode: match.mode,
                  bestOf: match.bestOf,
                  // Whoever started the last match goes second now.
                  firstX: (1 - match.firstX) as 0 | 1,
                })
              }
            >
              Rematch
            </Button>
            <Button variant="ghost" onClick={quit}>
              New challenge
            </Button>
          </div>
        )}
      </Modal>

      <Modal open={quitting} onClose={() => setQuitting(false)} title="End this challenge?">
        <div className="grid gap-3">
          <p className="text-muted">
            The score so far ({label(0)} {match.scores[0]} – {match.scores[1]} {label(1)}) won't be kept.
          </p>
          <div className="grid grid-cols-2 gap-3">
            <Button variant="secondary" onClick={() => setQuitting(false)}>
              Keep playing
            </Button>
            <Button onClick={quit}>End it</Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
