import type { TsMode, TsState } from "../../api/types";
import { engine } from "../../engine/wasm";

/** The player to move's mark that their next one would push off (Infinity, 3 down). */
export function vanishing(s: TsState): number | null {
  if (s.mode !== "infinity" || s.status !== "playing") return null;
  const q = s.queues[s.turn - 1];
  return q && q.length === 3 ? (q[0] ?? null) : null;
}

export function emptyState(mode: TsMode): TsState {
  const sim = new engine.TacShift(mode);
  const s = JSON.parse(sim.state()) as TsState;
  sim.free();
  return s;
}

/** Plays `cell` with the browser engine. `null` if the move isn't legal. */
export function applyLocal(s: TsState, cell: number): { state: TsState; vanished: number } | null {
  const sim = engine.TacShift.fromState(JSON.stringify(s));
  try {
    if (!sim.legal(cell)) return null;
    const vanished = sim.play(cell);
    return { state: JSON.parse(sim.state()) as TsState, vanished };
  } finally {
    sim.free();
  }
}

/** Each mode's rules in one line, for two people playing each other. */
export const PLAIN_RULES: Record<TsMode, string> = {
  infinity: "You keep only 3 marks. A 4th makes your oldest fade away, so there are no draws.",
  classic: "Three in a row wins. A full board with no line is a draw.",
  ultimate: "Nine boards. Where you play sends your opponent to that board. Win three boards in a row.",
};
