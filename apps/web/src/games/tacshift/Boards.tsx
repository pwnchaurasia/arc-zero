import type { TsState } from "../../api/types";

const X = 1;
const O = 2;
const DRAWN = 3;

/** An X (cyan) or O (rose), drawn so it scales to any cell. */
export function Mark({ who, faded = false }: { who: number; faded?: boolean }) {
  if (!who) return null;
  return (
    <svg
      viewBox="0 0 100 100"
      aria-hidden="true"
      className={`pop-in size-[72%] ${who === X ? "text-cyan-400" : "text-rose-400"} ${faded ? "opacity-45" : ""}`}
      style={{ filter: `drop-shadow(0 0 6px ${who === X ? "rgb(34 211 238 / 0.55)" : "rgb(251 113 133 / 0.55)"})` }}
    >
      {who === X ? (
        <path d="M22 22 L78 78 M78 22 L22 78" stroke="currentColor" strokeWidth="13" strokeLinecap="round" fill="none" />
      ) : (
        <circle cx="50" cy="50" r="30" stroke="currentColor" strokeWidth="12" fill="none" />
      )}
    </svg>
  );
}

const who = (n: number) => (n === X ? "X" : n === O ? "O" : "empty");

interface BoardProps {
  state: TsState;
  onCell: (cell: number) => void;
  /** Taps are ignored (the AI is thinking, or the game is over). */
  locked: boolean;
  /** Infinity: the mark the player to move loses with their next mark. */
  vanishing: number | null;
  /** The radar's suggestion, pulsing gold. */
  radar: number | null;
}

/** Classic and Infinity: one 3x3 board. */
export function Board3({ state, onCell, locked, vanishing, radar }: BoardProps) {
  const won = new Set(state.status === "playing" ? [] : state.line);
  return (
    <div role="group" aria-label="Board" className="grid aspect-square w-full grid-cols-3 gap-2 rounded-3xl border border-line bg-panel p-2">
      {state.cells.map((c, i) => {
        const fading = vanishing === i;
        return (
          <button
            type="button"
            key={i}
            onClick={() => onCell(i)}
            disabled={locked || c !== 0}
            aria-label={`Row ${Math.floor(i / 3) + 1}, column ${(i % 3) + 1}: ${who(c)}${fading ? ", vanishes next" : ""}`}
            className={`relative grid place-items-center rounded-2xl transition active:scale-95 disabled:active:scale-100 ${
              won.has(i) ? "ts-win bg-gold/20" : "bg-panel-2"
            } ${radar === i ? "ts-radar" : ""}`}
          >
            <Mark who={c} faded={fading} />
            {fading && (
              <>
                <span className="pointer-events-none absolute inset-2 animate-pulse rounded-xl border-2 border-dashed border-white/50" />
                <span className="absolute right-1.5 top-1.5 rounded-full bg-ink/80 px-1.5 text-[10px] font-bold text-muted">fades</span>
              </>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** Ultimate: nine small boards. The one to play in glows; closed ones show their owner. */
export function BoardUltimate({ state, onCell, locked, radar }: Omit<BoardProps, "vanishing">) {
  const playing = state.status === "playing";
  const wonBoards = new Set(playing ? [] : state.line);
  return (
    <div role="group" aria-label="Ultimate board" className="grid aspect-square w-full grid-cols-3 gap-1.5 rounded-3xl border border-line bg-panel p-1.5">
      {Array.from({ length: 9 }, (_, b) => {
        const owner = state.boards[b] ?? 0;
        const open = owner === 0;
        const live = playing && open && (state.active === null || state.active === b);
        return (
          <div
            key={b}
            className={`relative grid grid-cols-3 gap-0.5 rounded-xl p-1 transition ${
              live ? "bg-amber-400/10 ring-2 ring-amber-400" : "bg-panel-2/60"
            } ${wonBoards.has(b) ? "ts-win" : ""}`}
          >
            {Array.from({ length: 9 }, (_, k) => {
              const cell = b * 9 + k;
              const c = state.cells[cell] ?? 0;
              return (
                <button
                  type="button"
                  key={k}
                  onClick={() => onCell(cell)}
                  disabled={locked || !live || c !== 0}
                  aria-label={`Board ${b + 1}, row ${Math.floor(k / 3) + 1}, column ${(k % 3) + 1}: ${who(c)}`}
                  className={`grid aspect-square place-items-center rounded-md bg-ink/50 ${radar === cell ? "ts-radar" : ""}`}
                >
                  <Mark who={c} />
                </button>
              );
            })}
            {!open && (
              <div className={`pointer-events-none absolute inset-0 grid place-items-center rounded-xl ${owner === DRAWN ? "bg-ink/70" : "bg-ink/60"}`}>
                {owner === DRAWN ? <span className="text-xs font-bold text-muted">draw</span> : <Mark who={owner} />}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
