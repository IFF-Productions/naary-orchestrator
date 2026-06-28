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

CI wiring (start the stack, then run this) is a follow-up.
