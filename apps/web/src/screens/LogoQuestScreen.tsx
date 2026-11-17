import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { ApiError, api } from "../api/client";
import type { LqCheck, LqMapLevel, LqStart, LqTools } from "../api/types";
import { engine, loadEngine } from "../engine/wasm";
import { haptic, sfx } from "../feel/audio";
import {
  blockAt,
  blocks as countBlocks,
  COLORS,
  colorHex,
  idOf,
  insert,
  pathOf,
  remove,
  tokens,
  update,
  type Block,
  type Color,
  type Cursor,
} from "../games/logoquest/program";
import { fromEngine, HALF, TurtleBoard, type Arc, type Line, type Turtle } from "../games/logoquest/TurtleBoard";
import { useSession } from "../state/session";
import { CoinChip } from "../ui/CoinChip";
import { BulbIcon, LockIcon, UndoIcon } from "../ui/icons";
import { Button, Modal, Stars, TopBar } from "../ui/kit";
import { ConfirmSpend, type SpendRequest } from "./ConfirmSpend";
import { useToast } from "./useToast";

/** Learn N is stage 2N-1, Test N is stage 2N (the server's levels.lq_stage). */
export const learnStage = (level: number) => 2 * level - 1;
export const testStage = (level: number) => 2 * level;

const SANDBOX_TOOLS: LqTools = {
  chips: ["fd", "bk", "rt", "lt", "pu", "pd", "color", "repeat"],
  angles: [10, 30, 36, 45, 60, 72, 90, 120, 135, 144],
  any_angle: true,
  depth: 3,
};
const DISTANCES = [10, 20, 25, 30, 40, 50, 60, 75, 80, 100, 120, 150];
const COUNTS = [2, 3, 4, 5, 6, 8, 9, 10, 12, 18, 36];
/** Units per second and degrees per second the turtle moves at. */
const SPEEDS = {
  slow: { move: 55, turn: 90, label: "Slow" },
  normal: { move: 120, turn: 220, label: "Normal" },
  fast: { move: 500, turn: 1100, label: "Fast" },
} as const;
type Speed = keyof typeof SPEEDS;
const HINT_MS = 2500;

const CHIP_STYLE: Record<string, string> = {
  fd: "bg-emerald-500/20 border-emerald-400/60 text-emerald-200",
  bk: "bg-teal-500/20 border-teal-400/60 text-teal-200",
  rt: "bg-orange-500/20 border-orange-400/60 text-orange-200",
  lt: "bg-orange-500/20 border-orange-400/60 text-orange-200",
  repeat: "bg-yellow-500/20 border-yellow-400/60 text-yellow-100",
  pu: "bg-sky-500/20 border-sky-400/60 text-sky-200",
  pd: "bg-sky-500/20 border-sky-400/60 text-sky-200",
  color: "bg-violet-500/20 border-violet-400/60 text-violet-200",
};
const CHIP_LABEL: Record<string, [string, string]> = {
  fd: ["FD", "Forward"],
  bk: ["BK", "Back"],
  rt: ["RT", "Right"],
  lt: ["LT", "Left"],
  repeat: ["REPEAT", "Loop"],
  pu: ["PU", "Pen up"],
  pd: ["PD", "Pen down"],
  color: ["COLOR", "Colour"],
};

interface EngineStep {
  block: number;
  x: number;
  y: number;
  heading: number;
  pen: boolean;
  color: string;
  drew: number | null;
}

interface RunOut {
  segments: { x1: number; y1: number; x2: number; y2: number; color: string }[];
  steps: EngineStep[];
}

const START: Turtle = { x: 0, y: 0, heading: 0, visible: true };

function useSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => e && setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size] as const;
}

const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

// ----------------------------------------------------------------------------- map

/** The level map: five chapters, each level a Learn and a Test. */
export function LogoQuestHome({
  onBack,
  onPlay,
  onSandbox,
  onCheckpoint,
}: {
  onBack: () => void;
  onPlay: (stage: number) => void;
  onSandbox: () => void;
  onCheckpoint: () => void;
}) {
  const { me } = useSession();
  const [levels, setLevels] = useState<LqMapLevel[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const progress = me?.games.logoquest;
  const unlocked = progress?.unlocked_level ?? 1;
  const stars = (stage: number) => progress?.stars[String(stage)] ?? 0;
  const gated = (stage: number) => !me?.signed_in && me !== null && stage > (me?.guest_max_level ?? 3);
  const open = (stage: number) => !!me?.all_levels_open || (stage <= unlocked && !gated(stage));

  useEffect(() => {
    api.lq.levels().then(setLevels, (e: unknown) => setError(e instanceof ApiError ? e.message : "Could not load the levels."));
  }, []);

  // The chapter with the next thing to do starts open.
  const current = Math.ceil(unlocked / 2);
  const [chapter, setChapter] = useState<number | null>(null);
  const shownChapter = chapter ?? levels?.find((l) => l.level === current)?.chapter ?? 1;
  const chapters = useMemo(() => {
    const out = new Map<number, LqMapLevel[]>();
    for (const l of levels ?? []) out.set(l.chapter, [...(out.get(l.chapter) ?? []), l]);
    return [...out.entries()];
  }, [levels]);

  const stageButton = (stage: number, kind: "Learn" | "Test", title: string) => {
    const ok = open(stage);
    const s = stars(stage);
    return (
      <button
        type="button"
        onClick={() => (ok ? onPlay(stage) : gated(stage) && me?.registration_required ? onCheckpoint() : undefined)}
        aria-label={ok ? `${kind}: ${title}` : `${kind}: ${title}, locked`}
        className={`flex min-h-12 min-w-0 items-center justify-between gap-2 rounded-xl border px-3 py-2 text-left text-sm transition active:scale-[0.98] ${
          ok ? (kind === "Learn" ? "border-emerald-400/40 bg-emerald-500/10" : "border-amber-400/40 bg-amber-500/10") : "border-transparent bg-panel/60 text-line"
        } ${stage === unlocked && ok ? "ring-2 ring-accent" : ""}`}
      >
        <span className="min-w-0">
          <span className={`block text-[10px] font-bold uppercase tracking-wider ${ok ? "text-muted" : ""}`}>{kind}</span>
          <span className="block truncate font-semibold">{title}</span>
        </span>
        {ok ? s > 0 ? <Stars count={s} size={11} /> : null : <LockIcon size={16} />}
      </button>
    );
  };

  return (
    <div className="flex h-full flex-col">
      <TopBar title="LogoQuest" onBack={onBack} right={<CoinChip />} />
      <div className="mx-auto w-full max-w-xl flex-1 overflow-y-auto px-4 pb-8">
        <button
          type="button"
          onClick={onSandbox}
          className="mb-3 flex w-full items-center justify-between rounded-2xl border border-accent/40 bg-accent/10 px-4 py-3 text-left"
        >
          <span>
            <span className="block font-extrabold">Sandbox</span>
            <span className="text-xs text-muted">Draw anything you like with every chip</span>
          </span>
          <span aria-hidden="true" className="text-2xl">🐢</span>
        </button>
        {error && <p className="rounded-xl bg-red-500/15 p-3 text-sm text-red-200">{error}</p>}
        {chapters.map(([n, list]) => (
          <section key={n} className="mb-2">
            <button
              type="button"
              onClick={() => setChapter(shownChapter === n ? 0 : n)}
              aria-expanded={shownChapter === n}
              className="flex w-full items-center justify-between rounded-2xl bg-panel px-4 py-3 text-left"
            >
              <span className="font-extrabold">
                {n}. {list[0]?.chapter_name}
              </span>
              <span className="text-xs text-muted">
                {list.filter((l) => stars(testStage(l.level)) > 0).length}/{list.length} tests passed
              </span>
            </button>
            {shownChapter === n && (
              <ol className="mt-2 grid gap-2">
                {list.map((l) => (
                  <li key={l.level} className="grid grid-cols-[1.75rem_minmax(0,1fr)_minmax(0,1fr)] items-center gap-2">
                    <span className="text-right text-sm font-bold text-muted">{l.level}</span>
                    {stageButton(learnStage(l.level), "Learn", l.learn)}
                    {stageButton(testStage(l.level), "Test", l.test)}
                  </li>
                ))}
              </ol>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------- play

type Pad =
  | { kind: "fd" | "bk" | "rt" | "lt" | "repeat"; edit?: number }
  | { kind: "color"; edit?: number };

/** A lesson (stage > 0) or the Sandbox (stage 0). */
export function LogoQuestPlay({
  stage,
  onBack,
  onStage,
  onCheckpoint,
}: {
  stage: number;
  onBack: () => void;
  onStage: (stage: number) => void;
  onCheckpoint: () => void;
}) {
  const { refresh } = useSession();
  const sandbox = stage === 0;
  const [info, setInfo] = useState<LqStart | null>(null);
  const [ready, setReady] = useState(false);
  const [program, setProgram] = useState<Block[]>([]);
  const [cursor, setCursor] = useState<Cursor>([]);
  const [history, setHistory] = useState<Block[][]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [pad, setPad] = useState<Pad | null>(null);
  const [typed, setTyped] = useState("");
  const [speed, setSpeed] = useState<Speed>("normal");
  const [frame, setFrame] = useState<{ drawn: Line[]; turtle: Turtle; arc: Arc | null; block: number | null }>({
    drawn: [],
    turtle: START,
    arc: null,
    block: null,
  });
  const [running, setRunning] = useState(false);
  const [hint, setHint] = useState<Line | null>(null);
  const [showCard, setShowCard] = useState(true);
  const [result, setResult] = useState<LqCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [coins, setCoins] = useState<number | undefined>(undefined);
  const [spend, setSpend] = useState<SpendRequest | null>(null);
  const [buying, setBuying] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [toast, showToast] = useToast();
  const [wrap, size] = useSize<HTMLDivElement>();

  const stats = useRef({ runs: 0, taps: 0, active: 0, started: false });
  const anim = useRef<{
    raf: number;
    run: RunOut | null;
    i: number;
    t: number;
    last: number;
    stepOnce: boolean;
    /** A live preview of an edit: no "done" sound. */
    quiet: boolean;
  }>({
    raf: 0,
    run: null,
    i: 0,
    t: 0,
    last: 0,
    stepOnce: false,
    quiet: false,
  });
  /** The steps last shown on the board, so an edit only animates what it changed. */
  const shown = useRef<EngineStep[]>([]);

  const tools = info?.data.tools ?? SANDBOX_TOOLS;
  const isTest = info?.data.kind === "test";
  const target = useMemo(() => (info ? fromEngine(info.data.target) : []), [info]);

  useEffect(() => {
    let cancelled = false;
    const a = anim.current;
    stats.current = { runs: 0, taps: 0, active: 0, started: false };
    void loadEngine().then(() => !cancelled && setReady(true));
    if (!sandbox) {
      api.lq.start(stage).then(
        (s) => {
          if (cancelled) return;
          setInfo(s);
          setCoins(s.coins);
        },
        (e: unknown) => !cancelled && showToast(e instanceof ApiError ? e.message : "Could not open this level."),
      );
    }
    return () => {
      cancelled = true;
      cancelAnimationFrame(a.raf);
    };
    // showToast is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, sandbox]);

  // Time on screen (for the practice log), and the Test's clock from the first tap.
  useEffect(() => {
    const id = window.setInterval(() => {
      if (document.hidden || result) return;
      stats.current.active += 1;
      if (stats.current.started) setElapsed((e) => e + 1);
    }, 1000);
    return () => window.clearInterval(id);
  }, [result]);

  const opOf = useCallback(
    (id: number) => {
      const path = pathOf(program, id);
      return path ? blockAt(program, path) : undefined;
    },
    [program],
  );

  /** What the board shows at step `i`, `t` of the way through it. */
  const frameAt = useCallback(
    (run: RunOut, i: number, t: number) => {
      const line = (s: RunOut["segments"][number]): Line => ({
        x1: s.x1 / 1000,
        y1: s.y1 / 1000,
        x2: s.x2 / 1000,
        y2: s.y2 / 1000,
        color: colorHex(s.color),
      });
      const drawn: Line[] = [];
      for (let k = 0; k < Math.min(i, run.steps.length); k++) {
        const d = run.steps[k]?.drew;
        const seg = d === null || d === undefined ? undefined : run.segments[d];
        if (seg) drawn.push(line(seg));
      }
      const prev = i === 0 ? { x: 0, y: 0, heading: 0 } : run.steps[i - 1];
      const step = run.steps[i];
      if (!step || !prev) {
        const last = run.steps[run.steps.length - 1];
        return { drawn, turtle: last ? { x: last.x / 1000, y: last.y / 1000, heading: last.heading, visible: true } : START, arc: null, block: null };
      }
      const px = prev.x / 1000;
      const py = prev.y / 1000;
      const x = px + (step.x / 1000 - px) * t;
      const y = py + (step.y / 1000 - py) * t;
      const seg = step.drew === null ? undefined : run.segments[step.drew];
      if (seg) drawn.push({ ...line(seg), x2: x, y2: y });
      const b = opOf(step.block);
      let heading = step.heading;
      let arc: Arc | null = null;
      if (b && (b.op === "rt" || b.op === "lt")) {
        const delta = b.op === "rt" ? b.n : -b.n;
        heading = prev.heading + delta * t;
        arc = { x: px, y: py, from: prev.heading, to: heading };
      }
      return { drawn, turtle: { x, y, heading, visible: true }, arc, block: step.block };
    },
    [opOf],
  );

  const stepMs = useCallback(
    (run: RunOut, i: number) => {
      const step = run.steps[i];
      const prev = i === 0 ? { x: 0, y: 0 } : run.steps[i - 1];
      if (!step || !prev) return 0;
      const b = opOf(step.block);
      const sp = SPEEDS[speed];
      if (b && (b.op === "fd" || b.op === "bk")) return (b.n / sp.move) * 1000;
      if (b && (b.op === "rt" || b.op === "lt")) return (b.n / sp.turn) * 1000;
      return 120;
    },
    [opOf, speed],
  );

  const stopAnimation = () => {
    cancelAnimationFrame(anim.current.raf);
    anim.current.run = null;
    setRunning(false);
  };

  const resetBoard = () => {
    stopAnimation();
    setFrame({ drawn: [], turtle: START, arc: null, block: null });
  };

  const compile = (): RunOut | null => {
    try {
      return JSON.parse(engine.logoRun(JSON.stringify(program))) as RunOut;
    } catch (e) {
      showToast(e instanceof Error ? e.message : "That program can't run.");
      return null;
    }
  };

  const tick = (now: number) => {
    const a = anim.current;
    const run = a.run;
    if (!run) return;
    let dt = now - a.last;
    a.last = now;
    while (dt > 0 && a.i < run.steps.length) {
      const ms = Math.max(1, stepMs(run, a.i));
      const left = (1 - a.t) * ms;
      if (dt >= left) {
        dt -= left;
        a.i += 1;
        a.t = 0;
        if (a.stepOnce) break;
      } else {
        a.t += dt / ms;
        dt = 0;
      }
    }
    setFrame(frameAt(run, a.i, a.t));
    if (a.i >= run.steps.length || (a.stepOnce && a.t === 0)) {
      setRunning(false);
      if (a.i >= run.steps.length) {
        a.run = null;
        if (!a.quiet) sfx.complete();
      }
      return;
    }
    a.raf = requestAnimationFrame(tick);
  };

  const run = (once = false) => {
    sfx.unlock();
    if (!program.length) {
      showToast("Add some chips first: tap FD!");
      return;
    }
    const a = anim.current;
    if (once && a.run && a.i < a.run.steps.length) {
      // Step: carry on from where the last step stopped.
      a.stepOnce = true;
    } else {
      const compiled = compile();
      if (!compiled) return;
      stats.current.runs += 1;
      shown.current = compiled.steps;
      a.run = compiled;
      a.i = 0;
      a.t = 0;
      a.stepOnce = once;
    }
    a.quiet = false;
    cancelAnimationFrame(a.raf);
    a.last = performance.now();
    setRunning(true);
    setHint(null);
    a.raf = requestAnimationFrame(tick);
  };

  // Every edit shows straight away: the turtle draws only what changed, from the first
  // step that differs; everything before it stays on the board.
  useEffect(() => {
    if (!ready) return;
    let compiled: RunOut;
    try {
      compiled = JSON.parse(engine.logoRun(JSON.stringify(program))) as RunOut;
    } catch (e) {
      showToast(e instanceof Error ? e.message : "That program can't run.");
      return;
    }
    const before = shown.current;
    const same = (x: EngineStep | undefined, y: EngineStep | undefined) =>
      !!x && !!y && x.block === y.block && x.x === y.x && x.y === y.y && x.heading === y.heading && x.drew === y.drew && x.color === y.color;
    let from = 0;
    while (from < compiled.steps.length && same(before[from], compiled.steps[from])) from++;
    shown.current = compiled.steps;
    const a = anim.current;
    cancelAnimationFrame(a.raf);
    if (from >= compiled.steps.length) {
      // Only removed steps (or nothing new): show the result at once.
      a.run = null;
      setRunning(false);
      setFrame(frameAt(compiled, compiled.steps.length, 0));
      return;
    }
    stats.current.runs += 1;
    a.run = compiled;
    a.i = from;
    a.t = 0;
    a.stepOnce = false;
    a.quiet = true;
    a.last = performance.now();
    setRunning(true);
    setHint(null);
    a.raf = requestAnimationFrame(tick);
    // Runs once per edit; the helpers it uses read the same program.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [program, ready]);

  const skipToEnd = () => {
    const compiled = anim.current.run ?? compile();
    stopAnimation();
    if (compiled) setFrame(frameAt(compiled, compiled.steps.length, 0));
  };

  const commit = (next: Block[], nextCursor: Cursor = cursor) => {
    stopAnimation();
    setHistory((h) => [...h.slice(-99), program]);
    setProgram(next);
    setCursor(nextCursor);
    stats.current.taps += 1;
    stats.current.started = true;
    haptic(6);
  };

  const cursorDepth = cursor.length;
  const choose = (n: number) => {
    if (!pad || pad.kind === "color") return;
    sfx.tap();
    if (pad.edit !== undefined) {
      commit(update(program, pad.edit, { n }));
    } else if (pad.kind === "repeat") {
      const r = insert(program, cursor, { op: "repeat", n, body: [] });
      commit(r.program, r.cursor);
    } else {
      const r = insert(program, cursor, { op: pad.kind, n });
      commit(r.program, r.cursor);
    }
    setPad(null);
    setTyped("");
  };

  const chooseColor = (c: Color) => {
    if (!pad) return;
    sfx.tap();
    if (pad.edit !== undefined) commit(update(program, pad.edit, { c }));
    else {
      const r = insert(program, cursor, { op: "color", c });
      commit(r.program, r.cursor);
    }
    setPad(null);
  };

  const addSimple = (op: "pu" | "pd") => {
    sfx.tap();
    const r = insert(program, cursor, { op });
    commit(r.program, r.cursor);
  };

  const closeRepeat = () => {
    sfx.tap();
    setCursor((c) => c.slice(0, -1));
    stats.current.taps += 1;
  };

  const deleteBlock = () => {
    if (!program.length) return;
    sfx.tap();
    const id = selected ?? countBlocks(program) - 1;
    commit(remove(program, id), []);
    setSelected(null);
  };

  const undo = () => {
    const prev = history[history.length - 1];
    if (!prev) return;
    stopAnimation();
    setProgram(prev);
    setHistory((h) => h.slice(0, -1));
    setCursor([]);
    setSelected(null);
    stats.current.taps += 1;
  };

  const clearAll = () => {
    if (!program.length) return;
    commit([], []);
    setSelected(null);
  };

  const selectToken = (id: number) => {
    sfx.tap();
    const path = pathOf(program, id);
    const b = path ? blockAt(program, path) : undefined;
    if (!b) return;
    if (selected === id) {
      // Second tap: change its number or colour.
      if (b.op === "pu" || b.op === "pd") return;
      setPad({ kind: b.op === "color" ? "color" : b.op, edit: id });
      return;
    }
    setSelected(id);
  };

  const check = async () => {
    if (!info || checking) return;
    if (!program.length) {
      showToast("Build a program first!");
      return;
    }
    setChecking(true);
    try {
      const res = await api.lq.check(stage, info.attempt_id, program, {
        runs: stats.current.runs,
        taps: stats.current.taps,
        active_seconds: stats.current.active,
      });
      if (res.passed) {
        skipToEnd();
        sfx.win();
        haptic(30);
        setCoins(res.coins);
        void refresh();
        if (res.registration_required) onCheckpoint();
      } else {
        sfx.invalid();
      }
      setResult(res);
    } catch (e) {
      showToast(e instanceof ApiError ? e.message : "Could not check right now.");
    } finally {
      setChecking(false);
    }
  };

  const askHint = () => {
    if (!info) return;
    setSpend({
      title: "Hint",
      what: "Shows one line of the drawing you haven't made yet, and how long it is.",
      price: info.prices.hint,
      balance: coins ?? 0,
      reward: info.reward,
      spent: 0,
    });
  };

  const buyHint = async () => {
    if (!info || !spend) return;
    setBuying(true);
    try {
      const res = await api.lq.hint(stage, info.attempt_id, program, spend.price);
      setCoins(res.coins);
      const [x1, y1, x2, y2] = res.line;
      setHint({ x1: x1 / 1000, y1: y1 / 1000, x2: x2 / 1000, y2: y2 / 1000, color: "#facc15" });
      showToast(`Look at the yellow line: it is ${Math.round(res.length / 1000)} steps long.`);
      window.setTimeout(() => setHint(null), HINT_MS);
      void refresh();
    } catch (e) {
      showToast(e instanceof ApiError ? e.message : "Could not show a hint.");
    } finally {
      setBuying(false);
      setSpend(null);
    }
  };

  const toks = tokens(program);
  const openRepeat = cursor.length ? idOf(program, cursor) : null;
  const side = Math.max(0, Math.floor(Math.min(size.w, size.h)));
  const presets = pad?.kind === "rt" || pad?.kind === "lt" ? tools.angles : pad?.kind === "repeat" ? COUNTS : DISTANCES;
  const keypadAllowed = pad ? pad.kind !== "rt" && pad.kind !== "lt" ? true : tools.any_angle : false;
  const maxValue = pad?.kind === "repeat" ? 36 : pad?.kind === "rt" || pad?.kind === "lt" ? 360 : 300;
  const nextStage = result?.passed && result.unlocked_level > stage ? stage + 1 : null;

  return (
    <div className="relative flex h-full flex-col">
      <TopBar
        title={sandbox ? "Sandbox" : info ? `${info.data.level}. ${info.data.title}` : "…"}
        onBack={onBack}
        right={<CoinChip balance={coins} />}
      />

      {!sandbox && info && (
        <div className="flex items-center justify-between gap-2 px-4 text-xs">
          <span className={`rounded-full px-2 py-0.5 font-bold ${isTest ? "bg-amber-500/20 text-amber-200" : "bg-emerald-500/20 text-emerald-200"}`}>
            {isTest ? "TEST" : "LEARN"} · {info.data.chapter_name}
          </span>
          {isTest ? (
            <span className="font-semibold tabular-nums text-white" aria-label="Time">⏱ {clock(elapsed)}</span>
          ) : (
            <span className="text-muted">Par: {info.data.par} {info.data.par === 1 ? "block" : "blocks"}</span>
          )}
        </div>
      )}
      {!sandbox && info && !isTest && (
        <p className="mx-4 mt-1 rounded-xl bg-emerald-500/10 px-3 py-1.5 text-sm text-emerald-100">💡 {info.data.tip}</p>
      )}

      <div ref={wrap} className="relative mx-3 my-1.5 min-h-0 flex-1">
        <div className="absolute inset-0 grid place-items-center">
          {side > 0 && (
            <TurtleBoard
              size={side}
              target={target}
              showTarget={!isTest}
              drawn={frame.drawn}
              turtle={frame.turtle}
              arc={!isTest || sandbox ? frame.arc : null}
              hint={hint}
              label={sandbox ? "Your drawing" : isTest ? "Your drawing (the target is on the card)" : "Your drawing, with the target in faint dashes"}
            />
          )}
        </div>
        {isTest && info && (
          <div className="absolute right-1 top-1 z-10 w-32 rounded-xl border border-amber-400/40 bg-ink/90 p-2 text-xs shadow-xl">
            <button type="button" onClick={() => setShowCard((v) => !v)} className="flex w-full justify-between font-bold text-amber-200">
              Card <span>{showCard ? "▴" : "▾"}</span>
            </button>
            {showCard && (
              <>
                <MiniDrawing lines={target} />
                <ul className="mt-1 grid gap-0.5 text-[11px] text-muted">
                  {info.data.facts.map((f) => (
                    <li key={f}>{f}</li>
                  ))}
                  <li>Par: {info.data.par} {info.data.par === 1 ? "block" : "blocks"}</li>
                </ul>
              </>
            )}
          </div>
        )}
      </div>

      {/* The program as real Logo: tap a block to pick it, tap again to change it. */}
      <div className="mx-3 flex min-h-11 flex-wrap items-center gap-1 rounded-xl border border-line bg-panel px-2 py-1.5 font-mono text-xs" aria-label="Your program">
        <span className="text-muted">&gt;</span>
        {toks.length === 0 && <span className="text-muted">tap a chip to start</span>}
        {toks.map((t, i) =>
          t.id === null ? (
            <span key={i} className={`font-bold ${t.of === openRepeat ? "text-yellow-300" : "text-muted"}`}>
              {t.text === "]" && t.of === openRepeat ? <span className="caret mr-0.5 text-yellow-300">▍</span> : null}
              {t.text}
            </span>
          ) : (
            <button
              type="button"
              key={i}
              onClick={() => selectToken(t.id ?? 0)}
              className={`rounded-md px-1 py-0.5 ${frame.block === t.id && running ? "bg-amber-400 text-ink" : selected === t.id ? "bg-accent/30 ring-1 ring-accent" : "bg-panel-2"}`}
            >
              {t.text}
            </button>
          ),
        )}
        {openRepeat === null && toks.length > 0 && <span className="caret text-accent">▍</span>}
      </div>

      <div className="mx-3 mt-1.5 grid grid-cols-5 gap-1.5">
        {tools.chips.map((c) => {
          const [code, word] = CHIP_LABEL[c] ?? [c, c];
          const disabled = !ready || (c === "repeat" && cursorDepth >= tools.depth);
          return (
            <button
              type="button"
              key={c}
              disabled={disabled}
              onClick={() => {
                sfx.unlock();
                if (c === "pu" || c === "pd") addSimple(c);
                else setPad({ kind: c });
              }}
              className={`flex min-h-12 flex-col items-center justify-center rounded-xl border font-mono text-sm font-black transition active:scale-95 disabled:opacity-30 ${CHIP_STYLE[c] ?? ""}`}
            >
              {code}
              <span className="font-sans text-[9px] font-semibold opacity-80">{word}</span>
            </button>
          );
        })}
        {cursorDepth > 0 && (
          <button type="button" onClick={closeRepeat} className="flex min-h-12 flex-col items-center justify-center rounded-xl border border-yellow-400/60 bg-yellow-500/10 font-mono text-sm font-black text-yellow-100">
            ]
            <span className="font-sans text-[9px] font-semibold">End loop</span>
          </button>
        )}
      </div>

      <div className="mx-3 mt-1.5 grid grid-cols-4 gap-1.5 text-xs font-semibold">
        <button type="button" onClick={deleteBlock} disabled={!program.length} className="min-h-10 rounded-xl bg-panel-2 disabled:opacity-40">
          ⌫ {selected !== null ? "Delete" : "Last"}
        </button>
        <button type="button" onClick={undo} disabled={!history.length} className="flex min-h-10 items-center justify-center gap-1 rounded-xl bg-panel-2 disabled:opacity-40">
          <UndoIcon size={14} /> Undo
        </button>
        <button type="button" onClick={clearAll} disabled={!program.length} className="min-h-10 rounded-xl bg-panel-2 disabled:opacity-40">
          Clear
        </button>
        <button
          type="button"
          onClick={() => setSpeed((s) => (s === "slow" ? "normal" : s === "normal" ? "fast" : "slow"))}
          className="min-h-10 rounded-xl bg-panel-2"
          aria-label={`Speed: ${SPEEDS[speed].label}`}
        >
          {speed === "slow" ? "🐢" : speed === "normal" ? "🚶" : "🐇"} {SPEEDS[speed].label}
        </button>
      </div>

      <div className={`mx-3 mt-1.5 grid gap-1.5 pb-[max(env(safe-area-inset-bottom),10px)] ${sandbox ? "grid-cols-3" : "grid-cols-4"}`}>
        <Button onClick={() => run(false)} disabled={!ready} className="min-h-12 whitespace-nowrap px-1 text-sm">
          ▶ Run
        </Button>
        <Button variant="secondary" onClick={() => (running ? skipToEnd() : run(true))} disabled={!ready} className="min-h-12 whitespace-nowrap px-1 text-sm">
          {running ? "⏭ End" : "Step"}
        </Button>
        {!sandbox && (
          <button
            type="button"
            onClick={askHint}
            disabled={!info}
            className="flex min-h-12 flex-col items-center justify-center rounded-2xl border border-line bg-panel-2 text-xs font-semibold disabled:opacity-40"
          >
            <BulbIcon size={16} />
            <span className="text-gold">{info?.prices.hint ?? "…"}</span>
          </button>
        )}
        {sandbox ? (
          <Button
            variant="secondary"
            onClick={() => {
              resetBoard();
              shown.current = [];
            }} className="min-h-12 whitespace-nowrap px-1 text-sm">
            Wipe board
          </Button>
        ) : (
          <Button onClick={() => void check()} disabled={!info || checking} className="min-h-12 whitespace-nowrap bg-emerald-500 px-1 text-sm text-ink hover:bg-emerald-400">
            {checking ? "…" : "✔ Check"}
          </Button>
        )}
      </div>

      {toast && <p className="absolute inset-x-5 bottom-44 z-30 rounded-xl bg-panel-2 p-3 text-center text-sm shadow-xl">{toast}</p>}

      <Modal open={pad !== null} onClose={() => (setPad(null), setTyped(""))} title={pad ? padTitle(pad) : ""}>
        {pad?.kind === "color" ? (
          <div className="grid grid-cols-3 gap-2">
            {COLORS.map((c) => (
              <button type="button" key={c.id} onClick={() => chooseColor(c.id)} className="flex min-h-14 items-center justify-center gap-2 rounded-xl border border-line bg-panel-2 font-bold">
                <span className="size-5 rounded-full" style={{ background: c.hex }} />
                {c.name}
              </button>
            ))}
          </div>
        ) : pad ? (
          <div className="grid gap-3">
            <div className="grid grid-cols-4 gap-2">
              {presets.map((n) => (
                <button type="button" key={n} onClick={() => choose(n)} className="min-h-12 rounded-xl border border-line bg-panel-2 font-mono text-lg font-black">
                  {n}
                  {pad.kind === "rt" || pad.kind === "lt" ? "°" : ""}
                </button>
              ))}
            </div>
            {keypadAllowed && (
              <>
                <div className="flex items-center justify-between rounded-xl bg-ink px-3 py-2 font-mono text-xl">
                  <span>{typed || <span className="text-muted">your number</span>}</span>
                  <button type="button" onClick={() => setTyped((t) => t.slice(0, -1))} className="text-muted" aria-label="Delete digit">
                    ⌫
                  </button>
                </div>
                <div className="grid grid-cols-6 gap-1.5">
                  {["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"].map((d) => (
                    <button type="button" key={d} onClick={() => setTyped((t) => (t + d).replace(/^0+/, "").slice(0, 3))} className="min-h-11 rounded-lg bg-panel-2 font-mono text-lg font-bold">
                      {d}
                    </button>
                  ))}
                  <button
                    type="button"
                    disabled={!typed || Number(typed) < 1 || Number(typed) > maxValue}
                    onClick={() => choose(Number(typed))}
                    className="col-span-2 min-h-11 rounded-lg bg-accent font-bold text-ink disabled:opacity-40"
                  >
                    OK
                  </button>
                </div>
              </>
            )}
          </div>
        ) : null}
      </Modal>

      <ConfirmSpend request={spend} busy={buying} onConfirm={() => void buyHint()} onCancel={() => setSpend(null)} />

      <Modal open={result !== null} onClose={() => setResult(null)} title={result?.passed ? (isTest ? "Test passed! 🎉" : "You did it! 🎉") : "Not quite yet"}>
        {result && (
          <div className="grid gap-3 text-center">
            {result.passed && (
              <div className="flex justify-center">
                <Stars count={result.stars} size={40} />
              </div>
            )}
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-2xl bg-panel-2 p-3 text-left text-sm">
              <dt className="text-muted">Drawing matches</dt>
              <dd className="text-right font-bold">{result.accuracy}%</dd>
              <dt className="text-muted">Blocks</dt>
              <dd className="text-right font-bold">
                {result.blocks} <span className="text-muted">(par {result.par})</span>
              </dd>
              {isTest && (
                <>
                  <dt className="text-muted">Time</dt>
                  <dd className="text-right font-bold">{clock(result.seconds)}</dd>
                </>
              )}
              {result.passed && (
                <>
                  <dt className="text-muted">Coins</dt>
                  <dd className="text-right font-bold text-gold">{result.first_clear ? `+${result.coins_earned}` : "replay: 0"}</dd>
                </>
              )}
            </dl>
            {!result.passed && (
              <p className="text-sm text-muted">
                {result.coverage < 94 ? "Some lines are still missing. " : ""}
                {result.precision < 90 ? "Some lines are in the wrong place. " : ""}
                Press Run to watch your turtle, and compare with {isTest ? "the card" : "the dashed lines"}.
              </p>
            )}
            {result.passed && result.blocks > result.par && (
              <p className="text-sm text-muted">Can you do it with {result.par} blocks? Try REPEAT if you know it!</p>
            )}
            {nextStage ? (
              <Button onClick={() => onStage(nextStage)}>{isTest ? "Next lesson →" : "Take the Test →"}</Button>
            ) : null}
            <Button variant={result.passed ? "secondary" : "primary"} onClick={() => setResult(null)}>
              {result.passed ? "Stay here" : "Keep trying"}
            </Button>
            {result.passed && (
              <Button variant="ghost" onClick={onBack}>
                All levels
              </Button>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}

function padTitle(pad: Pad): string {
  const verb = pad.edit !== undefined ? "Change" : "Pick";
  switch (pad.kind) {
    case "fd":
      return `${verb}: how far forward?`;
    case "bk":
      return `${verb}: how far back?`;
    case "rt":
      return `${verb}: turn right how much?`;
    case "lt":
      return `${verb}: turn left how much?`;
    case "repeat":
      return `${verb}: repeat how many times?`;
    default:
      return `${verb} a colour`;
  }
}

/** The Test's target, small, on the reference card. */
function MiniDrawing({ lines }: { lines: Line[] }) {
  return (
    <svg viewBox={`${-HALF} ${-HALF} ${2 * HALF} ${2 * HALF}`} className="mt-1 aspect-square w-full rounded-lg bg-panel" aria-label="The drawing to make">
      {lines.map((l, i) => (
        <line key={i} x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} stroke={l.color} strokeWidth={5} strokeLinecap="round" />
      ))}
      <circle cx={0} cy={0} r={6} fill="#4ade80" />
    </svg>
  );
}
