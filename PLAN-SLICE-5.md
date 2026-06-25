# PLAN.md — Vertical Slice #5: Durable Graph Versioning (Graphs from Postgres + Per-Execution Snapshot)

> Roadmap note: the user asked for `PLAN.md §9.3` **and** `§9.4` next. Those are
> each about as large as all of Slice #4, so they are split: **this slice is §9.3
> only**; **§9.4 (branching / parallel / loop) is Slice #6** (see §8). The order is
> also dependency-correct — §9.3 produces the content-hashed graph *snapshot* that
> §9.4's `continueAsNew` must carry across restarts. Build the carrier first.

---

## 1. Purpose

Stop hardcoding graph definitions in the DSL `graphRegistry` (added in Slice #4).
Graphs become **data in Postgres**. At execution start, the **control plane** loads
the graph, computes a **canonical content hash**, and passes the **full graph
snapshot + hash** as workflow args. Each run therefore carries its own immutable
copy: **editing a flow can never corrupt an in-flight run**, and every run is
traceable to the exact graph version it executed.

### The key architectural insight

Loading and hashing the graph is **I/O + must be reproducible**, so it lives in the
NestJS control plane — never in the workflow. We **keep pass-by-value**: the workflow
already receives the graph as an arg today (`runGraph(graph, input, ctx)`); we change
only its *source* (DB instead of registry) and *pin* it with a hash. The deterministic
interpreter does not change at all in this slice.

---

## 2. Scope

**Build (this slice):**
- A `GraphDefinition` Postgres table (Prisma) holding versioned graph definitions per
  tenant, keyed by a stable `workflowKey` (e.g. `"github-review"`, `"wf-default"`).
- A **canonical-JSON content hash** (key-sorted, pure) so cosmetic key/edge reordering
  does not churn versions; a semantic change produces a new hash.
- A `GraphsService` (control plane): `upsert` (bump version only when the hash changes)
  and `getLatest(tenantId, workflowKey)`.
- Seed the two existing graphs (`wf-default`, `github-review`) into the DB so current
  flows keep working; **remove the hardcoded `getGraphForWorkflow` registry** as the
  runtime source (it may remain only as a seed input).
- Wire `executions.service` (`start`, `startWebhook`) + `hooks.controller` to **load
  from the DB**, snapshot the graph, and pass `{ graph, contentHash, version }` to the
  workflow; record the hash on the run (Temporal **memo / search attribute**) for
  traceability.

**Explicitly OUT of scope (do NOT build):**
- **Branching / parallel / loop** interpreter changes — that is Slice #6 (§9.4). `walk()`
  and `runGraph` traversal stay exactly as they are.
- Graph-authoring UI / React Flow canvas (§9.5).
- Version *management* endpoints (rollback, diff, list-versions) beyond `getLatest` and
  the upsert needed to seed/update. No new public REST surface unless a task needs it.
- Switching pass-by-value → pass-a-reference-load-in-activity. We keep passing the full
  graph; the ~2MB Temporal payload cap is noted as a **known limitation**, not solved here.

---

## 3. Architecture constraints (consistent with CLAUDE.md Tier 1)

1. **Graph load + hashing happen in the control plane, never in the workflow.** The
   workflow stays pass-by-value and deterministic; no DB read, no `crypto`, in workflow code.
2. **The snapshot is immutable per run.** The workflow receives the exact graph bytes that
   existed at start; a later edit creates a *new version* and does not touch running history.
3. **Hashing is canonical and pure** (sorted keys, stable separators). Two structurally
   identical graphs hash equal; the hash function has no time/randomness/I/O.
4. **`crypto` stays out of `@naary/dsl`.** The DSL is bundled into the deterministic
   workflow. Canonical *serialization* (pure, no crypto) may live in the DSL; the actual
   `sha256` hashing lives in a server-only module (control plane / `@naary/db`-side).
5. **Payloads stay small** (~2MB cap). Note the cap; don't engineer around it this slice.
6. Tenant isolation: a graph is always loaded by `(tenantId, workflowKey)`.

---

## 4. Data model

```prisma
model GraphDefinition {
  id          String   @id @default(uuid())
  tenantId    String
  workflowKey String   // stable key the trigger/registry referenced, e.g. "github-review"
  name        String
  graph       Json     // the GraphDef
  contentHash String   // sha256 of canonical(graph)
  version     Int      // monotonically increasing per (tenantId, workflowKey)
  createdAt   DateTime @default(now())

  @@unique([tenantId, workflowKey, version])
  @@index([tenantId, workflowKey]) // latest-version lookup
}
```

`getLatest` = highest `version` for `(tenantId, workflowKey)`. `upsert(graph)` computes
the canonical hash; if it equals the latest row's `contentHash`, it's a no-op (same
version); otherwise it inserts `version + 1` with the new hash.

---

## 5. Tasks

### T1 — `GraphDefinition` model + migration
- Add the Prisma model above; `prisma migrate dev` to create the table.
- **Verify:** migration applies cleanly; `\d "GraphDefinition"` (or `prisma studio`) shows
  the table with the unique constraint.

### T2 — Canonical content hash (pure)
- A pure `canonicalize(graph)` (recursively key-sorted JSON) + `hashGraph(graph)` (sha256
  of the canonical string). `canonicalize` may live in `@naary/dsl` (pure); `hashGraph`
  (uses `node:crypto`) lives **server-side**, not in the DSL.
- **Verify (unit):** two graphs differing only in object-key / edge-array order hash
  **equal**; changing a node `id`/`type`/edge changes the hash. (Edge order is semantic if
  the interpreter depends on it — match `walk`'s "first declared edge" rule: confirm and
  document whether edge order is part of identity.)

### T3 — `GraphsService` (upsert + getLatest)
- `upsert(tenantId, workflowKey, name, graph)`: hash → if unchanged, return latest;
  else insert `version+1`. `getLatest(tenantId, workflowKey)` → `{ graph, contentHash, version }`.
- **Verify (unit/integration):** upserting the identical graph twice keeps `version` the
  same; a modified graph yields `version+1` and a different `contentHash`.

### T4 — Seed existing graphs + load from DB at start
- Seed `wf-default` (`webhookSampleGraph`) and `github-review` (`githubReviewGraph`) into
  `GraphDefinition` (seed script run against the dev DB, idempotent via T3 upsert).
- Replace the `getGraphForWorkflow` registry call in `hooks.controller` and the hardcoded
  `sampleGraph` in `executions.service.start` with `GraphsService.getLatest(...)`; unknown
  key → 404 (preserve current behavior). `startWebhook` keeps taking a `GraphDef` (now
  sourced from the DB) — minimal controller change.
- **Verify:** webhook ingress for a `github-review` endpoint still starts the reference
  flow (existing e2e/interpreter tests stay green); `POST /executions` (`start`) still runs
  the default graph. Show the existing **67 tests still pass**.

### T5 — Snapshot + hash onto the run
- Pass `{ graph, contentHash, version }` through to `runGraph` (the workflow already takes
  `graph`; add the hash/version to `RunGraphCtx` so it's in history) and set a Temporal
  **memo / search attribute** (`graphContentHash`, `graphVersion`) at `workflow.start`.
- **Verify:** the started workflow's memo shows the `contentHash`; **edit the seeded graph
  (new version) after a run has started and prove the in-flight run still reports/uses the
  old hash** and completes on the old snapshot (the core anti-corruption guarantee).

---

## 6. Definition of done

- Graphs are loaded from Postgres; the hardcoded runtime registry is gone (or seed-only).
- Each run carries an **immutable, content-hashed snapshot**, and the hash is **observable
  on the run** (memo/search attribute).
- A mid-run graph edit is **proven** not to affect the in-flight execution.
- New unit tests cover canonical hashing (order-insensitive) + versioning (no-op vs bump).
- **All existing 67 tests stay green**; `npx tsc -b` clean.
- README updated: graphs now come from Postgres, runs are version-pinned, the ~2MB
  payload cap is a documented limitation.

---

## 7. Verification summary (run before declaring done)

- `npx prisma migrate dev` applies; table present.
- `pnpm test` — existing 67 + new hashing/versioning tests pass.
- `npx tsc -b` clean; workflow bundle still excludes `node:crypto` / DB code (the DSL
  carries only the pure `canonicalize`, not the hasher).
- Manual/integration: start a run, edit the graph, confirm the in-flight run is unchanged.

---

## 8. Next slice (context only — do NOT build now)

**Slice #6 — Branching / parallel / loop (`PLAN.md §9.4`).** Rewrite `walk()` from
"precompute linear order, iterate" to **step-by-step**: run node → evaluate outgoing
edges against `ctx` → pick next node(s). Linear becomes the degenerate case (the existing
67 tests are the regression gate). Add a **structured `EdgeDef.condition`** (pure
data-driven predicate — never `eval`/`new Function`). The current `walk: cycle detected`
throw *becomes* the loop mechanism: loops are intentional cycles, bounded by
`maxStepsPerRun` + **`continueAsNew`** carrying `ctx` / `costUsd` / `stepCount` / the
**graph snapshot + hash from this slice** / resume node id, triggered on
`continueAsNewSuggested`. `Promise.all` fan-out for parallel branches.
