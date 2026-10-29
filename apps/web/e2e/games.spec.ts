import { expect, test } from "@playwright/test";

import { bottlePosition, solveWaterSort, watchConsole } from "./helpers";

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
