import type { GameId } from "../api/types";
import { useSession } from "../state/session";
import { GearIcon } from "../ui/icons";
import { Button, IconButton } from "../ui/kit";

export const GAMES: { id: GameId; name: string; tagline: string; accent: string }[] = [
  {
    id: "water-sort",
    name: "Water Sort",
    tagline: "Pour until every bottle holds one colour.",
    accent: "from-sky-500/30 to-fuchsia-500/20",
  },
  {
    id: "brick-blast",
    name: "Brick Blast",
    tagline: "Aim once. Bounce everything. Break it all.",
    accent: "from-amber-500/30 to-rose-500/20",
  },
];

export function Home({
  onOpen,
  onSettings,
  onCheckpoint,
}: {
  onOpen: (game: GameId) => void;
  onSettings: () => void;
  onCheckpoint: () => void;
}) {
  const { me, error, refresh } = useSession();

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <header className="flex items-center justify-between px-5 pb-2 pt-5">
        <div>
          <h1 className="text-3xl font-black tracking-tight">Arc Zero</h1>
          <p className="text-sm text-muted">No ads. No tracking. Just games.</p>
        </div>
        <IconButton label="Settings" onClick={onSettings}>
          <GearIcon />
        </IconButton>
      </header>

      {error && (
        <div className="mx-5 mt-3 flex items-center justify-between gap-3 rounded-2xl bg-red-500/15 p-4 text-sm text-red-200">
          <span>{error}</span>
          <Button variant="secondary" onClick={() => void refresh()}>
            Retry
          </Button>
        </div>
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

      <main className="grid gap-4 p-5">
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
              className={`rounded-3xl border border-line bg-gradient-to-br ${g.accent} p-5 text-left transition active:scale-[0.98]`}
            >
              <h2 className="text-2xl font-extrabold">{g.name}</h2>
              <p className="mt-1 text-muted">{g.tagline}</p>
              <div className="mt-4 h-2 overflow-hidden rounded-full bg-ink/60">
                <div
                  className="h-full rounded-full bg-accent transition-all"
                  style={{ width: `${(cleared / total) * 100}%` }}
                />
              </div>
              <p className="mt-2 text-sm text-muted">
                {cleared}/{total} levels · {stars} ★
              </p>
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
