import type { HomeGame as GameId } from "../api/types";

/**
 * Which games were played most recently on this device, for the home screen's
 * "Continue playing" row. A per-device convenience: progress itself lives on the server.
 */

const KEY = "arc.recent";
const MAX = 6;

function read(): Partial<Record<GameId, number>> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Record<GameId, number>>;
  } catch {
    return {};
  }
}

export function markPlayed(game: GameId): void {
  const all = read();
  all[game] = Date.now();
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // storage blocked: the row just stays empty
  }
}

/** Most recent first. */
export function recentGames(): GameId[] {
  return (Object.entries(read()) as [GameId, number][])
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX)
    .map(([g]) => g);
}
