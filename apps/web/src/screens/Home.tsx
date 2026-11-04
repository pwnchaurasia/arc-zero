import type { GameId } from "../api/types";
import { useInstall } from "../state/install";
import { useSession } from "../state/session";
import { CoinChip } from "../ui/CoinChip";
import { GearIcon, InstallIcon } from "../ui/icons";
import { Button, IconButton } from "../ui/kit";
import { GameLogo } from "./GameLogo";

/**
 * Games on the home screen. Set `image` to a square logo in public/games/
 * (e.g. "/games/water-sort.webp") to replace the drawn placeholder.
 */
export const GAMES: { id: GameId; name: string; tagline: string; image?: string }[] = [
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
];

export function Home({
  onOpen,
  onSettings,
  onCheckpoint,
  onIosInstall,
}: {
  onOpen: (game: GameId) => void;
  onSettings: () => void;
  onCheckpoint: () => void;
  onIosInstall: () => void;
}) {
  const { me, error, refresh } = useSession();
  const install = useInstall();

  return (
    <div className="mx-auto flex h-full w-full max-w-6xl flex-col overflow-y-auto">
      <header className="flex items-center justify-between px-5 pb-2 pt-5">
        <div>
          <h1 className="text-3xl font-black tracking-tight">Arc Zero</h1>
          <p className="text-sm text-muted">
            {me?.name ? `Playing as ${me.name}` : "No ads. No tracking. Just games."}
          </p>
        </div>
        <div className="flex items-center gap-2">
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

      {/* 2 tiles per row on phones, up to 5 on a laptop. */}
      <main className="grid grid-cols-2 gap-4 p-5 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
        {GAMES.map((g) => {
          const progress = me?.games[g.id];
          const cleared = progress ? Object.keys(progress.stars).length : 0;
          const stars = progress ? Object.values(progress.stars).reduce((a, b) => a + b, 0) : 0;
          const total = progress?.level_count ?? 100;
          return (
            <button
              type="button"
              key={g.id}
              onClick={() => onOpen(g.id)}
              className="group flex flex-col overflow-hidden rounded-3xl border border-line bg-panel text-left transition hover:border-accent/60 active:scale-[0.98]"
            >
              <div className="overflow-hidden">
                <div className="transition duration-300 group-hover:scale-105">
                  <GameLogo game={g.id} image={g.image} />
                </div>
              </div>
              <div className="flex flex-1 flex-col p-3">
                <h2 className="text-base font-extrabold leading-tight sm:text-lg">{g.name}</h2>
                <p className="mt-1 line-clamp-2 text-xs text-muted">{g.tagline}</p>
                <div className="mt-auto pt-3">
                  <div className="h-1.5 overflow-hidden rounded-full bg-ink/60">
                    <div
                      className="h-full rounded-full bg-accent transition-all"
                      style={{ width: `${(cleared / total) * 100}%` }}
                    />
                  </div>
                  <p className="mt-1.5 text-xs text-muted">
                    {cleared}/{total} levels · {stars} ★
                  </p>
                  {g.id === "gridsnap" && (
                    <p className="text-xs text-muted">Endless best: {me?.gridsnap_best ?? 0}</p>
                  )}
                </div>
              </div>
            </button>
          );
        })}
      </main>

      <footer className="mt-auto px-5 pb-6 text-center text-xs text-muted">
        Every move is verified on our server, so progress is fair for everyone.
      </footer>
    </div>
  );
}
