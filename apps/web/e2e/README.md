# Web E2E (Playwright)

Browser end-to-end tests that drive the **running stack** (docker compose).

## Run

```bash
docker compose up -d --build           # stack must be up (web :8081 → api :3000)
pnpm --filter @naary/web exec playwright install chromium   # OR rely on system Chrome
pnpm --filter @naary/web test:e2e
```

The config uses the **system Chrome** (`channel: "chrome"`), so no browser download
is required locally.

## How auth works

These tests skip the Firebase browser login. `global-setup.ts`:

1. Gets a `nry_` API token — from `E2E_API_TOKEN`, else mints one via the
   `mint-token` CLI against the running DB.
2. Seeds a `default` workflow (start → approval → end) so run/canvas tests have data.
3. Writes a `storageState` with the token in `localStorage` (`naary_api_token`),
   so every test starts authenticated.

## Env overrides

| var | default |
|---|---|
| `E2E_BASE_URL` | `http://localhost:8081` |
| `E2E_API_BASE` | `http://localhost:3000` |
| `E2E_API_TOKEN` | _(minted if unset)_ |
| `E2E_TENANT` | `t-demo` |

## Coverage

- `smoke` — authenticated shell renders; unauthenticated → `/auth`.
- `navigation` — sidebar → Workflows/Runs/Schedules (+ real data through the proxy).
- `canvas` — add a node, open the config modal, delete it.
- `runs` — start a run → paused at approval → approve → completed (the durable loop).
- `fix-with-ai` — "Fix with AI" on a failed run → the canvas at `?fix=<runId>` with the failure
  written into the AI panel (#995).
- `authoring-smoke` — THE FIRST-RUN PATH (#830): generate with AI → open a node → type `{{` →
  pick a ref → save → test-run a node, asserting each step by its user-visible symptom.

## Stubbed specs (`fix-with-ai`, `authoring-smoke`)

Most specs here drive REAL data through the stack. Two deliberately do not — for opposite reasons.

`fix-with-ai` stubs every response it reads with `page.route`, because what it guards is the SPA's
behaviour **while it waits** — a panel that must open on arrival, a box that must be read-only
mid-wait, a stage that must terminate. An instantly-fulfilled route gives no observable window, so
those assertions would be vacuous. The stubs sleep before fulfilling, which makes the intermediate
states real.

`authoring-smoke` stubs exactly ONE hop, the builder session + turn, and nothing else: it is the
only paid, non-deterministic call on the path (a BYOK model call in CI is not acceptable) and the
only one whose response must be pinned, because the generated node ids are what the `{{` reference
list is asserted against. Its stub does NOT sleep — it guards a landed graph, not a wait. The save
and the single-node test run go to the real stack, or those two steps would assert nothing.

If you add assertions to either, keep two rules: the delays (where there are any) are lower bounds
— a slow machine only widens the window, never narrows it — and every new assertion must be shown
to FAIL: break the app or the stub, watch it go red, revert.

## In CI

`.github/workflows/e2e.yml` builds the stack and runs this whole directory on every pull request
and every push to `main` (per-run compose project + ephemeral ports, so parallel runs don't
collide). This line used to read "CI wiring is a follow-up" — it has not been true since that
workflow landed, and a stale note here is how a suite comes to be believed unwatched.
