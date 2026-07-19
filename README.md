# naary-orchestrator

A durable, platform-agnostic orchestrator for AI-agent + webhook workflows. Users author
workflows on a visual canvas (or in plain English via the AI builder) → a JSON **graph
(DSL)** → a single generic **Temporal workflow interprets that graph** at runtime. The
differentiator over n8n / Flowise / Sim is **durable, long-running, human-in-the-loop
execution** — flows that pause for days and survive crashes.

## What's in the product today

**Authoring**
- **Visual canvas** (react-flow): node palette, per-node config, conditional edges,
  expressions (`{{ node.path }}`, `$vars`, `$secrets`), per-node pinning + single-node
  test runs with upstream autofill, workflow diffing, and **tags** for organization.
- **AI workflow builder**: describe a flow in plain English → a validated draft graph
  (BYOK model key or a Claude Code subscription credential; streamed over SSE so long
  generations survive proxies). A conversational, iterative builder is designed
  (`docs/design/AI-BUILDER-CONVERSATION.md`).
- **Simple mode**: a non-developer product variant over the same engine
  (`docs/design/PRODUCT-VARIANTS.md`).
- **Typed DSL** (`@naary/dsl`): one zod schema per node type; a save-gate validates
  every graph; a drift guard keeps the registry, interpreter, and UI in lockstep.

**Node catalog (highlights)**
Agent (BYOK LLM via the AI SDK), Claude Code (headless `claude -p` in an
egress-allowlisted sandbox — `apps/sandbox-runner`), MCP tools, HTTP / GraphQL (with
OpenAPI + introspection import), SQL query/exec (Postgres + MySQL), vector RAG
(pgvector upsert/query), declarative **integration nodes** (GitHub, Jira, Slack, … —
a catalog entry, not a node type), transforms (csv/encode/hash/html/markdown/…),
control flow (if/switch/merge/forEach with the items model), human approval,
webhook/schedule/poll/form/**chat** triggers, sub-workflows, error-handler workflows.

**Execution**
- Durable pause/resume via Temporal Signals + `condition()`; runs survive worker and
  server restarts (see the durability runbook below).
- Graph **versioning + content-hashing**: runs pin an immutable snapshot; edits can't
  corrupt in-flight executions. Per-workflow **activation** gates automatic triggers.
- Budgets: per-workspace monthly + per-run caps with atomic reservations, circuit
  breaker on runaway graphs, **company-wide outer cap** — all fail-safe.
- Notifications: N Slack/Teams webhooks per environment with approve/reject buttons.
- Queue mode (in progress, `docs/design/QUEUE-MODE.md`): worker fleet identity +
  per-replica capacity/drain tuning.

**Multi-tenancy & governance**
- **Workspaces** (the `tenantId` isolation boundary) with real memberships,
  **invitations** (verified-email accept-on-login), and enforced owner/admin/member
  roles.
- **Environments** per workspace (sandbox/UAT/prod): env-scoped workflows, credentials,
  connections, variables, secrets, notification channels, pins, error handlers, and
  **schedules** — with copy-on-promote between envs and per-env usage tagging.
- **Companies**: a cross-workspace admin/billing layer above workspaces —
  owner-authorized attach, usage rollups, read-only cross-workspace visibility,
  workspace rename/archive, company members, a company-wide spend cap, and
  company-wide permission groups (`docs/design/COMPANIES.md`).
- **RBAC** (`docs/design/RBAC-GROUPS.md`): per-workspace permission groups with a
  six-verb, environment-scoped grant matrix (view/run/edit/delete/share/create) over
  all or selected workflows **and/or tags**; API tokens are RBAC subjects too;
  restricted subjects get filtered runs lists and cost insights. Zero grants = full
  access (the first grant is the explicit opt-in).
- **BYOK secrets**: per-tenant envelope encryption (tenant DEKs wrapped by a master
  key, AES-256-GCM, rotation CLI); provider keys are validated on save and only ever
  decrypted inside activities.

**Observability & insight**
- Usage ledger (tokens + cost only — never prompt text) with **insights** rollups by
  day/environment/workflow/model, dashboard + filters, and budget views.
- Sentry tracing/logs/metrics/replay/profiles across api/worker/web (off unless
  `SENTRY_DSN` is set), an audit activity feed, and per-run execution logs.

**Programmatic access**
- **Public API** (`/api/v1`): runs (start/list/get/watch/cancel/rerun/approve),
  workflows (CRUD/export/import/promote), config (variables, write-only secrets,
  usage, insights) — additive-only contract (`docs/design/PUBLIC-API-AND-CLI.md`).
- **`naary` CLI** (`packages/cli`, zero runtime deps): auth, runs (incl.
  `watch --exit-code`), workflows, approvals, config, usage.
- **MCP server**: drive the orchestrator from Claude/other MCP clients with an `nry_`
  token (`docs/design/MCP-SERVER.md`).

Design docs for every subsystem live in `docs/design/` — they are the source of truth
for semantics and slice history.

## Architecture (the part that must never regress)

One generic Temporal workflow (`runGraph`) walks graph *data* — the interpreter, not
codegen. The Tier-1 invariants (see `CLAUDE.md`):

- **Workflow code is deterministic.** No I/O, clocks, randomness, or DB in
  `workflows.ts`/graph traversal — everything side-effectful is an Activity.
- **Secrets never enter Temporal.** Only `tenantId`/`environmentId` flow through
  workflow args/history; keys are fetched + decrypted *inside* activities and never
  returned, logged, or put in spans.
- **Billing fails safe.** Missing token usage records a non-zero fallback estimate —
  never a silently-free call. `ai` is pinned to an exact version for this reason.
- **State lives in Temporal, not the worker.** Workers are stateless and disposable.
- Provider `401`/`429` → **non-retryable** failures (don't burn retries on a key the
  user must fix); payloads stay under Temporal's ~2MB cap via claim-check offloading
  to object storage.

## Layout (pnpm workspace)

| Package | Role |
|---|---|
| `packages/dsl` | Typed graph DSL: node registry (zod), validation, expressions, items model, integration catalog. |
| `packages/contracts` | Execution protocol: task queue, signals, queries, state types. Client-safe. |
| `packages/db` | Prisma schema + client (definitions, tenancy, ledger — Temporal owns execution state). |
| `packages/secrets` | Envelope encryption (per-tenant DEKs), credential store, rotation CLI. |
| `packages/usage` | Usage ledger, pricing, budgets/reservations, insights aggregation. |
| `packages/connections` | MCP/OAuth/GitHub-App connections, egress guard (`safeFetch`), integration auth. |
| `packages/sql` / `packages/storage` | SQL node adapters (Postgres/MySQL) / claim-check object store (S3). |
| `packages/notifications` | Shared Slack/Teams payload formatters. |
| `packages/logging` / `metrics` / `observability` | pino + scrubbing, Prometheus, Sentry wiring. |
| `packages/flags` | OpenFeature/Flagsmith feature flags. |
| `packages/temporal-config` | Shared Temporal connection config. |
| `packages/cli` | The `naary` CLI (zero runtime deps). |
| `apps/worker` | Temporal worker: the `runGraph` interpreter + all activities. |
| `apps/api` | NestJS control plane: auth, tenancy, graphs, runs, v1 API, MCP server. |
| `apps/web` | React + Vite SPA: canvas, runs, insights, settings, admin (nginx-served in Docker). |
| `apps/sandbox-runner` | Docker-in-Docker runner for the Claude Code node's egress-isolated sandbox. |

## Run it locally

### Option A — the whole stack in Docker (one command)

```bash
cp .env.example .env          # fill POSTGRES_PASSWORD, ENCRYPTION_KEY (openssl rand -hex 32),
                              # and the matching DATABASE_URL
docker compose up -d --build
```

| Service | URL |
|---|---|
| Web app | http://localhost:8081 |
| API | http://localhost:3000 (`/healthz` is public) |
| Temporal UI | http://localhost:8233 |

The `migrate` service applies Prisma migrations before api/worker start. Tear down with
`docker compose down` (add `-v` to wipe data). Seed graphs + mint an API token:

```bash
docker compose exec api pnpm --filter @naary/api exec node -r @swc/register src/graphs/seed-graphs.ts t-demo
docker compose exec api pnpm --filter @naary/api exec node -r @swc/register src/auth/mint-token.ts t-demo
# -> nry_…   then: curl … -H "Authorization: Bearer nry_…"
```

### Option B — host processes (faster inner loop)

```bash
docker compose up -d postgres
temporal server start-dev --db-filename temporal.db   # UI at http://localhost:8233
pnpm build && pnpm run worker                         # terminal 2
pnpm run start                                        # terminal 3 — API on :3000
```

### First run

Create a workflow on the canvas (`/app/canvas`) or via the AI builder, **Save & run**,
watch it pause at the approval node, approve from the run view (or the Slack/Teams
button, or `naary approvals approve <id>`), and it completes. An `agent` node needs a
BYOK key: save one under Settings → Integrations (or
`POST /tenants/<id>/credentials`).

## Authentication

Every non-public route requires `Authorization: Bearer <token>`; two credential kinds
resolve to a workspace:

- **API tokens** (`nry_…`) — services/CLI/CI/MCP. Hashed at rest; optionally bound to
  one environment; RBAC subjects once a workspace adopts permission groups.
- **Firebase ID tokens** — human users (Google or email/password in the SPA). Enabled
  only when a Firebase service account is configured
  (`FIREBASE_SERVICE_ACCOUNT_JSON` / `GOOGLE_APPLICATION_CREDENTIALS`); workspace
  membership + invitations govern access, `X-Workspace-Id` / `X-Environment-Id`
  headers select the active scope.

## Tests

```bash
pnpm test              # builds, then vitest across the workspace (incl. Temporal e2e specs)
pnpm test:integration  # whole graphs against REAL services (testcontainers Postgres, pgvector,
                       #   in-process HTTP/GraphQL) — needs Docker; excluded from `pnpm test`
pnpm typecheck         # tsc -b + per-app --noEmit fan-out
```

The authoritative correctness gate is `apps/worker/test/interpreter.e2e.spec.ts`
(`TestWorkflowEnvironment`): real workflows through the real interpreter — pause,
signal, resume, branch, per-node execution matrix. CI runs `verify` (build + tests),
`e2e` (the Docker stack, per-run namespaced), and `integration` on every PR, plus a
large-files check.

## Durability runbook — surviving a worker crash mid-pause

Execution state lives in the Temporal server, not the worker:

1. Start a run; wait for `status:"awaiting_approval"`.
2. **Kill the worker.** The run stays alive in the server
   (`temporal workflow list` shows it Running; the API's state Query needs a live
   worker, so `GET /executions/:id` errors *without state being lost*).
3. **Restart the worker** → the query answers again; approve → `completed`.

## Releases & deploys

`Actions → Release → Run workflow` (patch/minor/major) bumps every workspace
`package.json`, tags `vX.Y.Z`, publishes a GitHub Release, and chains the production
deploy (Terraform'd Hetzner VPS + Neon Postgres, rolling via docker-rollout —
migrations must stay expand/contract).

## Guardrail hooks

`.claude/hooks/` enforces the `CLAUDE.md` Tier-1 rules at edit time (determinism, no
secrets in workflow code, no destructive bash). Heuristic dev-time guards; the
authoritative determinism check is the Temporal replay test suite.
