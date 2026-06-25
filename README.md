# naary-orchestrator

A durable, platform-agnostic orchestrator for AI-agent + webhook workflows. Users
author workflows on a canvas → a JSON **graph (DSL)** → a single generic **Temporal
workflow interprets that graph** at runtime. The differentiator over n8n / Flowise /
Sim is **durable, long-running, human-in-the-loop execution** — flows that pause for
days and survive crashes.

This repo currently implements **Vertical Slice #1: the durable interpreter spine**
(see `PLAN.md`). It proves the riskiest capability: a generic workflow that walks a
graph, pauses durably for human approval, and resumes — surviving a worker crash.

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
