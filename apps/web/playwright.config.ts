import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests against a running stack: the production build served by
 * `vite preview` (strict CSP) plus the API on :8000. See README "E2E".
 */
export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:4173",
    ...devices["Pixel 7"],
    hasTouch: false,
    channel: process.env.E2E_CHANNEL ?? undefined,
    trace: "retain-on-failure",
  },
});
