import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests against a running stack: the production build served by
 * `vite preview` (strict CSP) plus the API on :8000. See README "E2E".
 */
export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  // CI runners have no GPU, so the game canvases render in software. One test at a time
  // at 1x pixel density keeps the page responsive on a slow runner (two workers at the
  // Pixel 7's 2.6x density starved the main thread and timed out).
  workers: process.env.CI ? 1 : undefined,
  // Every test is independent (its own guest), so tests in one file can run apart too;
  // CI splits them across machines with --shard.
  fullyParallel: true,
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:4173",
    ...devices["Pixel 7"],
    ...(process.env.CI ? { deviceScaleFactor: 1 } : {}),
    hasTouch: false,
    channel: process.env.E2E_CHANNEL ?? undefined,
    trace: "retain-on-failure",
  },
});
