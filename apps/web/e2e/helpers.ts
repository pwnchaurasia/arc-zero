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

/** Collects console errors (CSP violations show up here) for a test to assert on. */
export function watchConsole(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") errors.push(`${m.type()}: ${m.text()}`);
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}
