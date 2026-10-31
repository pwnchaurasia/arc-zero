import type { GameId } from "../api/types";
import { useSession } from "../state/session";
import { LockIcon } from "../ui/icons";
import { Stars, TopBar } from "../ui/kit";
import { GAMES } from "./Home";

export function LevelSelect({
  game,
  onBack,
  onPlay,
  onCheckpoint,
}: {
  game: GameId;
  onBack: () => void;
  onPlay: (level: number) => void;
  onCheckpoint: () => void;
}) {
  const { me } = useSession();
  const progress = me?.games[game];
  const count = progress?.level_count ?? 0;
  const unlocked = progress?.unlocked_level ?? 1;
  const gated = !me?.signed_in;
  const name = GAMES.find((g) => g.id === game)?.name ?? game;

  return (
    <div className="flex h-full flex-col">
      <TopBar title={name} onBack={onBack} />
      <div className="grid flex-1 auto-rows-min grid-cols-5 gap-2 overflow-y-auto px-4 pb-6">
        {Array.from({ length: count }, (_, i) => i + 1).map((level) => {
          const stars = progress?.stars[String(level)] ?? 0;
          const behindGate = gated && me !== null && level > me.guest_max_level;
          const open = !!me?.all_levels_open || (level <= unlocked && !behindGate);
          return (
            <button
              type="button"
              key={level}
              onClick={() => {
                if (open) onPlay(level);
                else if (behindGate && me?.registration_required) onCheckpoint();
              }}
              aria-label={open ? `Level ${level}` : `Level ${level}, locked`}
              className={`flex aspect-square flex-col items-center justify-center rounded-2xl border text-lg font-bold transition active:scale-95 ${
                open
                  ? "border-line bg-panel-2 text-white"
                  : "border-transparent bg-panel/60 text-line"
              } ${level === unlocked && open ? "ring-2 ring-accent" : ""}`}
            >
              {open ? level : <LockIcon size={18} />}
              {open && stars > 0 && <Stars count={stars} size={10} />}
            </button>
          );
        })}
      </div>
    </div>
  );
}
