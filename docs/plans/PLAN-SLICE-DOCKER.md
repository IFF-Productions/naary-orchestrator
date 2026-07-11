# PLAN — Slice: Containerize the full stack (docker compose)

**Goal:** `docker compose up` brings up the *entire* local stack — Postgres,
Keycloak, Temporal, DB migrations, the NestJS API, the Temporal worker, and the
web app — with one command. Today compose only runs Postgres + Keycloak; the
api/worker/web run as host processes and Temporal is a separate `start-dev`.

This is the **infra** slice (PRODUCTION-READINESS §3.A names "container images +
IaC" a blocker). It is dev-oriented: a single-command local stack, not a tuned
production image (prod images / ECS remain a later infra task).

## In scope
1. `.dockerignore` — keep build context small (no node_modules/.git/dist/.env).
2. `Dockerfile` (backend, repo root, multi-stage) — installs the whole pnpm
   workspace, runs `prisma generate`, and is the shared image for **both** the
   `api` and `worker` services (they differ only by `command`). Runs via the
   existing `ts-node` start scripts (parity with local dev).
3. `apps/web/Dockerfile` + `apps/web/nginx.conf` — `vite build` → static files
   served by nginx; nginx proxies `/api` → `api:3000` (matches the Vite dev
   proxy, so `lib/api.ts`'s `BASE=/api` works unchanged, same-origin, no CORS).
4. `docker-compose.yml` — add services:
   - `temporal` — `temporalio/temporal server start-dev --ip 0.0.0.0`, ports
     7233 (gRPC) + 8233 (UI), sqlite file on a named volume for persistence.
   - `migrate` — one-shot `prisma migrate deploy`, depends on Postgres healthy.
   - `api` — shared backend image, `command: pnpm --filter @naary/api start`.
   - `worker` — shared backend image, `command: pnpm --filter @naary/worker start`.
   - `web` — nginx image serving the built SPA on port 8081.
   - Backend services get `DATABASE_URL` pointing at the `postgres` service host
     and `TEMPORAL_ADDRESS=temporal:7233` (override the localhost `.env` values,
     which stay correct for host-run dev). `restart: unless-stopped` lets the
     api/worker self-heal the brief Temporal-not-ready race at first boot.
5. Docs — add the one-command path to README / PRODUCTION-READINESS §1.

## Pre-existing runtime bugs uncovered (had to fix to get a running stack)
Booting the api/worker in containers surfaced two bugs that also break the local
`pnpm run worker` / `pnpm run start` on `main` — the runtime paths were never
exercised (only vitest unit tests, which bypass Nest DI and the worker boot):
1. **Worker boot** — 3 type-only errors in `apps/worker/src/temporal/activities.ts`
   (readonly `as const` schema + a `Schema<>` union mismatch) made `ts-node` refuse
   to compile. Fixed with a `Record<string, unknown>` generic + an `unknown` widen;
   the runtime JSON schema is unchanged. (`apps/worker` typecheck was red on main —
   the root `tsc -b` only covers `packages/*`, so CI never caught it.)
2. **API boot** — `WebhooksModule` registered `WebhookService` directly, but its only
   constructor param is an optional interface (`KeyEncryptor`); Nest DI can't resolve
   an interface type → `UnknownDependenciesException` at bootstrap. Fixed with the
   codebase's `useFactory` pattern (as already used for `CredentialsService` etc.).

## Out of scope (do NOT build ahead)
- Production-grade images (distroless, non-root hardening, image size), ECS/EKS
  IaC, Temporal Cloud — these stay in PRODUCTION-READINESS §3.A.
- Canvas wiring and web OIDC login — the next two slices.

## Verification (DoD)
- `docker compose config` parses (valid compose).
- `docker compose build` succeeds for the backend + web images.
- `docker compose up -d` → all services healthy; `migrate` exits 0.
- Smoke: `curl localhost:3000/healthz` (or an existing public route) via the api
  container; web reachable at `localhost:8081`; Temporal UI at `localhost:8233`.
- `npx tsc -b` still clean; existing test suite still passes (no source changes
  to app code beyond config/docs).

## Security (CLAUDE.md)
- No secrets baked into images: `ENCRYPTION_KEY`, DB/Keycloak passwords come from
  `.env` at runtime, never `COPY`'d or `ENV`'d in the Dockerfile.
- `.dockerignore` excludes `.env` so it can never land in an image layer.
