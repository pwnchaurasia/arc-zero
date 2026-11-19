/**
 * NeonCoil arena levels (decisions 2026-11-19): a level is 20 fruit (rising to 25 by
 * level 30), a few minutes of play. Within a level the snake speeds up every 5 fruit;
 * each level also starts a little faster. Level 1 is an open arena; from level 2
 * every level has its own walls: pillars, a bar, corners, rooms, zigzags, mazes, and
 * then pairs of them.
 *
 * Layouts are drawn relative to the board (19 cells on its short side, the long
 * side fits the screen), so they work on phones, tablets and laptops alike. The
 * snake's starting lane is always carved free, and every open cell stays reachable
 * (checked by the tests).
 */
import type { Cell } from "./snake";

export const LEVEL_COUNT = 30;
/** Fruit to eat between speed-ups. */
export const SPEED_EVERY = 5;
const START_TICK = 150;
const MIN_TICK = 80;
/** Each level starts 2% faster; each speed-up inside a level is 8%. */
const LEVEL_FACTOR = 1.02;
const STEP_FACTOR = 1.08;

/** Fruit to clear a level: 20 on level 1, 25 on level 30. */
export function fruitGoal(level: number): number {
  return 20 + Math.round((5 * (Math.min(level, LEVEL_COUNT) - 1)) / (LEVEL_COUNT - 1));
}

/** Speed step inside a level (1, 2, ...) after `eaten` fruit. */
export const speedStep = (eaten: number) => Math.floor(eaten / SPEED_EVERY) + 1;

/** Milliseconds per cell on `level` after `eaten` fruit, never below 80 ms. */
export function levelTick(level: number, eaten = 0): number {
  const start = START_TICK / Math.pow(LEVEL_FACTOR, level - 1);
  return Math.max(MIN_TICK, Math.round(start / Math.pow(STEP_FACTOR, speedStep(eaten) - 1)));
}

/** Where the snake starts: head first, heading up, in the lower middle. */
export function startBody(cols: number, rows: number): Cell[] {
  const x = Math.floor(cols / 2);
  return [0, 1, 2, 3].map((i) => ({ x, y: rows - 6 + i }));
}

type Layout = (c: number, r: number) => Cell[];

const hbar = (y: number, x0: number, x1: number): Cell[] =>
  Array.from({ length: x1 - x0 + 1 }, (_, i) => ({ x: x0 + i, y }));
const vbar = (x: number, y0: number, y1: number): Cell[] =>
  Array.from({ length: y1 - y0 + 1 }, (_, i) => ({ x, y: y0 + i }));
const block = (x: number, y: number, w: number, h: number): Cell[] =>
  Array.from({ length: w * h }, (_, i) => ({ x: x + (i % w), y: y + Math.floor(i / w) }));
const without = (cells: Cell[], gaps: (c: Cell) => boolean) => cells.filter((c) => !gaps(c));

const LAYOUTS: Record<string, Layout> = {
  empty: () => [],
  pillars: (c, r) => {
    const x1 = Math.floor(c / 4) - 1;
    const x2 = c - Math.floor(c / 4) - 1;
    const y1 = Math.floor(r / 4) - 1;
    const y2 = r - Math.floor(r / 4) - 1;
    return [...block(x1, y1, 2, 2), ...block(x2, y1, 2, 2), ...block(x1, y2, 2, 2), ...block(x2, y2, 2, 2)];
  },
  bar: (c, r) => hbar(Math.floor(r / 2) - 1, Math.floor(c / 4), c - 1 - Math.floor(c / 4)),
  corners: (c, r) => {
    const k = 3;
    const len = Math.max(3, Math.floor(Math.min(c, r) / 4));
    return [
      ...hbar(k, k, k + len - 1),
      ...vbar(k, k, k + len - 1),
      ...hbar(k, c - k - len, c - k - 1),
      ...vbar(c - k - 1, k, k + len - 1),
      ...hbar(r - k - 1, k, k + len - 1),
      ...vbar(k, r - k - len, r - k - 1),
      ...hbar(r - k - 1, c - k - len, c - k - 1),
      ...vbar(c - k - 1, r - k - len, r - k - 1),
    ];
  },
  twoBars: (c, r) => [
    ...hbar(Math.floor(r / 4), 0, c - 1 - Math.floor(c / 3)),
    ...hbar(Math.floor(r / 2), Math.floor(c / 3), c - 1),
  ],
  dots: (c, r) => {
    const out: Cell[] = [];
    for (let y = 3; y < r - 2; y += 4) for (let x = 2; x < c - 1; x += 4) out.push({ x, y });
    return out;
  },
  cross: (c, r) => {
    const mx = Math.floor(c / 2);
    const my = Math.floor(r / 2) - 2;
    const arm = Math.max(3, Math.floor(Math.min(c, r) / 4));
    return [...hbar(my, mx - arm, mx + arm), ...vbar(mx, my - arm, my + arm)];
  },
  frame: (c, r) => {
    const k = 3;
    const mx = Math.floor(c / 2);
    const my = Math.floor(r / 2);
    const ring = [...hbar(k, k, c - k - 1), ...hbar(r - k - 1, k, c - k - 1), ...vbar(k, k, r - k - 1), ...vbar(c - k - 1, k, r - k - 1)];
    // A 3-wide door in the middle of each side.
    return without(ring, (p) => Math.abs(p.x - mx) <= 1 || Math.abs(p.y - my) <= 1);
  },
  zigzag: (c, r) => {
    const a = Math.floor(c / 4);
    const b = c - 1 - Math.floor(c / 4);
    return [...vbar(a, 0, r - 6), ...vbar(b, 5, r - 1)];
  },
  rooms: (c, r) => {
    const mx = Math.floor(c / 2);
    const my = Math.floor(r / 2) - 1;
    return [
      ...without(hbar(my, 0, c - 1), (p) => p.x === 2 || p.x === c - 3 || p.x === mx),
      ...without(vbar(mx, 0, my), (p) => p.y === Math.floor(my / 2)),
    ];
  },
  comb: (c, r) => {
    const out: Cell[] = [];
    for (let x = 2; x < c - 1; x += 4) out.push(...vbar(x, 0, Math.floor(r * 0.45)));
    return out;
  },
  maze: (c, r) => {
    const out: Cell[] = [];
    for (let x = 2; x < c - 1; x += 4) out.push(...vbar(x, 0, Math.floor(r * 0.6)));
    for (let x = 4; x < c - 1; x += 4) out.push(...vbar(x, Math.floor(r * 0.4), r - 1));
    return out;
  },
  diamond: (c, r) => {
    const mx = Math.floor(c / 2);
    const my = Math.floor(r / 2) - 2;
    const k = Math.max(3, Math.floor(Math.min(c, r) / 4));
    const out: Cell[] = [];
    for (let i = 0; i <= k; i++) {
      out.push({ x: mx - k + i, y: my - i }, { x: mx + k - i, y: my - i }, { x: mx - k + i, y: my + i }, { x: mx + k - i, y: my + i });
    }
    // Two gaps so the middle can be reached.
    return without(out, (p) => p.y === my);
  },
};

/** Which layouts make up each level (1-based). */
const PLAN: string[][] = [
  ["empty"],
  ["pillars"],
  ["bar"],
  ["corners"],
  ["twoBars"],
  ["dots"],
  ["cross"],
  ["frame"],
  ["zigzag"],
  ["rooms"],
  ["diamond"],
  ["comb"],
  ["pillars", "bar"],
  ["corners", "cross"],
  ["maze"],
  ["pillars", "twoBars"],
  ["cross", "frame"],
  ["dots", "zigzag"],
  ["pillars", "rooms"],
  ["dots", "comb"],
  ["corners", "diamond"],
  ["dots", "frame"],
  ["pillars", "zigzag"],
  ["frame", "zigzag"],
  ["cross", "rooms"],
  ["corners", "twoBars"],
  ["comb", "maze"],
  ["frame", "diamond"],
  ["pillars", "maze"],
  ["dots", "maze"],
];

export const layoutNames = (level: number) => PLAN[level - 1] ?? ["empty"];

/** The walls of a level on a `cols` x `rows` board. */
export function levelWalls(level: number, cols: number, rows: number): Cell[] {
  const start = startBody(cols, rows);
  const mx = Math.floor(cols / 2);
  // The starting lane (the body and 3 cells ahead) is always open.
  const lane = (p: Cell) => p.x === mx && p.y >= (start[0]?.y ?? 0) - 3 && p.y <= rows - 1;
  const seen = new Set<string>();
  const walls: Cell[] = [];
  for (const name of layoutNames(level)) {
    for (const p of LAYOUTS[name]?.(cols, rows) ?? []) {
      const key = `${p.x},${p.y}`;
      if (p.x < 0 || p.y < 0 || p.x >= cols || p.y >= rows || lane(p) || seen.has(key)) continue;
      seen.add(key);
      walls.push(p);
    }
  }
  return walls;
}
