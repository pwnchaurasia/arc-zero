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

interface MjLevelForTest {
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

/**
 * Finds a tap order that wins a fully visible MetroJam level (stands in for a human).
 * A plain restatement of the rules for tests only; the real rules live in Rust.
 */
export function solveMetroJam(level: MjLevelForTest): number[] {
  const cells = (v: MjVehicleData) => {
    const [dx, dy] = MJ_DELTA[v.dir];
    return Array.from({ length: MJ_LENGTH[v.kind] ?? 1 }, (_, i) => [v.x - dx * i, v.y - dy * i] as const);
  };
  const seen = new Set<string>();
  const search = (gone: boolean[], bays: [number, number][], head: number, order: number[]): number[] | null => {
    if (head === level.queue_len) return order;
    const key = `${gone.map(Number).join("")}|${JSON.stringify(bays)}|${head}`;
    if (seen.has(key)) return null;
    seen.add(key);
    if (!bays.some(([v]) => v < 0)) return null;
    const blocked = new Set<string>(level.barriers.map(([x, y]) => `${x},${y}`));
    level.vehicles.forEach((v, i) => {
      if (!gone[i]) cells(v).forEach(([x, y]) => blocked.add(`${x},${y}`));
    });
    for (let i = 0; i < level.vehicles.length; i++) {
      const v = level.vehicles[i];
      if (!v || gone[i]) continue;
      const [dx, dy] = MJ_DELTA[v.dir];
      let [x, y] = [v.x + dx, v.y + dy];
      let free = true;
      while (x >= 0 && y >= 0 && x < level.width && y < level.height) {
        if (blocked.has(`${x},${y}`)) free = false;
        x += dx;
        y += dy;
      }
      if (!free) continue;
      const nextGone = [...gone];
      nextGone[i] = true;
      const nextBays = bays.map((b) => [...b] as [number, number]);
      const slot = nextBays.findIndex(([b]) => b < 0);
      nextBays[slot] = [i, 0];
      let h = head;
      for (;;) {
        const color = level.queue[h];
        if (color === undefined) break;
        const at = nextBays.findIndex(
          ([b, r]) => b >= 0 && level.vehicles[b]?.color === color && r < (MJ_RIDERS[level.vehicles[b]?.kind ?? ""] ?? 0),
        );
        if (at < 0) break;
        const bay = nextBays[at] as [number, number];
        bay[1] += 1;
        h += 1;
        if (bay[1] === MJ_RIDERS[level.vehicles[bay[0]]?.kind ?? ""]) nextBays[at] = [-1, 0];
      }
      const found = search(nextGone, nextBays, h, [...order, i]);
      if (found) return found;
    }
    return null;
  };
  const start = search(
    level.vehicles.map(() => false),
    Array.from({ length: level.bays }, () => [-1, 0] as [number, number]),
    0,
    [],
  );
  if (!start) throw new Error("no solution found");
  return start;
}
