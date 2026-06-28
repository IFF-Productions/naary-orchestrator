import { defineConfig, devices } from "@playwright/test";

/**
 * E2E config. Tests run against the RUNNING stack (docker compose up): the web app
 * at :8081 (which proxies /api → the control plane). Auth uses a pasted `nry_`
 * token injected into localStorage by global-setup — no Firebase browser login.
 * Uses the system Chrome (channel: "chrome") so no browser download is needed.
 */
const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:8081";

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? "line" : "list",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL,
    storageState: "./e2e/.auth/state.json",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], channel: "chrome" },
    },
  ],
});
