import { defineConfig, devices } from "@playwright/test";

/**
 * E2E config. Tests run against the RUNNING stack (docker compose up): the web app
 * at :8081 (which proxies /api → the control plane). Auth uses a pasted `nry_`
 * token injected into localStorage by global-setup — no Firebase browser login.
 *
 * Browser: Playwright's BUNDLED Chromium (not the branded `channel: "chrome"`). The
 * branded channel triggers a system-wide, sudo-requiring install of Google Chrome —
 * which fails on a non-interactive self-hosted runner ("sudo: a terminal is
 * required"). Bundled Chromium downloads per-user (`playwright install chromium`,
 * ~/Library/Caches/ms-playwright) with no sudo, and needs no system browser present.
 */
const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:8081";

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  // CI keeps the streaming line reporter (the job log is the first thing anyone reads) AND writes
  // an HTML report, which the workflow uploads on failure. Screenshots and traces are already
  // captured below; until that upload existed they were written into the runner and thrown away,
  // so diagnosing a CI-only failure meant reasoning from a stack trace about a screen nobody
  // could look at.
  reporter: process.env.CI
    ? [["line"], ["html", { open: "never" }]]
    : ("list" as const),
  // 30s was not enough headroom on a loaded CI stack: a spec that waits ~25s for a data-gated
  // dialog and then drives a picker (readyPicker alone budgets 20s) has nothing left, and fails
  // for being slow rather than wrong. A longer ceiling costs nothing when tests pass — it is only
  // ever spent on a test that was going to be slow or fail anyway.
  timeout: 60_000,
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
      // Bundled Chromium (no `channel` → no branded-Chrome system install). See header.
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
