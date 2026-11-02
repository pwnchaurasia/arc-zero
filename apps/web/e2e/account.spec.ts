import { expect, test, type Page } from "@playwright/test";

import { bottlePosition, solveWaterSort, watchConsole } from "./helpers";

test.setTimeout(120_000);

/** Plays a level from the level list. Navigates like a player: the app restores the
 * current screen on reload, so `page.goto("/")` mid-game would reopen the level. */
async function clearWaterSortLevel(page: Page, level: number): Promise<void> {
  const startResp = page.waitForResponse((r) => r.url().includes(`/water-sort/levels/${level}/start`));
  await page.getByRole("button", { name: `Level ${level}`, exact: true }).click();
  const start = (await (await startResp).json()) as { board: number[][] };
  await page.waitForTimeout(800);
  const done = page.waitForResponse((r) => r.url().includes(`/water-sort/levels/${level}/complete`));
  for (const [from, to] of solveWaterSort(start.board)) {
    const a = await bottlePosition(page, start.board.length, from);
    const b = await bottlePosition(page, start.board.length, to);
    await page.mouse.click(a.x, a.y);
    await page.mouse.click(b.x, b.y);
    await page.waitForTimeout(650);
  }
  expect((await done).status()).toBe(200);
}

/** Reads the six numbered words from the key screen. */
async function shownKey(page: Page): Promise<string[]> {
  const items = page.locator("dialog[open] ol li span:last-child");
  // Saving runs proof-of-work first; wait until the key is actually on screen.
  await expect(items).toHaveCount(6, { timeout: 60_000 });
  const words = await items.allTextContents();
  return words.map((w) => w.trim());
}

/** Types the word the screen asks for; "Continue" must stay disabled until then. */
async function confirmKey(page: Page, words: string[]): Promise<void> {
  const dialog = page.locator("dialog[open]");
  const cont = dialog.getByRole("button", { name: "Continue" });
  await expect(cont).toBeDisabled();
  const asked = Number(/#(\d)/.exec((await dialog.getByText(/type word/i).textContent()) ?? "")?.[1]);
  const input = dialog.getByRole("textbox");
  await input.fill("definitely-wrong");
  await expect(cont).toBeDisabled();
  await input.fill(words[asked - 1] ?? "");
  await expect(cont).toBeEnabled();
  await cont.click();
}

test("save progress, confirm the key, replace a lost key, restore with the new one", async ({
  page,
  browser,
}) => {
  const errors = watchConsole(page);
  await page.goto("/");
  await page.getByText("Water Sort").click();
  for (const level of [1, 2, 3]) {
    await clearWaterSortLevel(page, level);
    if (level < 3) await page.getByRole("button", { name: "All levels" }).click();
  }

  // Level-3 gate: the checkpoint opens; saving runs proof-of-work in a worker.
  await expect(page.getByText("Cloud Checkpoint Reached!")).toBeVisible();
  await page.getByRole("button", { name: "Save my progress" }).click();
  const firstKey = await shownKey(page);
  await confirmKey(page, firstKey);

  // Lost the key? Create a new one from Settings while signed in.
  await page.getByRole("button", { name: "All levels" }).click();
  await page.getByRole("button", { name: "Back" }).click();
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: /Lost your key/ }).click();
  await page.getByRole("button", { name: "Create new key" }).click();
  const secondKey = await shownKey(page);
  expect(secondKey).not.toEqual(firstKey);
  await confirmKey(page, secondKey);

  // A fresh device: the old key is rejected, the new one restores the progress.
  const restoreOnFreshDevice = async (words: string[]) => {
    const fresh = await browser.newPage();
    await fresh.goto("/");
    await fresh.getByRole("button", { name: "Settings" }).click();
    await fresh.getByRole("button", { name: /I have a key/ }).click();
    await fresh.getByRole("textbox").fill(words.join(" "));
    await fresh.getByRole("button", { name: "Restore", exact: true }).click();
    return fresh;
  };
  const withOldKey = await restoreOnFreshDevice(firstKey);
  await expect(withOldKey.getByText("That key was not recognised.")).toBeVisible({ timeout: 30_000 });
  await withOldKey.close();
  const withNewKey = await restoreOnFreshDevice(secondKey);
  await expect(withNewKey.getByText("3/100 levels")).toBeVisible({ timeout: 30_000 });
  await withNewKey.close();

  expect(errors).toEqual([]);
});
