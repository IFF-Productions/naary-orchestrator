# Architecture Audit — naary-orchestrator

**Date:** 2026-07-04
**Branch:** `docs/webhooks` (HEAD `9296ed8`)
**Method:** Read `apps/worker/src/temporal/{workflows,activities}.ts` and its `@naary/dsl` imports, the API control-plane services, and the package layout. Audited against the CLAUDE.md **TIER 1 hard rules**. Cross-referenced `docs/ARCHITECTURE-REVIEW.md` and `docs/PRODUCTION-READINESS.md`.

## TL;DR

The system holds its architectural line well. The **interpreter-not-codegen** spine is intact, the **workflow/activity determinism split is clean**, and **secrets never cross the workflow boundary** — the three rules most expensive to get wrong. Durability features the prior review wanted (graph snapshot + content-hash at start, `continueAsNew` with carried state, sub-workflow depth caps, claim-check offload for the 2MB payload cap) are all **implemented**. The real debt is **extensibility**: adding a node type touches 4–5 files, which will not scale to the 50-node n8n-catalog ambition without a registry.

| # | Severity | Finding |
|---|----------|---------|
| A-1 | Design debt | Node-type definitions are duplicated across ~5 sites → drift risk as node count grows |
| A-2 | Future risk | Merge fan-in determinism rests on replay-stable concurrent arrival order |
| A-3 | Future risk | `forEach` launches up to 100 concurrent children — worker load spike, cap-overshoot |
| A-4 | Note | Data-model indexes on hot paths not verified this pass |
| A-5 | Positive | TIER 1 compliance is strong — documented below as evidence |

---

## TIER 1 compliance — audited, all holding

1. **Interpreter, not codegen.** ✅ One generic `runGraph` walks graph *data* (`workflows.ts:174`). No per-graph workflow generation anywhere.
2. **Workflow code is deterministic.** ✅ `workflows.ts` imports activities **type-only** (`import type * as activities`, `:59`) so no I/O code enters the sandbox. No `Date.now()`/`Math.random()`/`uuid()` in the workflow — time comes from `wf.sleep`/Temporal timers (`:635`, `:693`) and the `dateTime` clock read is delegated to an activity (`:398`). `randomUUID` appears only in `executions.service.ts` (API side, correct).
3. **All side effects in activities.** ✅ Every LLM/MCP/HTTP/SQL/SMTP/crypto/DB call is a `proxyActivities` handle; the workflow only does pure graph work (path reads, edge conditions, accumulation).
4. **Secrets never enter Temporal.** ✅ Only `tenantId` rides in `RunGraphCtx` (`:137`). Keys are fetched by `tenantId` **inside** each activity and never returned; activity results carry only non-secret outputs. Errors are sanitized so DSN/token/host can't reach history (`toSanitizedRetryable`; SQL/HTTP catch blocks). Response `Set-Cookie` is stripped before headers land in `ctx` (`activities.ts:1338`).
5. **Human approval = Signal + `condition()`.** ✅ `humanApproval` sets status, `syncStatus()`, then `await wf.condition(() => approval !== undefined, timeout)` (`:680-702`) — a durable wait, no polling, with an optional durable-timer auto-reject.
6. **Billing fails safe.** ✅ (spot-checked) Cost is a commutative sum of activity-returned `costUsd`, accumulated deterministically; the per-execution cap is a snapshot passed at start, enforced in-workflow with no DB read. *The fallback-on-missing-usage detail lives in `runAgent` — see QA Q-5 for a recommended focused re-check.*
7. **State lives in Temporal.** ✅ Workers are stateless; run state is Temporal history + the Execution read-model row that the interpreter pushes via `setExecutionStatus`.

This is a genuinely disciplined implementation of the stated contract.

---

## A-1 (Design debt) — Node-type definitions are spread across ~5 sites

Adding one node type currently requires edits in, at minimum:
1. `packages/dsl/src/types.ts` — the `*NodeConfig` type + union;
2. a `packages/dsl/src/*.ts` resolver (for pure nodes) + its export in `index.ts`;
3. `apps/worker/src/temporal/workflows.ts` — a new `case` in the `execNode` switch (`:256-703`);
4. `apps/worker/src/temporal/activities.ts` — the activity (for side-effecting nodes);
5. `apps/web` — the palette entry + config form.

The `execNode` switch is already ~450 lines across ~25 node types. The docs (`docs/n8n-node-types.ts`, `PLAN-NODE-TYPES.md`) signal an ambition toward the n8n catalog (dozens more). At that scale the duplicate-in-5-places pattern is a reliable source of drift — a node added to the palette but missing a resolver, or a config type that doesn't match the interpreter's `as unknown as` cast (of which there are ~25; these casts also bypass type-checking of config shape).

**Recommendation (with trade-off):** move toward a **node-definition registry** — one module per node type exporting `{ type, configSchema (zod), resolve?/activity?, palette }` — so the interpreter dispatches from a map and the web palette + validation derive from the same source. Cost: a refactor of the working switch and a dispatch indirection. Benefit: adding a node becomes one file, and `validateGraph` can check config shape from the same schema. Do this *before* the next big node push, not after.

---

## A-2 (Future risk) — Merge fan-in determinism rests on concurrent arrival order

`workflows.ts:744-756` + `:794`: the fan-in join counts branch arrivals under a parallel `Promise.all` and fires the merge on the last arrival. This is replay-safe **as long as** the concurrent `execChain` branches always interleave identically on replay. For activity-driven branches that holds (Temporal replays activity completion order deterministically), but it's the one place where correctness depends on a non-obvious concurrency invariant rather than sequential logic. If a future change introduces a branch that resolves without an activity (pure nodes only) alongside one that does, the microtask ordering could differ from the argument the comment relies on.

**Recommendation:** keep a diamond-graph determinism-replay test as a guard (see QA Q-4), and if the node set grows to where pure-only parallel branches are common, consider an explicit deterministic ordering (e.g., process arrivals in declared-edge order at a barrier) rather than relying on scheduler timing.

---

## A-3 (Future risk) — `forEach` launches up to 100 concurrent children

`workflows.ts:587` launches `items.map(... executeChild ...)` inside a single `Promise.all` — up to `MAX_FOREACH_ITEMS` (100) child workflows concurrently, each of which may itself fan out (bounded by the depth-5 cap). Two consequences at scale: (a) a burst of up to 100 child-workflow starts hits the task queue / worker at once (throughput spike, and history-event growth on the parent for 100 child-completion events); (b) the cost-cap overshoot in QA Q-3. The depth cap bounds *nesting* but not *breadth × nesting* — a depth-5 tree of 100-wide fan-outs is 100⁵ in the worst case (the step cap and per-execution budget are the real backstops).

**Recommendation:** consider a concurrency window (process items in chunks) rather than all-at-once, and surface the breadth×depth blast-radius in docs. Not urgent — the caps prevent runaway — but relevant to worker capacity planning.

---

## A-4 (Note) — Data-model index review deferred

I did not read `packages/db` Prisma schema this pass. The hot read paths are clear from the services and should be confirmed to have indexes:
- `Execution` — queried by `where:{tenantId} orderBy createdAt desc` (`executions.service.ts:401`) and `findUnique({workflowId})` (`:520`). Needs an index on `(tenantId, createdAt)` and a unique on `workflowId`.
- `GraphDefinition` — `findFirst({tenantId, workflowKey} orderBy version desc)` (`graphs.service.ts:131`). Needs `(tenantId, workflowKey, version)`.
- `WebhookDelivery` — `@@unique([endpointId, deliveryId])` is relied on for dedupe (confirmed in code comment) and pruned by `(endpointId, createdAt)`.
- Usage ledger — aggregation hot path (see QA Q-5).

**Recommendation:** a quick schema pass to confirm these indexes exist; the queries assume them.

---

## Durability / scalability — verified present

- **Graph versioning & snapshot at start:** `startGraph` passes the immutable `snapshot.graph` + `contentHash` + `version` into workflow args and a Temporal memo (`executions.service.ts:334-353`); editing a flow later can't corrupt an in-flight run. ✅ (prior review's Slice #5 concern.)
- **`continueAsNew` for long loops:** implemented with a `ResumeState` carrying `ctx`/`costUsd`/`stepCount`/`startNodeId`/`mergeArrivals`, triggered by `continueAsNewSuggested` or an explicit step cap, only at a safe single-next boundary with no pending approval/handlers (`workflows.ts:768-786`). ✅
- **Payload 2MB cap:** large agent/http/sql/code outputs are claim-checked to object storage via `maybeOffload`, and child projections strip `__*` bookkeeping (`workflows.ts:546-549`, `:619-622`). ✅
- **Interpreter versioning:** interpreter changes are gated with `wf.patched()` (`record-execution-v1`, `exec-status-v1`) so in-flight runs stay replay-safe. ✅
- **Read-model for the Runs list:** the interpreter pushes status+cost to a PG Execution row so listing closed runs needs zero Temporal calls (`executions.service.ts:388-435`) — the right scaling move.
- **Operational wiring is real, not vestigial:** `helmet`/CORS/throttler/ValidationPipe/exception-filter in `main.ts`; Sentry + Prometheus metrics init; `enableShutdownHooks()` closes the Temporal connection + pg pool; `/healthz`; structured request logging with correlation ids.

## Module boundaries

Dependency direction is clean: `@naary/dsl` is pure (no `db`/`node:crypto` — the graph hash lives in `graphs.service.ts` specifically to keep `node:crypto` out of the DSL bundle, `:6`). The worker imports the DSL resolvers + activities; the API imports services + the Temporal client; `@naary/contracts` holds the shared signal/query/queue names. No layering inversion found (web does not import worker code; dsl does not import db).
