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
