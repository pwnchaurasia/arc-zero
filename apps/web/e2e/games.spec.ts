import { expect, test } from "@playwright/test";

import { bottlePosition, mjNextTap, mjSimulate, solveWaterSort, watchConsole } from "./helpers";

type MjLevel = Parameters<typeof mjSimulate>[0];
interface MjResult {
  coins_earned: number;
  first_clear: boolean;
  unlocked_level: number;
}

test("home loads under the production CSP with no errors", async ({ page }) => {
  const errors = watchConsole(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Arc Zero" })).toBeVisible();
  await expect(page.getByText("Water Sort")).toBeVisible();
  expect(errors).toEqual([]);
});

test("a guest solves Water Sort level 1 and the server unlocks level 2", async ({ page }) => {
  const errors = watchConsole(page);
  await page.goto("/");
  await page.getByText("Water Sort").click();
  const startResp = page.waitForResponse((r) => r.url().includes("/water-sort/levels/1/start"));
  await page.getByRole("button", { name: "Level 1", exact: true }).click();
  const start = (await (await startResp).json()) as { board: number[][] };
  await page.waitForTimeout(800);

  const done = page.waitForResponse((r) => r.url().includes("/water-sort/levels/1/complete"));
  for (const [from, to] of solveWaterSort(start.board)) {
    const a = await bottlePosition(page, start.board.length, from);
    const b = await bottlePosition(page, start.board.length, to);
    await page.mouse.click(a.x, a.y);
    await page.mouse.click(b.x, b.y);
    await page.waitForTimeout(650);
  }
  const result = (await (await done).json()) as { stars: number; unlocked_level: number };
  expect(result.unlocked_level).toBe(2);
  await expect(page.getByText("Level clear!")).toBeVisible();
  expect(errors).toEqual([]);
});

test("a Brick Blast turn is simulated identically by browser and server", async ({ page }) => {
  const errors = watchConsole(page);
  await page.goto("/");
  await page.getByText("Brick Blast").click();
  const startResp = page.waitForResponse((r) => r.url().includes("/brick-blast/levels/1/start"));
  await page.getByRole("button", { name: "Level 1", exact: true }).click();
  await startResp;
  await page.waitForTimeout(800);

  const box = await page.locator(".game-surface").boundingBox();
  if (!box) throw new Error("no game surface");
  const x = box.x + box.width / 2;
  const y = box.y + box.height * 0.9;
  const turn = page.waitForResponse((r) => r.url().includes("/turn"));
  await page.mouse.move(x, y - 10);
  await page.mouse.down();
  await page.mouse.move(x + 60, y - 300, { steps: 6 });
  await page.mouse.up();
  const res = await turn;
  expect(res.status()).toBe(200);
  await page.getByRole("button", { name: "Skip to end of turn" }).click();
  await expect(page.getByText(/Balls \d+/)).toBeVisible();
  await page.waitForTimeout(500);
  // A divergence between WASM and the server's result is logged as a warning.
  expect(errors).toEqual([]);
});

test("a guest clears MetroJam level 1, earns coins, and a replay earns none", async ({ page }) => {
  test.setTimeout(180_000);
  const errors = watchConsole(page);
  await page.goto("/");
  await page.getByText("MetroJam").click();

  /** Plays like a careful person: only what the server has revealed, restarting when stuck. */
  const play = async () => {
    const startResp = page.waitForResponse((r) => r.url().includes("/metro-jam/levels/1/start"));
    await page.getByRole("button", { name: "Level 1", exact: true }).click();
    const start = (await (await startResp).json()) as { data: MjLevel };
    const level = start.data;
    let known = [...level.queue];
    page.on("response", async (r) => {
      if (!r.url().includes("/metro-jam/levels/1/reveal") || !r.ok()) return;
      const { queue } = (await r.json()) as { queue: number[] };
      if (queue.length > known.length) known = queue;
    });
    await page.waitForTimeout(600);
    for (let attempt = 0; attempt < 20; attempt++) {
      const taps: number[] = [];
      for (;;) {
        const car = mjNextTap(level, known, mjSimulate(level, known, taps), attempt);
        if (car === null) break;
        taps.push(car);
        const wins = mjSimulate(level, known, taps).head === level.queue_len;
        // A winning tap is submitted; any other asks the server to reveal more of the queue.
        const reply = page.waitForResponse((r) => r.url().includes(wins ? "/levels/1/complete" : "/reveal"));
        // Keyboard path: the visually hidden per-car buttons (one per car on the canvas).
        await page.getByRole("button", { name: new RegExp(`^Car ${car + 1}:`) }).press("Enter");
        const res = await reply;
        if (wins) return (await res.json()) as MjResult;
        await page.waitForTimeout(260); // the server rejects inhumanly fast play (200 ms a tap)
      }
      // Stuck: the game offers a replay (or coins); take the free replay.
      await page.getByRole("button", { name: "Replay level" }).first().click();
      await page.waitForTimeout(300);
    }
    throw new Error("could not clear level 1 in 20 tries");
  };

  const first = await play();
  expect(first.first_clear).toBe(true);
  expect(first.coins_earned).toBe(5);
  expect(first.unlocked_level).toBe(2);
  // The win card waits until the last commuters have boarded and the last car has left.
  await expect(page.getByText("Level clear!")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("+5 coins")).toBeVisible();

  await page.getByRole("button", { name: "All levels" }).click();
  const again = await play();
  expect(again.coins_earned).toBe(0);
  await expect(page.getByText("Replay: no coins this time.")).toBeVisible({ timeout: 60_000 });
  expect(errors).toEqual([]);
});

test("the Coins page explains the rules from the server", async ({ page }) => {
  const errors = watchConsole(page);
  await page.goto("/");
  await page.getByRole("button", { name: /coins\. Coin rules/ }).click();
  await expect(page.getByRole("heading", { name: "Earning coins" })).toBeVisible();
  await expect(page.getByText("Levels 1–3")).toBeVisible();
  await expect(page.getByText("Replaying a level you've already cleared earns nothing.")).toBeVisible();
  expect(errors).toEqual([]);
});

test("Dead Bridge Assault runs, steers, pauses, and shows the horde", async ({ page }) => {
  const errors = watchConsole(page);
  await page.goto("/");
  await page.getByText("Dead Bridge Assault", { exact: true }).click();
  const startResp = page.waitForResponse((r) => r.url().includes("/dead-bridge/levels/1/start"));
  await page.getByRole("button", { name: "Level 1", exact: true }).click();
  expect((await startResp).status()).toBe(200);
  await page.getByRole("button", { name: "Start" }).click();
  const box = await page.locator(".game-surface").boundingBox();
  if (!box) throw new Error("no game surface");
  // Steer left and right for a few seconds, as a player would.
  for (const fx of [0.5, 0.3, 0.7, 0.5]) {
    await page.mouse.move(box.x + box.width * fx, box.y + box.height * 0.8);
    await page.waitForTimeout(900);
  }
  await expect(page.getByText(/Wave \d\/3/)).toBeVisible();
  await page.getByRole("button", { name: "Pause" }).click();
  await expect(page.getByRole("button", { name: "Resume" }).first()).toBeVisible();
  // Assists need a charge or coins: the first tap on an empty one asks to pay.
  await page.getByRole("button", { name: /Airstrike/ }).click();
  await expect(page.getByText("Use Airstrike?")).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  expect(errors).toEqual([]);
});

test("a guest plays GridSnap by keyboard and by drag, then ends the game", async ({ page }) => {
  const errors = watchConsole(page);
  await page.goto("/");
  const opened = page.waitForResponse((r) => r.url().includes("/gridsnap/runs/") && r.request().method() !== "OPTIONS");
  await page.getByRole("heading", { name: "GridSnap" }).click();
  await page.getByRole("button", { name: /^Endless/ }).click();
  await opened;
  await page.waitForTimeout(600);

  // Keyboard: pick the first shape, place it at the first free spot.
  let placed = page.waitForResponse((r) => r.url().includes("/place"));
  await page.keyboard.press("1");
  await page.keyboard.press("Enter");
  expect((await placed).status()).toBe(200);
  await expect(page.getByLabel(/^Score [1-9]/)).toBeVisible();

  // Drag the second shape so it lands centred on cell (5, 5): the shape floats
  // 70 px above the finger, so the finger goes 70 px lower (same layout as GridSnapView).
  const box = await page.locator(".game-surface").boundingBox();
  if (!box) throw new Error("no game surface");
  const { width: W, height: H } = box;
  const trayH = Math.min(Math.max(H * 0.24, 110), 190);
  const cell = Math.floor(Math.min((W - 24) / 8, (H - trayH - 24) / 8, 64));
  const bx = Math.round((W - cell * 8) / 2);
  const by = Math.round(Math.max(12, (H - trayH - cell * 8) / 2));
  const trayY = by + cell * 8 + trayH / 2;
  placed = page.waitForResponse((r) => r.url().includes("/place"));
  await page.mouse.move(box.x + W / 2, box.y + trayY);
  await page.mouse.down();
  await page.mouse.move(box.x + bx + 5.5 * cell, box.y + by + 5.5 * cell + 70, { steps: 8 });
  await page.waitForTimeout(150);
  await page.mouse.up();
  expect((await placed).status()).toBe(200);

  const ended = page.waitForResponse((r) => r.url().includes("/end"));
  await page.getByRole("button", { name: /End game/ }).first().click();
  await page.getByRole("dialog").getByRole("button", { name: "End game" }).click();
  const final = (await (await ended).json()) as { score: number; new_best: boolean };
  expect(final.score).toBeGreaterThan(0);
  await expect(page.getByText("New best!")).toBeVisible();

  await page.getByRole("button", { name: "Leaderboards" }).last().click();
  await expect(page.getByRole("button", { name: "Save your progress to join the leaderboards" })).toBeVisible();
  expect(errors).toEqual([]);
});

test("a guest clears TraceOut level 1 without a mistake", async ({ page }) => {
  const errors = watchConsole(page);
  await page.goto("/");
  await page.getByRole("heading", { name: "TraceOut" }).click();
  const startResp = page.waitForResponse((r) => r.url().includes("/traceout/levels/1/start"));
  await page.getByRole("button", { name: "Level 1", exact: true }).click();
  const start = (await (await startResp).json()) as {
    data: { width: number; height: number; lines: { cells: [number, number][] }[] };
  };
  await page.waitForTimeout(600);

  // Like a careful player: only tap lines whose way out is clear.
  const { width, height, lines } = start.data;
  const left = new Set(lines.map((_, i) => i));
  const free = (i: number) => {
    const cells = lines[i]?.cells ?? [];
    const [hx, hy] = cells[cells.length - 1] ?? [0, 0];
    const [px, py] = cells[cells.length - 2] ?? [0, 0];
    const [dx, dy] = [hx - px, hy - py];
    const taken = new Set([...left].flatMap((j) => (lines[j]?.cells ?? []).map(([x, y]) => `${x},${y}`)));
    for (let x = hx + dx, y = hy + dy; x >= 0 && y >= 0 && x < width && y < height; x += dx, y += dy) {
      if (taken.has(`${x},${y}`)) return false;
    }
    return true;
  };
  const done = page.waitForResponse((r) => r.url().includes("/traceout/levels/1/complete"));
  while (left.size > 0) {
    const next = [...left].find(free);
    if (next === undefined) throw new Error("level 1 is not solvable");
    left.delete(next);
    await page.getByRole("button", { name: new RegExp(`^Line ${next + 1}:`) }).press("Enter");
    await page.waitForTimeout(200); // the server rejects inhumanly fast play
  }
  const result = (await (await done).json()) as { stars: number; coins_earned: number; unlocked_level: number };
  expect(result.stars).toBe(3);
  expect(result.coins_earned).toBe(5);
  expect(result.unlocked_level).toBe(2);
  await expect(page.getByText("Level clear!")).toBeVisible();
  await expect(page.getByText(/Flawless!/)).toBeVisible();
  expect(errors).toEqual([]);
});

test("a GridSnap level starts with stones to clear and takes a shape", async ({ page }) => {
  const errors = watchConsole(page);
  await page.goto("/");
  await page.getByRole("heading", { name: "GridSnap" }).click();
  const started = page.waitForResponse((r) => r.url().includes("/gridsnap/levels/1/start"));
  await page.getByRole("button", { name: "Level 1", exact: true }).click();
  const start = (await (await started).json()) as { view: { cells: number[] }; par: number };
  const stones = start.view.cells.filter((c) => c === 8).length;
  expect(stones).toBeGreaterThan(0);
  await expect(page.getByLabel(`${stones} stones left`)).toBeVisible();
  await page.waitForTimeout(600);

  const placed = page.waitForResponse((r) => r.url().includes("/place"));
  await page.keyboard.press("1");
  await page.keyboard.press("Enter");
  expect((await placed).status()).toBe(200);
  await expect(page.getByText(`Shapes 1 / ${start.par}`)).toBeVisible();
  expect(errors).toEqual([]);
});

/** Backtracking solver for a 9x9 grid (stands in for a person who knows Sudoku). */
function solveSudoku(puzzle: number[]): number[] {
  const g = [...puzzle];
  const fits = (c: number, d: number) => {
    const r = Math.floor(c / 9);
    const col = c % 9;
    const br = Math.floor(r / 3) * 3;
    const bc = Math.floor(col / 3) * 3;
    for (let i = 0; i < 9; i++) {
      if (g[r * 9 + i] === d || g[i * 9 + col] === d) return false;
      if (g[(br + Math.floor(i / 3)) * 9 + bc + (i % 3)] === d) return false;
    }
    return true;
  };
  const go = (): boolean => {
    const c = g.indexOf(0);
    if (c < 0) return true;
    for (let d = 1; d <= 9; d++) {
      if (!fits(c, d)) continue;
      g[c] = d;
      if (go()) return true;
    }
    g[c] = 0;
    return false;
  };
  if (!go()) throw new Error("no solution");
  return g;
}

test("a guest solves Cipher9 level 1 by tapping cells and numbers", async ({ page }) => {
  const errors = watchConsole(page);
  await page.goto("/");
  await page.getByRole("heading", { name: "Cipher9" }).click();
  await expect(page.getByText("Warmup · naked singles")).toBeVisible();
  const startResp = page.waitForResponse((r) => r.url().includes("/cipher9/levels/1/start"));
  await page.getByRole("button", { name: "Level 1", exact: true }).click();
  const start = (await (await startResp).json()) as { data: { puzzle: number[] } } & Record<string, unknown>;
  expect(JSON.stringify(start)).not.toContain("solution");
  const solution = solveSudoku(start.data.puzzle);

  // One wrong number first: it repeats in its row, so it shows as a clash. Then erase it.
  const first = start.data.puzzle.indexOf(0);
  const cell = (c: number) => page.getByRole("button", { name: new RegExp(`^Row ${Math.floor(c / 9) + 1}, column ${(c % 9) + 1}:`) });
  const rowGiven = start.data.puzzle.slice(Math.floor(first / 9) * 9, Math.floor(first / 9) * 9 + 9).find((d) => d > 0) ?? 1;
  await cell(first).click();
  await page.getByRole("button", { name: `Enter ${rowGiven}` }).click();
  await expect(cell(first)).toHaveAccessibleName(/repeats/);
  await page.getByRole("button", { name: "Erase" }).click();

  const done = page.waitForResponse((r) => r.url().includes("/cipher9/levels/1/complete"));
  for (let c = 0; c < 81; c++) {
    if (start.data.puzzle[c]) continue;
    await cell(c).click();
    await page.getByRole("button", { name: `Enter ${solution[c]}` }).click();
    await page.waitForTimeout(160); // the server rejects inhumanly fast play
  }
  const result = (await (await done).json()) as { stars: number; mistakes: number; coins_earned: number; unlocked_level: number };
  // The clash was a wrong number: one mistake, two stars.
  expect(result.mistakes).toBe(1);
  expect(result.stars).toBe(2);
  expect(result.coins_earned).toBe(5);
  expect(result.unlocked_level).toBe(2);
  await expect(page.getByText("Level clear!")).toBeVisible();
  await expect(page.getByText(/1 wrong number along the way/)).toBeVisible();
  expect(errors).toEqual([]);
});

/** Perfect play for X on a 3x3 board (0 empty, 1 X, 2 O): the move with the best outcome. */
function perfectX(cells: number[]): number {
  const lines = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]];
  const winner = (b: number[]) =>
    lines.map(([a = 0, c = 0, d = 0]) => (b[a] && b[a] === b[c] && b[a] === b[d] ? b[a] : 0)).find(Boolean) ?? 0;
  const score = (b: number[], turn: number): number => {
    const w = winner(b);
    if (w) return w === 1 ? 1 : -1;
    if (b.every(Boolean)) return 0;
    const results = b.flatMap((v, i) => (v ? [] : [score(b.map((x, j) => (j === i ? turn : x)), 3 - turn)]));
    return turn === 1 ? Math.max(...results) : Math.min(...results);
  };
  let best = -1;
  let move = cells.indexOf(0);
  cells.forEach((v, i) => {
    if (v) return;
    const s = score(cells.map((x, j) => (j === i ? 1 : x)), 2);
    if (s > best) {
      best = s;
      move = i;
    }
  });
  return move;
}

test("a guest holds TacShift's unbeatable AI to a draw and earns its coins", async ({ page }) => {
  const errors = watchConsole(page);
  await page.goto("/");
  await page.getByRole("heading", { name: "TacShift" }).click();
  await page.getByRole("tab", { name: "Classic" }).click();
  await page.getByRole("button", { name: /Unbeatable/ }).click();
  const started = page.waitForResponse((r) => r.url().endsWith("/tacshift/matches"));
  await page.getByRole("button", { name: "Play as X" }).click();
  let state = ((await (await started).json()) as { state: { cells: number[]; status: string } }).state;
  expect(JSON.stringify(state)).not.toContain("seed");
  while (state.status === "playing") {
    const cell = perfectX(state.cells);
    const reply = page.waitForResponse((r) => r.url().includes("/move"));
    await page.getByRole("button", { name: `Row ${Math.floor(cell / 3) + 1}, column ${(cell % 3) + 1}: empty` }).click();
    const body = (await (await reply).json()) as { state: { cells: number[]; status: string }; outcome: { result: string; coins_earned: number } | null };
    state = body.state;
    if (body.outcome) {
      expect(body.outcome.result).toBe("draw");
      expect(body.outcome.coins_earned).toBe(20);
    }
    await page.waitForTimeout(400); // the AI's reply lands after its thinking pause
  }
  await expect(page.getByRole("heading", { name: "Draw" })).toBeVisible();
  await expect(page.getByText("First draw against Unbeatable: +20 coins")).toBeVisible();
  expect(errors).toEqual([]);
});
