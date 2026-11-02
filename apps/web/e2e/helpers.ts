import type { Page } from "@playwright/test";

type Board = number[][];

function pourAmount(b: Board, f: number, t: number): number {
  const src = b[f] ?? [];
  const dst = b[t] ?? [];
  if (f === t || !src.length || dst.length === 4) return 0;
  const top = src.at(-1);
  if (dst.length && dst.at(-1) !== top) return 0;
  let run = 0;
  for (let i = src.length - 1; i >= 0 && src[i] === top; i--) run++;
  return Math.min(run, 4 - dst.length);
}

const solved = (b: Board) =>
  b.every((x) => !x.length || (x.length === 4 && x.every((c) => c === x[0])));

/** Breadth-first solver for the small early boards (stands in for a human). */
export function solveWaterSort(start: Board): [number, number][] {
  const key = (b: Board) => JSON.stringify(b);
  const queue: [Board, [number, number][]][] = [[start, []]];
  const seen = new Set([key(start)]);
  for (let item = queue.shift(); item; item = queue.shift()) {
    const [b, path] = item;
    if (solved(b)) return path;
    for (let f = 0; f < b.length; f++) {
      for (let t = 0; t < b.length; t++) {
        const k = pourAmount(b, f, t);
        if (!k) continue;
        const next = b.map((x) => [...x]);
        const src = next[f] ?? [];
        (next[t] ?? []).push(...src.splice(src.length - k, k));
        if (!seen.has(key(next))) {
          seen.add(key(next));
          queue.push([next, [...path, [f, t]]]);
        }
      }
    }
  }
  throw new Error("unsolvable board");
}

/** Screen position of bottle `i`, mirroring WaterSortView.computeLayout. */
export async function bottlePosition(page: Page, count: number, i: number) {
  const box = await page.locator(".game-surface").boundingBox();
  if (!box) throw new Error("no game surface");
  const { width: W, height: H } = box;
  const rows = count <= 6 ? 1 : 2;
  const perRow = Math.ceil(count / rows);
  const ratio = 4 * 0.78 + 0.4;
  const gap = 0.55;
  const w = Math.max(
    24,
    Math.min((W * 0.94) / (perRow + (perRow - 1) * gap), (H * 0.82) / (rows * ratio + (rows - 1) * 0.9), 72),
  );
  const h = w * ratio;
  const top = (H - h) / 2 + w * 0.78 * 0.4;
  const rowW = perRow * w + (perRow - 1) * w * gap;
  return { x: box.x + (W - rowW) / 2 + i * w * (1 + gap) + w / 2, y: box.y + top + h * 0.6 };
}

/**
 * Warnings that mean our app misbehaved. Everything else at warning level is ignored:
 * on GPU-less machines (CI, Docker) Chrome renders WebGL in software and logs driver
 * noise such as "GL Driver Message ... GPU stall due to ReadPixels".
 */
const APP_WARNING = /brick blast:|Content.Security.Policy|Refused to/i;

/**
 * Collects console errors (CSP violations are errors), uncaught exceptions, and our own
 * warnings (e.g. a WASM/server divergence) for a test to assert on.
 */
export function watchConsole(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (m) => {
    const text = m.text();
    if (m.type() === "error" || (m.type() === "warning" && APP_WARNING.test(text))) {
      errors.push(`${m.type()}: ${text}`);
    }
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

interface MjVehicleData {
  kind: string;
  color: number;
  x: number;
  y: number;
  dir: "n" | "e" | "s" | "w";
}

export interface MjLevelForTest {
  width: number;
  height: number;
  barriers: [number, number][];
  vehicles: MjVehicleData[];
  queue: number[];
  queue_len: number;
  bays: number;
}

const MJ_RIDERS: Record<string, number> = { microcar: 1, hatchback: 2, sedan: 4, mpv: 6, minivan: 9, minibus: 12, bus: 49 };
const MJ_LENGTH: Record<string, number> = { microcar: 1, hatchback: 1, sedan: 2, mpv: 2, minivan: 3, minibus: 3, bus: 4 };
const MJ_DELTA = { n: [0, -1], e: [1, 0], s: [0, 1], w: [-1, 0] } as const;

export interface MjState {
  gone: boolean[];
  bays: [number, number][];
  head: number;
}

function mjCells(v: MjVehicleData) {
  const [dx, dy] = MJ_DELTA[v.dir];
  return Array.from({ length: MJ_LENGTH[v.kind] ?? 1 }, (_, i) => [v.x - dx * i, v.y - dy * i] as const);
}

/**
 * Replays taps on the known part of the queue (boarding stops at the first unknown
 * commuter, as in the game). A plain restatement of the rules for tests only.
 */
export function mjSimulate(level: MjLevelForTest, known: number[], taps: number[]): MjState {
  const state: MjState = {
    gone: level.vehicles.map(() => false),
    bays: Array.from({ length: level.bays }, () => [-1, 0] as [number, number]),
    head: 0,
  };
  for (const v of taps) {
    state.gone[v] = true;
    const slot = state.bays.findIndex(([b]) => b < 0);
    state.bays[slot] = [v, 0];
    for (;;) {
      const color = known[state.head];
      if (color === undefined) break;
      const at = state.bays.findIndex(
        ([b, r]) => b >= 0 && level.vehicles[b]?.color === color && r < (MJ_RIDERS[level.vehicles[b]?.kind ?? ""] ?? 0),
      );
      if (at < 0) break;
      const bay = state.bays[at] as [number, number];
      bay[1] += 1;
      state.head += 1;
      if (bay[1] === MJ_RIDERS[level.vehicles[bay[0]]?.kind ?? ""]) state.bays[at] = [-1, 0];
    }
  }
  return state;
}

/** Cars that could drive out and park right now. */
export function mjTappable(level: MjLevelForTest, state: MjState): number[] {
  if (!state.bays.some(([b]) => b < 0)) return [];
  const blocked = new Set<string>(level.barriers.map(([x, y]) => `${x},${y}`));
  level.vehicles.forEach((v, i) => {
    if (!state.gone[i]) mjCells(v).forEach(([x, y]) => blocked.add(`${x},${y}`));
  });
  return level.vehicles.flatMap((v, i) => {
    if (state.gone[i]) return [];
    const [dx, dy] = MJ_DELTA[v.dir];
    for (let x = v.x + dx, y = v.y + dy; x >= 0 && y >= 0 && x < level.width && y < level.height; x += dx, y += dy) {
      if (blocked.has(`${x},${y}`)) return [];
    }
    return [i];
  });
}

/**
 * A careful player: park the car whose colour is needed soonest among the commuters
 * in view (beyond the seats already parked for it). `jitter` breaks ties differently
 * on each retry.
 */
export function mjNextTap(level: MjLevelForTest, known: number[], state: MjState, jitter: number): number | null {
  const options = mjTappable(level, state);
  if (!options.length) return null;
  const need = (color: number) => {
    let parked = state.bays
      .filter(([b]) => b >= 0 && level.vehicles[b]?.color === color)
      .reduce((n, [b, r]) => n + (MJ_RIDERS[level.vehicles[b]?.kind ?? ""] ?? 0) - r, 0);
    for (let i = state.head; i < known.length; i++) {
      if (known[i] !== color) continue;
      if (parked === 0) return i - state.head;
      parked -= 1;
    }
    return 1e6;
  };
  const score = (v: number) => {
    const car = level.vehicles[v];
    if (!car) return 1e9;
    return need(car.color) * 100 + (MJ_RIDERS[car.kind] ?? 0) + ((v * 7 + jitter * 13) % 11) / 100;
  };
  return options.reduce((best, v) => (score(v) < score(best) ? v : best));
}
