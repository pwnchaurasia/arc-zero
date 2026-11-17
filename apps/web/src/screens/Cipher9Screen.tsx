import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { ApiError, api } from "../api/client";
import type { C9Complete, C9Hint, C9Move, C9Start } from "../api/types";
import { haptic, sfx } from "../feel/audio";
import {
  bit,
  boxOf,
  candidates,
  CELLS,
  clashes,
  clock,
  colOf,
  counts,
  DIGITS,
  explain,
  hasDigit,
  looksSolved,
  PEERS,
  rowOf,
  techniqueLabel,
  tierName,
  unitCells,
} from "../games/cipher9/sudoku";
import { useSession } from "../state/session";
import { CoinChip } from "../ui/CoinChip";
import {
  BulbIcon,
  ClearWrongIcon,
  EraserIcon,
  EyeIcon,
  EyeOffIcon,
  NotesIcon,
  PencilIcon,
  RestartIcon,
  UndoIcon,
} from "../ui/icons";
import { Button, IconButton, Modal, TopBar } from "../ui/kit";
import { ConfirmSpend, type SpendRequest } from "./ConfirmSpend";
import { ResultCard } from "./ResultCard";
import { useToast } from "./useToast";

/** A run in progress, kept on this device so closing the app doesn't lose the board. */
interface Saved {
  start: C9Start;
  moves: C9Move[];
  values: number[];
  notes: number[];
  elapsed: number;
  autoNotes: boolean;
  spent: number;
  savedAt: number;
}

interface Board {
  values: number[];
  /** Pencil notes per cell, bits 1..9. */
  notes: number[];
}

type SpendKind = "hint" | "auto_notes" | "clear_wrong";

const saveKey = (level: number) => `arc.c9.run.${level}`;
const TIMER_KEY = "arc.c9.showTimer";
const BEST_KEY = "arc.c9.best";
/** Attempts live 24 hours on the server; don't resume one close to expiring. */
const SAVE_MAX_AGE_MS = 20 * 3600 * 1000;
const UNDO_LIMIT = 300;
/** The board finishes its wave before the result card. */
const RESULT_DELAY_MS = 1300;

function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage full or blocked: the run just won't survive a reload
  }
}

function forget(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // ignore
  }
}

/** Follows an element's size, for a board that fills the space left. */
function useSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      if (e) setSize({ w: e.contentRect.width, h: e.contentRect.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size] as const;
}

export function Cipher9Screen({
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
  const [round, setRound] = useState(0);
  const [info, setInfo] = useState<C9Start | null>(null);
  const [board, setBoard] = useState<Board>({ values: Array(CELLS).fill(0), notes: Array(CELLS).fill(0) });
  const [selected, setSelected] = useState<number | null>(null);
  const [notesMode, setNotesMode] = useState(false);
  const [autoNotes, setAutoNotes] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [started, setStarted] = useState(false);
  const [showTimer, setShowTimer] = useState(() => readJson<boolean>(TIMER_KEY) ?? true);
  const [hint, setHint] = useState<(C9Hint & { text: string }) | null>(null);
  const [flash, setFlash] = useState<{ cells: number[]; n: number } | null>(null);
  const [wave, setWave] = useState(false);
  const [coins, setCoins] = useState<number | undefined>(undefined);
  const [spend, setSpend] = useState<(SpendRequest & { kind: SpendKind }) | null>(null);
  const [buying, setBuying] = useState(false);
  const [confirmRestart, setConfirmRestart] = useState(false);
  const [result, setResult] = useState<(C9Complete & { time: number; best: number }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, showToast] = useToast();
  const [wrap, size] = useSize<HTMLDivElement>();

  const moves = useRef<C9Move[]>([]);
  const history = useRef<Board[]>([]);
  const spent = useRef(0);
  const done = useRef(false);
  const elapsedRef = useRef(0);
  const ownsAutoNotes = useRef(false);

  const givens = info?.data.puzzle;
  const replay = me ? me.games.cipher9?.stars[String(level)] !== undefined : false;
  const count = me?.games.cipher9?.level_count ?? 0;

  const save = useCallback(
    (b: Board) => {
      if (!info || done.current) return;
      const saved: Saved = {
        start: info,
        moves: moves.current,
        values: b.values,
        notes: b.notes,
        elapsed: elapsedRef.current,
        autoNotes: ownsAutoNotes.current,
        spent: spent.current,
        savedAt: Date.now(),
      };
      writeJson(saveKey(level), saved);
    },
    [info, level],
  );

  // Load: resume this device's run of the level, or start a new attempt.
  useEffect(() => {
    let cancelled = false;
    done.current = false;
    history.current = [];
    setResult(null);
    setHint(null);
    setWave(false);
    setError(null);
    setSelected(null);
    const saved = round === 0 ? readJson<Saved>(saveKey(level)) : null;
    const fresh = saved && Date.now() - saved.savedAt < SAVE_MAX_AGE_MS && saved.start.level === level;
    if (fresh) {
      moves.current = saved.moves;
      spent.current = saved.spent;
      elapsedRef.current = saved.elapsed;
      setElapsed(saved.elapsed);
      setStarted(saved.moves.length > 0 || saved.notes.some(Boolean));
      ownsAutoNotes.current = saved.autoNotes;
      setAutoNotes(saved.autoNotes);
      setBoard({ values: saved.values, notes: saved.notes });
      setInfo(saved.start);
      // The balance saved with the run may be old: show the session's.
      setCoins(undefined);
      return;
    }
    forget(saveKey(level));
    (async () => {
      const start = await api.c9.start(level);
      if (cancelled) return;
      moves.current = [];
      spent.current = 0;
      elapsedRef.current = 0;
      setElapsed(0);
      setStarted(false);
      ownsAutoNotes.current = false;
      setAutoNotes(false);
      setBoard({ values: [...start.data.puzzle], notes: Array(CELLS).fill(0) });
      setInfo(start);
      setCoins(start.coins);
    })().catch((e: unknown) => {
      if (!cancelled) setError(e instanceof ApiError ? e.message : "Could not load this level.");
    });
    return () => {
      cancelled = true;
    };
  }, [level, round]);

  // The clock runs from the first input, only while the app is on screen.
  useEffect(() => {
    if (!started || result || !info) return;
    const id = window.setInterval(() => {
      if (document.hidden || done.current) return;
      elapsedRef.current += 1;
      setElapsed(elapsedRef.current);
    }, 1000);
    return () => window.clearInterval(id);
  }, [started, result, info]);

  // Keep the saved clock fresh when the app goes to the background.
  useEffect(() => {
    const onHide = () => {
      if (document.hidden) save(board);
    };
    document.addEventListener("visibilitychange", onHide);
    return () => document.removeEventListener("visibilitychange", onHide);
  }, [board, save]);

  const clashing = useMemo(() => clashes(board.values), [board.values]);
  const used = useMemo(() => counts(board.values), [board.values]);

  const submit = useCallback(
    async (b: Board) => {
      if (!info || done.current) return;
      done.current = true;
      try {
        const res = await api.c9.complete(level, info.attempt_id, moves.current);
        forget(saveKey(level));
        const time = elapsedRef.current;
        const bests = readJson<Record<string, number>>(BEST_KEY) ?? {};
        const best = Math.min(bests[String(level)] ?? Infinity, time);
        bests[String(level)] = best;
        writeJson(BEST_KEY, bests);
        sfx.win();
        haptic(30);
        setWave(true);
        setSelected(null);
        await new Promise((r) => setTimeout(r, RESULT_DELAY_MS));
        setResult({ ...res, time, best });
        setCoins(res.coins);
        void refresh();
        if (res.registration_required) onCheckpoint();
      } catch (e) {
        done.current = false;
        save(b);
        setError(e instanceof ApiError ? e.message : "Could not save this result.");
      }
    },
    [info, level, onCheckpoint, refresh, save],
  );

  /** Changes the board as one undoable step, logging every changed number as a move. */
  const change = useCallback(
    (edit: (b: Board) => void, undoable = true) => {
      if (!info || done.current) return null;
      const before = board;
      const next: Board = { values: [...before.values], notes: [...before.notes] };
      edit(next);
      for (let c = 0; c < CELLS; c++) {
        if (next.values[c] !== before.values[c]) moves.current.push([c, next.values[c] ?? 0]);
      }
      if (undoable) {
        history.current.push(before);
        if (history.current.length > UNDO_LIMIT) history.current.shift();
      }
      setBoard(next);
      setStarted(true);
      setError(null);
      save(next);
      if (looksSolved(next.values)) void submit(next);
      return next;
    },
    [board, info, save, submit],
  );

  const enter = useCallback(
    (cell: number, digit: number, asNote = notesMode) => {
      if (!givens || givens[cell] || done.current) return;
      sfx.unlock();
      if (asNote) {
        if (board.values[cell] && !clashing.has(cell)) {
          sfx.invalid();
          return;
        }
        change((b) => {
          b.values[cell] = 0;
          b.notes[cell] = (b.notes[cell] ?? 0) ^ bit(digit);
        });
        sfx.tap();
        return;
      }
      if (board.values[cell] === digit) {
        change((b) => {
          b.values[cell] = 0;
        });
        return;
      }
      const next = change((b) => {
        b.values[cell] = digit;
        b.notes[cell] = 0;
        for (const p of PEERS[cell] ?? []) b.notes[p] = (b.notes[p] ?? 0) & ~bit(digit);
      });
      if (!next) return;
      const twins = (PEERS[cell] ?? []).filter((p) => next.values[p] === digit);
      if (twins.length) {
        sfx.invalid();
        haptic(35);
        setFlash((f) => ({ cells: [cell, ...twins], n: (f?.n ?? 0) + 1 }));
        return;
      }
      // A row, column or box just filled up without repeats.
      const units = [unitCells("row", rowOf(cell)), unitCells("column", colOf(cell)), unitCells("box", boxOf(cell))];
      const repeats = clashes(next.values);
      const full = units.filter((u) => u.every((c) => next.values[c] && !repeats.has(c)));
      if (full.length) {
        sfx.complete();
        haptic(10);
        setFlash((f) => ({ cells: full.flat(), n: (f?.n ?? 0) + 1 }));
      } else {
        sfx.tap();
        haptic(6);
      }
    },
    [board.values, change, clashing, givens, notesMode],
  );

  const erase = useCallback(() => {
    if (selected === null || !givens || givens[selected]) return;
    if (!board.values[selected] && !board.notes[selected]) return;
    change((b) => {
      b.values[selected] = 0;
      b.notes[selected] = 0;
    });
    sfx.tap();
  }, [board, change, givens, selected]);

  const undo = useCallback(() => {
    const prev = history.current.pop();
    if (!prev) return;
    change((b) => {
      b.values = prev.values;
      b.notes = prev.notes;
    }, false);
    sfx.tap();
  }, [change]);

  const fillNotes = useCallback(() => {
    change((b) => {
      for (let c = 0; c < CELLS; c++) b.notes[c] = b.values[c] ? 0 : candidates(b.values, c);
    });
    sfx.complete();
  }, [change]);

  // Keyboard: digits, Backspace/Delete, arrows, N for notes, Ctrl+Z to undo.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (spend || result || confirmRestart) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        undo();
        return;
      }
      if (e.key === "n" || e.key === "N") {
        setNotesMode((m) => !m);
        return;
      }
      const move: Record<string, number> = { ArrowUp: -9, ArrowDown: 9, ArrowLeft: -1, ArrowRight: 1 };
      const step = move[e.key];
      if (step !== undefined) {
        e.preventDefault();
        setSelected((s) => {
          const from = s ?? 40;
          const to = from + step;
          if (to < 0 || to >= CELLS || (Math.abs(step) === 1 && rowOf(to) !== rowOf(from))) return from;
          return to;
        });
        return;
      }
      if (selected === null) return;
      if (/^[1-9]$/.test(e.key)) enter(selected, Number(e.key));
      else if (e.key === "Backspace" || e.key === "Delete" || e.key === "0") erase();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirmRestart, enter, erase, result, selected, spend, undo]);

  const ask = (kind: SpendKind) => {
    if (!info) return;
    const what: Record<SpendKind, [string, string]> = {
      hint: ["Hint", "Shows the next number you can work out, and how to find it."],
      auto_notes: ["Auto-notes", "Fills every empty cell's notes with the numbers that still fit. Free to refill for the rest of this attempt."],
      clear_wrong: ["Clear wrong numbers", "Empties every cell whose number isn't the solution's, even ones that don't clash yet. Not charged if all are right."],
    };
    const [title, text] = what[kind];
    setSpend({
      kind,
      title,
      what: text,
      price: info.prices[kind],
      balance: coins ?? 0,
      reward: replay ? null : info.reward,
      spent: spent.current,
    });
  };

  const onAutoNotes = () => {
    if (autoNotes) fillNotes();
    else ask("auto_notes");
  };

  const confirmSpend = async () => {
    if (!info || !spend) return;
    setBuying(true);
    try {
      if (spend.kind === "hint") {
        const res = await api.c9.hint(level, info.attempt_id, moves.current, spend.price);
        spent.current = res.spent;
        setCoins(res.coins);
        setHint({ ...res, text: explain(res) });
        setSelected(res.cell);
      } else {
        const res = await api.c9.buy(level, info.attempt_id, spend.kind, moves.current, spend.price);
        spent.current = res.spent;
        setCoins(res.coins);
        if (spend.kind === "auto_notes") {
          ownsAutoNotes.current = true;
          setAutoNotes(true);
          fillNotes();
        } else {
          change((b) => {
            for (const c of res.wrong) b.values[c] = 0;
          });
          showToast(`Cleared ${res.wrong.length} wrong number${res.wrong.length === 1 ? "" : "s"}.`);
        }
      }
      void refresh();
    } catch (e) {
      showToast(e instanceof ApiError ? e.message : "Could not buy that right now.");
    } finally {
      setBuying(false);
      setSpend(null);
    }
  };

  const restart = () => {
    setConfirmRestart(false);
    forget(saveKey(level));
    setRound((r) => r + 1);
  };

  const toggleTimer = () => {
    setShowTimer((v) => {
      writeJson(TIMER_KEY, !v);
      return !v;
    });
  };

  // What to highlight: the hint's unit (or the cell's lines), else the selection's peers.
  const focus = hint?.cell ?? selected;
  const lit = useMemo(() => {
    if (hint?.unit_kind && hint.unit !== null) return new Set(unitCells(hint.unit_kind, hint.unit));
    return new Set(focus === null ? [] : PEERS[focus]);
  }, [focus, hint]);
  const focusDigit = focus === null ? 0 : (board.values[focus] ?? 0);

  const side = Math.floor(Math.min(size.w, size.h) / 9) * 9;
  const cellPx = side / 9;

  const resultDetail = (r: NonNullable<typeof result>) => {
    const time = `Time ${clock(r.time)}${r.best < r.time ? ` · best ${clock(r.best)}` : r.best === r.time ? " · new best" : ""}`;
    const clean = r.mistakes === 0 ? "Flawless! " : `${r.mistakes} wrong number${r.mistakes === 1 ? "" : "s"} along the way. `;
    if (!r.first_clear) return `${time}. ${clean}Replay: no coins this time.`;
    const parts = [`+${r.coins_earned} coins`];
    if (r.streak_bonus) parts.push(`+${r.streak_bonus} streak bonus`);
    return `${time}. ${clean}${parts.join(" · ")}`;
  };

  const tool =
    "flex min-h-14 flex-col items-center justify-center gap-0.5 rounded-2xl border border-line bg-panel-2 px-1 py-1 text-[11px] font-semibold transition hover:bg-line active:scale-95 disabled:opacity-40";

  return (
    <div className="relative flex h-full flex-col">
      <TopBar
        title={`Level ${level}`}
        onBack={onBack}
        right={
          <div className="flex items-center gap-2">
            <CoinChip balance={coins} />
            <IconButton label="Start over" onClick={() => setConfirmRestart(true)} disabled={!info || !!result}>
              <RestartIcon />
            </IconButton>
          </div>
        }
      />
      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 px-4 text-sm text-muted">
        <span className="truncate" title={info ? techniqueLabel(info.data.technique) : undefined}>
          {info ? tierName(info.data.tier) : " "}
        </span>
        <button
          type="button"
          onClick={toggleTimer}
          aria-label={showTimer ? "Hide the clock" : "Show the clock"}
          className="flex items-center gap-1.5 rounded-xl px-2 py-1 tabular-nums transition hover:bg-panel-2"
        >
          {showTimer ? <EyeIcon size={16} /> : <EyeOffIcon size={16} />}
          <span className="min-w-12 text-left font-semibold text-white">{showTimer ? clock(elapsed) : "--:--"}</span>
        </button>
        <span className="truncate text-right">{info ? (replay ? "Replay" : `Reward ${info.reward}`) : " "}</span>
      </div>

      <div ref={wrap} className="relative mx-3 my-2 min-h-0 flex-1">
        {info && side > 0 && (
          <div
            role="group"
            aria-label="Sudoku board"
            className="absolute left-1/2 top-1/2 grid -translate-x-1/2 -translate-y-1/2 grid-cols-9 overflow-hidden rounded-xl border-2 border-slate-400/70 bg-panel"
            style={{ width: side + 4, height: side + 4 }}
          >
            {board.values.map((value, c) => {
              const given = !!givens?.[c];
              const r = rowOf(c);
              const col = colOf(c);
              const isSel = c === focus;
              const clash = clashing.has(c);
              const same = focusDigit > 0 && value === focusDigit && !isSel;
              const flashing = flash?.cells.includes(c);
              const bg = isSel
                ? "bg-accent/35"
                : clash
                  ? "bg-red-500/20"
                  : same
                    ? "bg-accent/20"
                    : lit.has(c)
                      ? "bg-panel-2"
                      : "bg-panel";
              const text = clash && !given ? "text-red-400" : given ? "text-white" : "text-sky-300";
              const notes = board.notes[c] ?? 0;
              return (
                <button
                  type="button"
                  key={c}
                  aria-pressed={isSel}
                  aria-label={`Row ${r + 1}, column ${col + 1}: ${value ? `${value}${given ? ", given" : ""}${clash ? ", repeats" : ""}` : "empty"}`}
                  onClick={() => {
                    sfx.unlock();
                    setSelected(c);
                    if (hint && c !== hint.cell) setHint(null);
                  }}
                  className={`relative grid place-items-center leading-none transition-colors ${bg} ${
                    col % 3 === 2 && col < 8 ? "border-r-2 border-r-slate-400/70" : col < 8 ? "border-r border-r-line" : ""
                  } ${r % 3 === 2 && r < 8 ? "border-b-2 border-b-slate-400/70" : r < 8 ? "border-b border-b-line" : ""} ${
                    isSel ? "z-10 ring-2 ring-inset ring-accent" : ""
                  } ${flashing ? ((flash?.n ?? 0) % 2 ? "c9-flash-a" : "c9-flash-b") : ""} ${wave ? "c9-wave" : ""}`}
                  style={{
                    fontSize: cellPx * 0.56,
                    animationDelay: wave ? `${(r + col) * 35}ms` : undefined,
                  }}
                >
                  {value ? (
                    <span className={`${text} ${given ? "font-black" : "font-semibold"}`}>{value}</span>
                  ) : notes ? (
                    <span className="grid size-full grid-cols-3 grid-rows-3 p-[6%]" aria-hidden="true">
                      {DIGITS.map((d) => (
                        <span
                          key={d}
                          className={`grid place-items-center leading-none ${
                            d === focusDigit && hasDigit(notes, d) ? "rounded-sm bg-accent/30 font-bold text-white" : "text-muted"
                          }`}
                          style={{ fontSize: cellPx * 0.24 }}
                        >
                          {hasDigit(notes, d) ? d : ""}
                        </span>
                      ))}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        )}
        {hint && !result && (
          <div
            className={`pop-in absolute inset-x-0 z-20 rounded-2xl border border-accent/40 bg-panel/95 p-3 shadow-2xl backdrop-blur ${
              rowOf(hint.cell) < 5 ? "bottom-0" : "top-0"
            }`}
          >
            <p className="text-sm">
              <span className="font-bold text-accent">
                {hint.technique ? `${techniqueLabel(hint.technique)}: ` : "Reveal: "}
              </span>
              {hint.text}
            </p>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <Button variant="secondary" onClick={() => setHint(null)}>
                Close
              </Button>
              <Button
                onClick={() => {
                  enter(hint.cell, hint.digit, false);
                  setHint(null);
                }}
              >
                Fill in {hint.digit}
              </Button>
            </div>
          </div>
        )}
      </div>

      <div className="grid grid-cols-6 gap-1.5 px-3">
        <button type="button" className={tool} onClick={undo} disabled={!info || !!result}>
          <UndoIcon size={20} />
          <span>Undo</span>
        </button>
        <button type="button" className={tool} onClick={erase} disabled={!info || !!result || selected === null}>
          <EraserIcon size={20} />
          <span>Erase</span>
        </button>
        <button
          type="button"
          aria-pressed={notesMode}
          className={`${tool} ${notesMode ? "border-accent bg-accent/20 text-accent" : ""}`}
          onClick={() => setNotesMode((m) => !m)}
          disabled={!info || !!result}
        >
          <PencilIcon size={20} />
          <span>Notes {notesMode ? "on" : "off"}</span>
        </button>
        <button type="button" className={tool} onClick={onAutoNotes} disabled={!info || !!result}>
          <NotesIcon size={20} />
          <span>Auto-notes</span>
          <span className="text-[10px] text-gold">{autoNotes ? "Owned" : info ? `${info.prices.auto_notes}` : "…"}</span>
        </button>
        <button type="button" className={tool} onClick={() => ask("clear_wrong")} disabled={!info || !!result}>
          <ClearWrongIcon size={20} />
          <span>Fix</span>
          <span className="text-[10px] text-gold">{info ? info.prices.clear_wrong : "…"}</span>
        </button>
        <button type="button" className={tool} onClick={() => ask("hint")} disabled={!info || !!result}>
          <BulbIcon size={20} />
          <span>Hint</span>
          <span className="text-[10px] text-gold">{info ? info.prices.hint : "…"}</span>
        </button>
      </div>

      <div className="grid grid-cols-9 gap-1 px-3 pb-[max(env(safe-area-inset-bottom),12px)] pt-2">
        {DIGITS.map((d) => {
          const left = Math.max(0, 9 - (used[d] ?? 0));
          return (
            <button
              type="button"
              key={d}
              aria-label={notesMode ? `Note ${d}` : `Enter ${d}`}
              disabled={!info || !!result || left === 0 || selected === null}
              onClick={() => selected !== null && enter(selected, d)}
              className={`relative flex min-h-14 flex-col items-center justify-center rounded-2xl border border-line bg-panel-2 font-black transition active:scale-95 disabled:opacity-25 ${
                notesMode ? "text-lg text-sky-300" : "text-2xl"
              } ${d === focusDigit ? "border-accent" : ""}`}
            >
              {d}
              <span className="text-[10px] font-semibold text-muted">{left}</span>
            </button>
          );
        })}
      </div>

      {error && (
        <div className="absolute inset-x-5 bottom-36 z-30 rounded-xl bg-red-500/20 p-3 text-center text-sm text-red-200">
          <p>{error}</p>
          {!info && (
            <Button variant="secondary" className="mt-2" onClick={() => setRound((r) => r + 1)}>
              Try again
            </Button>
          )}
        </div>
      )}
      {toast && <p className="absolute inset-x-5 bottom-36 z-30 rounded-xl bg-panel-2 p-3 text-center text-sm">{toast}</p>}

      <ConfirmSpend request={spend} busy={buying} onConfirm={() => void confirmSpend()} onCancel={() => setSpend(null)} />
      <Modal open={confirmRestart} onClose={() => setConfirmRestart(false)} title="Start over?">
        <div className="grid gap-4">
          <p className="text-muted">Clears your numbers and notes and starts this level again.</p>
          <div className="grid grid-cols-2 gap-3">
            <Button variant="secondary" onClick={() => setConfirmRestart(false)}>
              Cancel
            </Button>
            <Button onClick={restart}>Start over</Button>
          </div>
        </div>
      </Modal>
      {result && (
        <ResultCard
          won
          stars={result.stars}
          detail={resultDetail(result)}
          hasNext={level < count && result.unlocked_level > level}
          onNext={() => onLevel(level + 1)}
          onRetry={restart}
          onLevels={onBack}
        />
      )}
    </div>
  );
}
