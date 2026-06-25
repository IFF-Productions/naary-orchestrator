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
- **Eventual consistency / no reservation:** pre-flight reads month-to-date spend with
  no locking, so **concurrent runs for one tenant can briefly overshoot** the monthly
  cap. Acceptable for this slice; atomic reservation is a fast-follow (PLAN-SLICE-3 §8).
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
- **MCP tool results** can exceed Temporal's ~2MB payload cap; large results should go to
  object storage with a reference passed instead (not handled this slice).

## Layout (pnpm workspace)

| Package | Role |
|---|---|
| `packages/dsl` (`@naary/dsl`) | Platform-agnostic graph DSL: types, sample graph, deterministic `walk`. No Temporal/I/O. |
| `packages/contracts` (`@naary/contracts`) | Execution protocol: `TASK_QUEUE`, `approvalSignal`, `stateQuery`, state types. Client-safe. |
| `apps/worker` (`@naary/worker`) | Temporal worker: the `runGraph` interpreter workflow + activities. All side effects live here. |
| `apps/api` (`@naary/api`) | NestJS control plane: start / approve / get-state over the Temporal client. |
| `apps/web` (`@naary/web`) | Placeholder for the slice-#5 React Flow canvas (not built yet). |

## Prerequisites

- Node 20+, [pnpm](https://pnpm.io), and the [Temporal CLI](https://docs.temporal.io/cli)
  (`brew install temporal`).
- `pnpm install`

## Run it locally

Three processes, in three terminals:

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

## Tests

```bash
pnpm test        # builds, then runs vitest (incl. the e2e pause→signal→resume DoD)
pnpm typecheck   # tsc -b across the workspace + per-app --noEmit fan-out
```

The authoritative correctness gate is `apps/worker/test/interpreter.e2e.spec.ts`
(`@temporalio/testing` / `TestWorkflowEnvironment`): it starts `runGraph`, polls until
`awaiting_approval`, signals, and asserts `completed` — plus the reject path.

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
