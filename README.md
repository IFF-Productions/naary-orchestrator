# naary-orchestrator

A durable, platform-agnostic orchestrator for AI-agent + webhook workflows. Users
author workflows on a canvas → a JSON **graph (DSL)** → a single generic **Temporal
workflow interprets that graph** at runtime. The differentiator over n8n / Flowise /
Sim is **durable, long-running, human-in-the-loop execution** — flows that pause for
days and survive crashes.

This repo implements **Slice #1: the durable interpreter spine** (`PLAN.md`) and
**Slice #2: real agent + BYOK secrets + spend tracking** (`PLAN-SLICE-2.md`). Slice #1
proves the riskiest capability — a generic workflow that walks a graph, pauses durably
for human approval, and resumes, surviving a worker crash. Slice #2 makes the agent
node real: it calls an LLM with each tenant's own provider key and records token spend.

## BYOK secrets + spend (Slice #2)

**Bring-your-own-key:** each tenant saves their own provider key; the orchestrator
stores it encrypted and uses it on their behalf.

```bash
# 1. A tenant saves a provider key (validated, encrypted at rest, never echoed back)
curl -XPOST localhost:3000/tenants/<tenantId>/credentials \
  -H 'content-type: application/json' \
  -d '{"provider":"anthropic","apiKey":"sk-ant-..."}'
# -> {"id":"...","provider":"anthropic","isValid":true}   (isValid:false if the key fails validation)

# 2. Start an execution for that tenant (tenantId is NOT a secret)
curl -XPOST localhost:3000/executions -H 'content-type: application/json' -d '{"tenantId":"<tenantId>"}'

# 3. The agent node calls the LLM with the tenant's key, then it pauses for approval; approve as in slice #1.

# 4. See the spend
curl 'localhost:3000/tenants/<tenantId>/usage'
# -> {"totalCostUsd":0.0175,"totalTokens":1500,"byModel":[...],"events":[...]}
```

### Security model — secrets never enter Temporal

- **Only `tenantId` flows through the workflow** (args/history). It is not a secret.
- The provider **key is fetched INSIDE the agent activity** by `tenantId`, decrypted in
  memory, used for the model call, and **never returned, logged, or put in a span**.
  Temporal persists every workflow input to replayable history — a key as a workflow
  arg would be written there, so it never is.
- Keys are encrypted with **AES-256-GCM** (`@naary/secrets`) behind a `KeyEncryptor`
  interface (swappable for AWS KMS later). `ENCRYPTION_KEY` (32-byte hex,
  `openssl rand -hex 32`) is required at boot and never logged.
- `@naary/db` / `@naary/secrets` / `@naary/usage` are imported by activities + the API
  only — **never by `workflows.ts`** (Prisma's driver would break deterministic replay
  and the workflow bundler). Enforced by the type-only activities import; verified by
  inspecting the workflow bundle (no `@prisma`/`@naary/db` modules).

### Billing fail-safe

Every successful model call writes a `UsageEvent` (tokens + computed cost; **no prompt
or completion text**). Cost uses `result.totalUsage` (sums across tool steps). The
`ai@6` usage-undefined bug would silently bill **zero** — so when usage is missing we
record a **non-zero fallback estimate** instead (CLAUDE.md rule 6). `ai` is pinned to an
**exact** version for this reason.

`401`/`403`/`429` from a tenant key map to **non-retryable** Temporal failures (don't
burn retries on a key the user must fix); genuine transient errors retry.

> ⚠️ **Known gap (deferred):** `UsageEvent` has no idempotency key on
> `(executionId, nodeId)`. A transient failure *after* the model call (e.g. the DB
> write fails) makes Temporal retry the whole activity — re-calling the LLM and writing
> a second `UsageEvent`. The fix is idempotency keyed on execution+node; it's out of
> this slice's scope (budget enforcement / fast-follow, PLAN-SLICE-2 §9).

> **Deferred live verification:** the valid-key save (Task 2) and the full real-model
> execution (Task 6) need a real provider key and are deferred. Everything is built and
> tested with a mocked provider; the invalid-key path, encryption-at-rest, and the usage
> endpoint are verified live. To run the real path: save a valid key via the credential
> endpoint, then start an execution for that tenant.

## Budget enforcement + circuit breaking (Slice #3)

Slice #2 *records* spend; slice #3 *enforces* it via three mechanisms:

```bash
# Set a tenant's budget
curl -XPUT localhost:3000/tenants/<id>/budget -H 'content-type: application/json' \
  -d '{"monthlyCapUsd":50,"perExecutionCapUsd":0.25,"maxStepsPerRun":50,"onBudgetExceeded":"reject"}'

# View budget + live month-to-date spend + remaining
curl localhost:3000/tenants/<id>/budget
# -> {"monthlyCapUsd":50,"mtdSpendUsd":3.25,"remainingUsd":46.75,"perExecutionCapUsd":0.25,...}
```

1. **Pre-flight cost check** (in the agent activity — it reads the ledger): before the
   LLM call, if `monthToDateSpend + estimate > monthlyCap`, apply the policy —
   `reject` (non-retryable `BUDGET` failure, no charge) or `downgrade` (swap to the
   configured `fallbackModel` and record which model actually ran).
2. **Per-execution cost cap** (in the **workflow**, deterministic): `runGraph`
   accumulates the `costUsd` each agent activity **returns** and halts at
   `status: "budget_exceeded"` when it reaches `perExecutionCapUsd`.
3. **Circuit breaker** (workflow): a per-node `stepCount` halts a runaway graph at
   `status: "circuit_open"` past `maxStepsPerRun`.

Both workflow stops are **clean terminal statuses returned normally**, not thrown — the
execution history stays tidy, and `GET /executions/:id` reflects the stop reason.

### Determinism boundary

Cumulative enforcement lives in the workflow and is driven **only** by activity-returned
costs + a node counter — **never a DB read in workflow code** (CLAUDE.md rule 2). The
caps themselves are **snapshotted at start**: `POST /executions` reads the tenant's
budget and passes `perExecutionCapUsd` / `maxStepsPerRun` as workflow args (non-secret
config, recorded in history → identical on replay).

### Honest limitations

- **Two enforcement points read the budget at different times, by design:** the
  per-execution cap is snapshotted at start (workflow args); the monthly cap is read
  **live** inside the activity (pre-flight). A mid-run budget change affects the next
  call's pre-flight but not this run's per-execution cap.
- **Monthly cap uses atomic reservations** (Arch§4.3): before the LLM call a run
  *reserves* its estimated cost in a transaction that counts committed spend + other
  in-flight reservations, and releases it after recording the actual usage. Concurrent
  runs for one tenant therefore see each other's reservations, so overshoot is bounded
  to the small read-commit race window rather than unbounded. Dangling reservations
  (a crash mid-call) stop counting after a 5-minute TTL.
- **Pre-flight is an estimate** (char/4 input + assumed max output); the recorded
  `UsageEvent` is the **actual** cost.

## External integrations (Slice #4)

Workflows can be **triggered by** external platforms and **act on** them — one
mechanism per direction so a third platform is config, not new code.

### Inbound — webhook triggers (plain signed HTTP, not MCP)

```bash
# Register a trigger → returns a stable ingress path + signing secret (once)
curl -XPOST localhost:3000/tenants/<id>/webhooks \
  -H 'content-type: application/json' -d '{"workflowId":"wf-default","provider":"github"}'
# -> {"endpointId":"...","ingressPath":"/hooks/<id>","signingSecret":"..."}
```

`POST /hooks/:endpointId` verifies the **GitHub HMAC-SHA256 signature over the raw
body** (`rawBody:true`, length-guarded timing-safe compare; 401 on mismatch),
**dedupes** on the delivery id (`@@unique` + P2002 → 2xx ignored), then starts the
workflow with the event as the trigger node's output. Atlassian inbound signing is
not GitHub-style and **fails closed** until verified against current docs.

### Outbound — MCP Tool nodes

A `Connection` (`POST /tenants/:id/connections`) points at a remote MCP server
(`serverUrl`, e.g. GitHub/Atlassian's hosted `/mcp`). An `mcpTool` node calls a tool
via the `callMcpTool` activity (Streamable HTTP). **Auth is split by where it happens:**

- **PAT / api_token** — stored encrypted (slice-2 store), used as a `Bearer` header.
- **OAuth 2.1** — interactive consent runs once in the web app (`/oauth/start` → browser
  → `/oauth/callback`: Dynamic Client Registration + PKCE + `resource` + `offline_access`),
  capturing an encrypted **refresh token**. The activity then refreshes
  **non-interactively** at run time (cached access token + per-connection lock; rotated
  refresh tokens are persisted before use). `invalid_grant` flips the connection to
  `needs_reauth` and fails the activity **non-retryably**.

Tokens are fetched/refreshed **inside the activity** by `connectionId` — only
`tenantId`/`connectionId`/node config flow through workflow history; the MCP SDK never
enters the deterministic workflow bundle (`import type` boundary, verified).

The reference flow (`githubReviewGraph`): GitHub PR webhook → agent reviews →
`mcpTool` comments back → human approval before any merge.

### Honest limitations

- **OAuth refresh lock is in-process only.** The access-token cache + per-connection
  refresh lock serialize within ONE worker process; multiple workers can still race a
  refresh (and with rotation, invalidate each other). A distributed lock / Temporal
  serialization point is the real fix.
- **Atlassian inbound webhooks** are not implemented (scheme differs from GitHub) — GitHub
  is the verified reference; verify Atlassian's scheme against current docs before enabling.
- **Browser consent (B3) is deferred-live** — the endpoints + token refresh are built and
  tested (mock token server); the actual consent click needs a real OAuth app.
- **Large MCP tool results are claim-checked** (Arch§4.6): a result over ~1MB is offloaded
  to object storage (`@naary/storage`) and a small reference flows through Temporal instead,
  staying under the ~2MB payload cap; the activity resolves references transparently when an
  upstream output feeds a later tool. The `ObjectStore` interface is provider-agnostic —
  **AWS S3** today (`STORAGE_PROVIDER=s3`), with a GCS implementation as the drop-in swap;
  unset = in-memory (dev/tests).

## Durable graph versioning (Slice #5)

Graphs are no longer hardcoded — they live in Postgres (`GraphDefinition`), versioned per
`(tenantId, workflowKey)` and **content-hashed** (sha256 of a canonical, key-sorted
serialization). At execution start the control plane loads the latest version and passes
the **immutable graph snapshot** to the workflow as an arg, with the content hash + version
recorded in a Temporal **memo**. Editing a flow creates a *new* version and cannot change
an in-flight run (which carries its own snapshot). Re-saving an unchanged graph is a no-op
(same hash → same version). Seed a tenant's graphs with
`pnpm --filter @naary/api exec node -r @swc/register src/graphs/seed-graphs.ts <tenantId>`.

- **Pass-by-value, not by-reference** — the full graph rides in the workflow arg (kept
  small; the ~2MB Temporal payload cap is the documented bound, not solved here).
- **Edge order is identity** — object-key order is canonicalized away, but node/edge array
  order is semantic (`walk` takes the first declared edge), so reordering edges is a real
  version change.

## Layout (pnpm workspace)

| Package | Role |
|---|---|
| `packages/dsl` (`@naary/dsl`) | Platform-agnostic graph DSL: types, sample graph, deterministic `walk`. No Temporal/I/O. |
| `packages/contracts` (`@naary/contracts`) | Execution protocol: `TASK_QUEUE`, `approvalSignal`, `stateQuery`, state types. Client-safe. |
| `apps/worker` (`@naary/worker`) | Temporal worker: the `runGraph` interpreter workflow + activities. All side effects live here. |
| `apps/api` (`@naary/api`) | NestJS control plane: start / approve / get-state over the Temporal client. |
| `apps/web` (`@naary/web`) | React + Vite SPA (runs UI, run detail, canvas). Served by nginx in the Docker stack. |

## Prerequisites

- Node 20+, [pnpm](https://pnpm.io), and the [Temporal CLI](https://docs.temporal.io/cli)
  (`brew install temporal`).
- `pnpm install`

## Run it locally

### Option A — the whole stack in Docker (one command)

Brings up Postgres, Temporal, DB migrations, the API, the worker, and the web app
together. Requires Docker; no host Node/Temporal needed.

```bash
cp .env.example .env          # fill POSTGRES_PASSWORD, ENCRYPTION_KEY (openssl rand -hex 32),
                              # and the matching DATABASE_URL
docker compose up -d --build  # build images + start everything
```

| Service | URL |
|---|---|
| Web app | http://localhost:8081 |
| API | http://localhost:3000 (`/healthz` is public) |
| Temporal UI | http://localhost:8233 |

The `migrate` service applies Prisma migrations before the api/worker start; the
api/worker wait on Temporal + Postgres healthchecks, so a cold `up` is ordered.
Tear down with `docker compose down` (add `-v` to wipe Postgres + Temporal data).

Seed a tenant's graphs + mint an API token (run inside the api container):

```bash
docker compose exec api pnpm --filter @naary/api exec node -r @swc/register src/graphs/seed-graphs.ts t-demo
docker compose exec api pnpm --filter @naary/api exec node -r @swc/register src/auth/mint-token.ts t-demo
# -> nry_…   then drive the API flow below with: -H "Authorization: Bearer nry_…"
```

> An `agent` node calls an LLM with the tenant's **own** key (BYOK) — seed one via
> `POST /tenants/t-demo/credentials` (see below) for a run to get past the agent
> node; without it the agent activity fails non-retryably (by design).

> Inside the stack, browser login via Firebase Auth is **on only if a Firebase
> service account is configured** (`FIREBASE_SERVICE_ACCOUNT_JSON` /
> `GOOGLE_APPLICATION_CREDENTIALS`); otherwise the stack is API-token-only and the
> `nry_` token below is the only way in. See the Authentication section.

### Option B — host processes (faster inner loop for backend dev)

Three processes, in three terminals (Postgres still comes from
`docker compose up -d postgres`):

```bash
# 1) Temporal dev server (persistent DB so server restarts survive too)
temporal server start-dev --db-filename temporal.db    # UI at http://localhost:8233

# 2) the worker (bundles the workflow, polls the 'orchestrator' task queue)
pnpm build        # build @naary/dsl + @naary/contracts so the worker can resolve them
pnpm run worker

# 3) the NestJS control plane (http://localhost:3000)
pnpm run start
```

### The API flow

```bash
# start an execution
curl -XPOST localhost:3000/executions
# -> {"workflowId":"exec-…"}

# it runs the stub agent, then pauses awaiting approval
curl localhost:3000/executions/<id>
# -> {"status":"awaiting_approval","currentNodeId":"approval","ctx":{…}}

# approve it (returns HTTP 202)
curl -XPOST localhost:3000/executions/<id>/approve \
  -H 'content-type: application/json' -d '{"approved":true}'

# now it completes
curl localhost:3000/executions/<id>
# -> {"status":"completed","currentNodeId":"end","ctx":{…}}
```

Send `{"approved":false}` instead and the run resolves to `status:"rejected"`.

### The canvas (visual authoring → run)

The web app's **Workflow canvas** (`/app/canvas`) is a drag-and-drop editor
(react-flow): add nodes from the palette, connect handles, edit per-node config,
and set **edge conditions** (select an edge → path / op / value) to branch on prior
node output — compiled to the DSL's `EdgeCondition` and honored by the interpreter.
A live status mirrors the server's `validateGraph`. Workflows are **named**: pick a
name (→ a stable `workflowKey`) or open an existing one from the selector or the
**Workflows** screen (`GET /graphs` lists them; `GET /graphs/:key` opens one, auto-
laid-out). **Save & run** compiles the canvas to a `GraphDef`, `POST /graphs` saves
it (versioned, content-hashed) under its key, then `POST /executions {workflowKey}`
starts it and navigates to the run view. It seeds a credential-free `start → approval → end`
graph, so a first Run completes (pauses at approval → Approve → done) without a
BYOK LLM key. The compile logic is pure + unit-tested (`compile-graph.ts`).

## Authentication — API tokens + Firebase Auth (dual auth)

Every non-`@Public()` route requires `Authorization: Bearer <token>`. The global
guard accepts **two** credential kinds and resolves both to a tenant:

- **API tokens** (`nry_…`) — for services / CLI / CI. Hashed at rest; verified by
  `ApiTokenService`. Always on.
- **Firebase ID tokens** — for human users. The API verifies them with the Firebase
  Admin SDK, and the `tenantId` comes from a Firebase **`tenant` custom claim** on the
  user, never from the request path/body. **Off unless a Firebase service account is
  configured** (`FIREBASE_SERVICE_ACCOUNT_JSON` inline, or `GOOGLE_APPLICATION_CREDENTIALS`
  pointing at a file), so API-token-only deployments are unchanged.

Tenant-scoped routes (`/tenants/:id/...`) additionally 403 if the path tenant differs
from the authenticated tenant — same enforcement for both credential kinds.

### Local setup

Firebase verification needs a **service account** for the Firebase project
(`naary-7b78f`). Provide it to the API one of two ways and set the project id:

```bash
# in .env (API side):
#   FIREBASE_PROJECT_ID="naary-7b78f"
#   FIREBASE_SERVICE_ACCOUNT_JSON='{"type":"service_account",...}'   # inline JSON, OR
#   GOOGLE_APPLICATION_CREDENTIALS="/path/to/service-account.json"   # file path
#   FIREBASE_TENANT_CLAIM="tenant"                                   # (default)
```

Assign a user's tenant by setting the `tenant` custom claim on their Firebase UID:

```bash
pnpm --filter @naary/api exec node -r @swc/register src/auth/set-tenant-claim.ts <firebaseUid> <tenantId>
```

> ⚠️ **No service account ⇒ no human browser login.** With Firebase auth off, the
> local Docker stack has **no browser sign-in** — only `nry_` API tokens work. Mint
> one for CLI/CI use with `mint-token.ts` (see the Docker quick-start above):
>
> ```bash
> docker compose exec api pnpm --filter @naary/api exec node -r @swc/register src/auth/mint-token.ts t-demo
> # -> nry_…   then: curl localhost:3000/executions -H "Authorization: Bearer nry_…"
> ```

### Web login (SPA)

The web app's sign-in screen offers Firebase Auth: a **"Continue with Google"** button
plus **email/password** fields (both via the Firebase JS SDK). On sign-in the SPA
obtains a Firebase **ID token**, attaches it to every API call, and refreshes it before
expiry. The pasted `nry_` token remains a secondary ("advanced") path for devs/CI.

The SPA's public Firebase web config is **baked in at web build time** and overridable
via `VITE_FIREBASE_API_KEY` / `VITE_FIREBASE_AUTH_DOMAIN` / `VITE_FIREBASE_PROJECT_ID` /
`VITE_FIREBASE_STORAGE_BUCKET` / `VITE_FIREBASE_MESSAGING_SENDER_ID` /
`VITE_FIREBASE_APP_ID` (project `naary-7b78f`). These are public client config, not
secrets; the service account is API-side only.

## Tests

```bash
pnpm test              # builds, then runs vitest (incl. the e2e pause→signal→resume DoD)
pnpm test:integration  # node-level integration tests against REAL services (needs Docker)
pnpm typecheck         # tsc -b across the workspace + per-app --noEmit fan-out
```

The authoritative correctness gate is `apps/worker/test/interpreter.e2e.spec.ts`
(`@temporalio/testing` / `TestWorkflowEnvironment`): it starts `runGraph`, polls until
`awaiting_approval`, signals, and asserts `completed` — plus the reject path.

### Integration tests (`*.integration.spec.ts`) — real services, no mocks

`pnpm test:integration` runs whole graphs through the **real interpreter + real activities**
against **real backing services**, proving the data-source nodes actually work:

- **sqlQuery / sqlExec** → a throwaway **Postgres** spun up per-run by
  [`@testcontainers/postgresql`](https://node.testcontainers.org/) (needs a reachable Docker
  daemon). The graph writes and reads real rows through the real `@naary/sql` adapter.
- **httpRequest / graphQL** → a real in-process `node:http` server (REST + a
  GraphQL-over-HTTP endpoint); a genuine network round-trip through the real activity.

Only the SSRF host-guard seams are relaxed so the activities can reach the local test service
(the guards themselves are unit-tested in `sql.activity.spec` / `http.activity.spec`); every other
layer runs for real. These tests are **excluded from `pnpm test`** (so it stays Docker-free) and
run in CI on the self-hosted runner via `.github/workflows/integration.yml` — separate from and
non-blocking to the fast `verify` gate. To add coverage for a new service-backed node, drop a
`*.integration.spec.ts` beside the others.

## Durability runbook — surviving a worker crash mid-pause

This is the slice's whole point: **execution state lives in the Temporal server, not
the worker** (CLAUDE.md Tier-1 rule 7). Kill the worker while a run is paused, restart
it, and the run resumes.

1. Start the dev server, worker, and API (above).
2. `POST /executions`; poll `GET /executions/<id>` until `status:"awaiting_approval"`.
3. **Kill the worker** (Ctrl-C / `pkill -f src/worker.ts`).
4. Confirm the run is still alive in the **server**, independent of the worker:
   ```bash
   temporal workflow list | grep <id>
   # -> Running    exec-…    runGraph    …
   ```
   > ⚠️ Note: `GET /executions/<id>` returns **500 while the worker is down** — not
   > because state was lost, but because it uses a Temporal **Query**, and a Query
   > needs a live worker to execute its handler. The workflow itself is durably
   > paused in the server (as `temporal workflow list` shows). This is a refinement
   > of PLAN §6 Task 7 step 4, which assumed `GET` would still answer with the
   > worker down; with Temporal Queries it cannot — `workflow list/describe` is the
   > correct worker-independent state check.
5. **Restart the worker** (`pnpm run worker`).
6. `GET /executions/<id>` answers `awaiting_approval` again; `POST …/approve
   {"approved":true}` → 202; `GET` → `completed`.

Verified run (worker PID killed between steps 2 and 5):

```
A. paused:                {"status":"awaiting_approval","currentNodeId":"approval",…}
B. kill worker:           worker process alive? -> NO
C. server state (CLI):    Running   exec-…   runGraph     # survived, worker-independent
D. after worker restart:  {"status":"awaiting_approval",…}
E. approve:               HTTP 202
F. completed:             {"status":"completed","currentNodeId":"end",…}
```

> `--db-filename temporal.db` additionally persists the **server's** own state, so a
> *server* restart (not just a worker restart) also survives. The runbook above only
> kills the worker; that survives because of where state lives, independent of the db file.

## Guardrail hooks

`.claude/hooks/` enforces the `CLAUDE.md` rules at edit time (determinism, no secrets,
no destructive bash) via `.claude/settings.json`. The determinism hook blocks `Date.now`,
`Math.random`, I/O, etc. in the workflow/interpreter files. These are heuristic dev-time
guards; the authoritative determinism check is the Temporal replay test above.
