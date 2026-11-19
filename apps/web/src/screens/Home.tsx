import { useMemo, useState } from "react";

import type { HomeGame, Me } from "../api/types";
import { LEVEL_COUNT as NEONCOIL_LEVELS } from "../games/neoncoil/levels";
import { loadSaved as neonCoilSaved, openLevel as neonCoilOpen, totalStars as neonCoilStars } from "../games/neoncoil/skins";
import { useInstall } from "../state/install";
import { recentGames } from "../state/recent";
import { useSession } from "../state/session";
import { CoinChip } from "../ui/CoinChip";
import { GearIcon, InstallIcon } from "../ui/icons";
import { Button, IconButton } from "../ui/kit";
import { GameLogo } from "./GameLogo";

/**
 * Games on the home screen. Set `image` to a square logo in public/games/
 * (e.g. "/games/water-sort.webp") to replace the drawn placeholder.
 */
export const GAMES: { id: HomeGame; name: string; tagline: string; image?: string }[] = [
  {
    id: "water-sort",
    name: "Water Sort",
    tagline: "Pour until every bottle holds one colour.",
    image: "/games/water-sort.webp",
  },
  {
    id: "brick-blast",
    name: "Brick Blast",
    tagline: "Aim once. Bounce everything. Break it all.",
    image: "/games/brick-blast.webp",
  },
  {
    id: "metro-jam",
    name: "MetroJam",
    tagline: "Clear the jam. Fill every car. Don't block the bays.",
    image: "/games/metro-jam.webp",
  },
  {
    id: "dead-bridge",
    name: "Dead Bridge Assault",
    tagline: "Hold the bridge. Break the cages. Survive the horde.",
    image: "/games/dead-bridge.webp",
  },
  {
    id: "gridsnap",
    name: "GridSnap",
    tagline: "Drop the shapes. Fill a line. Chase your best.",
    image: "/games/gridsnap.webp",
  },
  {
    id: "traceout",
    name: "TraceOut",
    tagline: "Tap a line to send it out. Mind what's in the way.",
    image: "/games/traceout.webp",
  },
  {
    id: "cipher9",
    name: "Cipher9",
    tagline: "Sudoku without lives or game over. Just logic.",
    image: "/games/cipher9.webp",
  },
  {
    id: "tacshift",
    name: "TacShift",
    tagline: "Tic-tac-toe that shifts: vanishing marks, nine boards, or a friend.",
    image: "/games/tacshift.webp",
  },
  {
    id: "logoquest",
    name: "LogoQuest",
    tagline: "Program a turtle with FD, RT and REPEAT. Draw your way to coding.",
    image: "/games/logoquest.webp",
  },
  {
    id: "neoncoil",
    name: "NeonCoil",
    tagline: "Steer a neon snake through 30 arenas. Each one a bit faster.",
    image: "/games/neoncoil.webp",
  },
];

/** Home screen filters (decision 2026-11-18). A game can be in more than one. */
const CATEGORIES: { id: string; label: string; emoji: string; games: HomeGame[] }[] = [
  { id: "puzzles", label: "Puzzles", emoji: "🧩", games: ["water-sort", "metro-jam", "gridsnap", "traceout", "cipher9"] },
  { id: "action", label: "Action", emoji: "💥", games: ["brick-blast", "dead-bridge", "neoncoil"] },
  { id: "brain", label: "Brain & Logic", emoji: "🧠", games: ["cipher9", "logoquest", "traceout", "tacshift"] },
  { id: "board", label: "Board", emoji: "🎮", games: ["tacshift"] },
  { id: "junior", label: "Junior", emoji: "🧒", games: ["logoquest", "water-sort", "neoncoil"] },
];

/** Games without numbered levels open somewhere else. */
const NO_LEVELS: ReadonlySet<HomeGame> = new Set(["tacshift"]);

interface Progress {
  cleared: number;
  total: number;
  stars: number;
  /** "52/100 lvl · 153★" and friends. */
  line: string;
  /** Where Resume goes, and how it's described ("level 5/100"). */
  next: number | null;
  nextLabel: string;
}

function progressOf(me: Me | null, id: HomeGame): Progress {
  if (id === "neoncoil") {
    // Played only on this device: its progress is kept here, not on the server.
    const saved = neonCoilSaved();
    const cleared = Object.keys(saved.stars).length;
    const stars = neonCoilStars(saved);
    const next = neonCoilOpen(saved);
    return {
      cleared,
      total: NEONCOIL_LEVELS,
      stars,
      line: `${cleared}/${NEONCOIL_LEVELS} lvl · ${stars}★`,
      next,
      nextLabel: `level ${next}/${NEONCOIL_LEVELS}`,
    };
  }
  const p = me?.games[id];
  const stars = p ? Object.values(p.stars).reduce((a, b) => a + b, 0) : 0;
  if (id === "tacshift") {
    return { cleared: 0, total: 0, stars: 0, line: "vs AI · 2 players", next: null, nextLabel: "pick a mode" };
  }
  if (id === "logoquest") {
    // Two stages a lesson: Learn, then Test. A lesson counts once its Test is passed.
    const lessons = (p?.level_count ?? 200) / 2;
    const passed = Object.entries(p?.stars ?? {}).filter(([k, v]) => Number(k) % 2 === 0 && v > 0).length;
    const stage = Math.min(p?.unlocked_level ?? 1, p?.level_count ?? 200);
    return {
      cleared: passed,
      total: lessons,
      stars,
      line: `${passed}/${lessons} lessons · ${stars}★`,
      next: stage,
      nextLabel: `lesson ${Math.ceil(stage / 2)} · ${stage % 2 ? "Learn" : "Test"}`,
    };
  }
  const total = p?.level_count ?? 100;
  const cleared = p ? Object.keys(p.stars).length : 0;
  const next = Math.min(p?.unlocked_level ?? 1, total);
  if (id === "gridsnap") {
    const best = me?.gridsnap_best ?? 0;
    return { cleared, total, stars, line: `${cleared}/${total} lvl · best ${best}`, next: null, nextLabel: `endless · best ${best}` };
  }
  return { cleared, total, stars, line: `${cleared}/${total} lvl · ${stars}★`, next, nextLabel: `level ${next}/${total}` };
}


export function Home({
  onOpen,
  onResume,
  onSettings,
  onCheckpoint,
  onIosInstall,
}: {
  onOpen: (game: HomeGame) => void;
  /** Straight into play: a level, or (null) the game's own start screen. */
  onResume: (game: HomeGame, level: number | null) => void;
  onSettings: () => void;
  onCheckpoint: () => void;
  onIosInstall: () => void;
}) {
  const { me, error, refresh } = useSession();
  const install = useInstall();
  const [category, setCategory] = useState("all");
  const recent = useMemo(() => recentGames().filter((id) => GAMES.some((g) => g.id === id)), []);
  const shown = GAMES.filter((g) => category === "all" || CATEGORIES.find((c) => c.id === category)?.games.includes(g.id));

  const resume = (id: HomeGame) => {
    const p = progressOf(me, id);
    // Guests stop at the checkpoint: past it, Resume asks them to save first. NeonCoil
    // is played only on this device, so it has no checkpoint.
    if (id !== "neoncoil" && p.next !== null && !me?.signed_in && !me?.all_levels_open && p.next > (me?.guest_max_level ?? 3)) {
      onCheckpoint();
      return;
    }
    onResume(id, NO_LEVELS.has(id) ? null : p.next);
  };

  const chip = (id: string, label: string, emoji: string | null) => (
    <button
      type="button"
      key={id}
      aria-pressed={category === id}
      onClick={() => setCategory(id)}
      className={`flex shrink-0 items-center gap-1.5 rounded-full border px-4 py-2 text-sm font-bold transition active:scale-95 ${
        category === id ? "border-accent bg-accent/15 text-accent" : "border-line bg-panel text-white/90 hover:border-accent/50"
      }`}
    >
      {emoji && <span aria-hidden="true">{emoji}</span>}
      {label}
    </button>
  );

  return (
    <div className="mx-auto flex h-full w-full max-w-6xl flex-col overflow-y-auto">
      <header className="flex items-center justify-between gap-3 px-5 pb-2 pt-5">
        <div className="min-w-0">
          <h1 className="min-h-9 text-3xl font-black tracking-tight sm:min-h-10 sm:text-4xl">{me?.brand}</h1>
          <p className="truncate text-sm text-muted">
            {me?.name ? `Playing as ${me.name}` : "No ads. No tracking. Just games."}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <CoinChip />
          <IconButton label="Settings" onClick={onSettings}>
            <GearIcon />
          </IconButton>
        </div>
      </header>

      {install.mode && (
        <button
          type="button"
          onClick={() => (install.mode === "ios" ? onIosInstall() : void install.install())}
          className="mx-5 mt-3 flex items-center gap-3 rounded-2xl border border-accent/30 bg-accent/10 p-4 text-left"
        >
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-accent/20 text-accent">
            <InstallIcon />
          </span>
          <span>
            <span className="block font-bold text-accent">Install the app</span>
            <span className="block text-sm text-muted">Full screen, from your home screen. Still no ads.</span>
          </span>
        </button>
      )}

      {error && (
        <div className="mx-5 mt-3 flex items-center justify-between gap-3 rounded-2xl bg-red-500/15 p-4 text-sm text-red-200">
          <span>{error}</span>
          <Button variant="secondary" onClick={() => void refresh()}>
            Retry
          </Button>
        </div>
      )}

      {me?.all_levels_open && (
        <p className="mx-5 mt-3 rounded-2xl border border-fuchsia-400/40 bg-fuchsia-500/10 p-3 text-sm text-fuchsia-200">
          <strong>Playtest mode:</strong> every level is open. Local only; the live game refuses
          this setting.
        </p>
      )}

      {me?.registration_required && (
        <button
          type="button"
          onClick={onCheckpoint}
          className="mx-5 mt-3 rounded-2xl border border-gold/40 bg-gold/10 p-4 text-left"
        >
          <p className="font-bold text-gold">Checkpoint reached</p>
          <p className="text-sm text-muted">Save your progress to unlock the next levels.</p>
        </button>
      )}

      {/* Category chips: one row that scrolls sideways on phones, wraps on wider screens. */}
      <nav aria-label="Categories" className="no-scrollbar mt-3 flex shrink-0 gap-2 overflow-x-auto px-5 pb-1 md:flex-wrap md:overflow-visible">
        {chip("all", `All (${GAMES.length})`, null)}
        {CATEGORIES.filter((c) => c.games.length).map((c) => chip(c.id, c.label, c.emoji))}
      </nav>

      {category === "all" && recent.length > 0 && (
        <section className="mt-5 shrink-0" aria-label="Continue playing">
          <h2 className="px-5 text-sm font-bold uppercase tracking-wider text-muted">Continue playing</h2>
          <div className="no-scrollbar mt-2 flex snap-x scroll-px-5 gap-3 overflow-x-auto px-5 pb-1">
            {recent.map((id) => {
              const g = GAMES.find((x) => x.id === id);
              if (!g) return null;
              const p = progressOf(me, id);
              return (
                <div
                  key={id}
                  className="flex w-[17.5rem] shrink-0 snap-start items-center gap-3 rounded-2xl border border-line bg-panel p-2.5 sm:w-80"
                >
                  <button type="button" onClick={() => onOpen(id)} className="size-16 shrink-0 overflow-hidden rounded-xl" aria-label={`${g.name}: all levels`}>
                    <GameLogo game={g.id} image={g.image} />
                  </button>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-extrabold">{g.name}</p>
                    <p className="truncate text-xs text-muted">{p.nextLabel}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => resume(id)}
                    aria-label={`Resume ${g.name}`}
                    className="shrink-0 rounded-full bg-accent px-3.5 py-2 text-xs font-black tracking-wide text-ink transition active:scale-95"
                  >
                    RESUME
                  </button>
                </div>
              );
            })}
          </div>
        </section>
      )}

      <section className="mt-5 shrink-0" aria-label="Games">
        <h2 className="px-5 text-sm font-bold uppercase tracking-wider text-muted">
          {category === "all" ? "All games" : CATEGORIES.find((c) => c.id === category)?.label}
        </h2>
        {/* 2 per row on phones, 3 on tablets, up to 5 on a laptop. */}
        <div className="grid grid-cols-2 gap-3 p-5 pt-2 sm:grid-cols-3 sm:gap-4 lg:grid-cols-4 xl:grid-cols-5">
          {shown.map((g) => {
            const p = progressOf(me, g.id);
            return (
              <button
                type="button"
                key={g.id}
                onClick={() => onOpen(g.id)}
                className="group flex flex-col overflow-hidden rounded-3xl border border-line bg-panel text-left transition hover:border-accent/60 active:scale-[0.98]"
              >
                <div className="aspect-[16/10] overflow-hidden">
                  <div className="h-full transition duration-300 group-hover:scale-105">
                    <GameLogo game={g.id} image={g.image} fill />
                  </div>
                </div>
                <div className="flex flex-1 flex-col gap-1.5 p-3">
                  <h3 className="text-base font-extrabold leading-tight sm:text-lg">{g.name}</h3>
                  <p className="hidden text-xs text-muted sm:line-clamp-2">{g.tagline}</p>
                  <div className="mt-auto">
                    {p.total > 0 && (
                      <div className="h-1.5 overflow-hidden rounded-full bg-ink/60">
                        <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${(p.cleared / p.total) * 100}%` }} />
                      </div>
                    )}
                    <p className="mt-1.5 text-xs text-muted">{p.line}</p>
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </section>

      <footer className="mt-auto px-5 pb-6 text-center text-xs text-muted">
        Every move is verified on our server, so progress is fair for everyone.
      </footer>
    </div>
  );
}
