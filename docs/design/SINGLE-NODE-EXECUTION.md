# Design — Single-node execution + data pinning

**Status:** proposed · **Date:** 2026-07-07 · **Purpose:** the authoring superpower naary is
missing — run ONE node against sample/pinned input and see its output instantly, and PIN a node's
output so downstream nodes can be built without re-running (or paying for) upstream. This is how
n8n makes flow-building feel like a REPL; naary's durability is great for *running* but slow for
*iterating*.

---

## 1. What naary has today (grounded)

- **All-or-nothing runs.** The only way to see a node's output is a full `RUN_GRAPH_WORKFLOW` on
  Temporal (`apps/worker/src/temporal/workflows.ts`) that walks the whole graph. Great for
  production (durable, crash-safe); painful for authoring — every tweak of node 5 re-runs 1–4,
  re-calls the LLM, re-hits the DB, and waits on any `wait`/approval.
- **Two node execution shapes already exist:**
  - **Pure nodes** (set, renameKeys, text, filter, aggregate, listOps, compareDatasets, json,
    number, if, switch) have side-effect-free resolvers in `@naary/dsl` (e.g. `resolveSet`,
    `resolveText`) — callable anywhere.
  - **Activity nodes** (agent, httpRequest, sqlQuery/sqlExec, mcpTool, sendEmail, xml, csv,
    htmlExtract, encode, random, hmac/jwt/totp, rssRead, dateTime) run in worker activities that
    fetch the tenant's secrets in-activity by `tenantId` (Tier-1 rule 4) and do the I/O.
- **`ctx`** maps `nodeId → output`. A node's inputs are its upstream `ctx` reads (`{from,path}`
  bindings + — with the expressions design — `{{ }}` templates).

## 2. The two features (they compose)

- **Single-node execution** — "run just this node" with a *mini-ctx* (the outputs its inputs
  reference), returning its output to the canvas. No full workflow, no downstream, no waiting.
- **Data pinning** — save a node's output as a *pin* (from a real run, a single-node test, or a
  manual paste). Pins feed single-node execution and are shown in the inspector, so you can build
  node 5 against node 4's pinned sample without ever running node 4.

Pinning without single-node-exec is half a loop; together they're the iterate-fast REPL.

## 3. Single-node execution — how it runs (Tier-1 safe)

Given a target node + a mini-ctx (its upstream deps, from pins or a manual override):

- **Pure node** → the API calls the node's `@naary/dsl` resolver directly with the mini-ctx.
  Instant, no Temporal, no secrets involved.
- **Activity node** → a short-lived Temporal execution runs the SAME activity with the mini-ctx and
  returns the output. Reuse the existing activity registrations + the in-activity secret fetch, so
  a "test" call is identical to a real one (Tier-1 rule 4 preserved). Two implementation options:
  1. a dedicated `runSingleNode` workflow that executes exactly one node's activity then returns;
  2. the existing interpreter with a `{ targetNodeId, seededCtx }` mode that seeds `ctx` from the
     mini-ctx and executes only the target. Option 1 is simpler + cheaper; prefer it.
- **Not testable inline:** `wait`, `humanApproval`, `executeSubWorkflow`, `forEach`, triggers — a
  single-node test surfaces "not testable; run the flow" for these.

Building the **mini-ctx**: collect the target's upstream references (its `{from}` fields + `{{ }}`
template node ids). For each, use the pinned output if present, else the author's manual input,
else (opt-in) recursively single-node-run that upstream. Missing + unpinned + no override ⇒ a clear
"pin or provide input for `<nodeId>`" message.

## 4. Data pinning — model

Pins are **mutable authoring state**, separate from the immutable, versioned `GraphDefinition`
snapshots — so a new table:

```prisma
model PinnedData {
  tenantId    String
  workflowKey String
  nodeId      String
  output      Json      // the pinned sample (small; large blobs use the claim-check store)
  createdAt   DateTime  @default(now())
  @@id([tenantId, workflowKey, nodeId])
}
```

- **Authoring-only, never in a real run.** A production `RUN_GRAPH_WORKFLOW` ALWAYS executes
  upstream nodes — pins are a dev aid, invisible to the interpreter. (This mirrors n8n and avoids
  the footgun of shipping a flow that silently uses stale mock data.)
- Set a pin from: a single-node test result, a whole-run result (pin node X's real output), or a
  manual JSON paste.
- Size: keep pins small; reuse the existing claim-check/object-store offload for big outputs.

## 5. Endpoints (control plane)

- `POST /graphs/:workflowKey/nodes/:nodeId/test` `{ inputs?: Record<nodeId, unknown> }` →
  `{ output }` — single-node exec with pinned-ctx, `inputs` overriding per-upstream.
- `GET  /graphs/:workflowKey/pins` → `{ [nodeId]: output }` (for the canvas).
- `PUT  /graphs/:workflowKey/nodes/:nodeId/pin` `{ output }` → save/replace a pin.
- `DELETE /graphs/:workflowKey/nodes/:nodeId/pin` → clear.

All tenant-scoped via the token (never the body). The `test` route reuses `GraphsService` to load
the latest graph + `CredentialsService`/activities for the node's real behavior.

## 6. Web — the loop

- Node inspector gains **"Test node"** (runs it, shows the output inline) and a **pin toggle** (📌
  keeps the last output as the node's sample). A pinned node shows a badge + its sample in the
  inspector.
- The output panel becomes the reference source for the expressions "insert `{{ }}`" affordance
  (see EXPRESSIONS.md §5) — pinned/sample outputs give real path suggestions.
- Canvas marks pinned nodes visually so it's clear which outputs are live vs sampled.

## 7. Non-negotiables carried in

- **Secrets stay in-activity.** A single-node test of an activity node fetches the key by
  `tenantId` inside the activity, exactly like a real run — never in the API, never returned
  (Tier-1 rules 3–4).
- **Billing still counts.** Testing an `agent`/LLM node is a real model call → it meters usage like
  any run (no free calls; Tier-1 rule 6).
- **Pins never leak into production.** The interpreter ignores `PinnedData`; only the authoring
  endpoints read it.
- **Determinism unaffected.** Single-node exec is outside `RUN_GRAPH_WORKFLOW`; the durable
  interpreter is untouched.

## 8. Rollout — as slices (each its own PR)

1. **Pins CRUD** — `PinnedData` table + the 3 pin endpoints + `GET /pins`; canvas pin toggle +
   badge + sample display. (Useful alone: pin a real run's output, build against it.)
2. **Single-node exec for PURE nodes** — API-side resolver invocation with pinned-ctx; inspector
   "Test node". Instant, no Temporal, low risk — proves the loop.
3. **Single-node exec for ACTIVITY nodes** — the `runSingleNode` Temporal path (real secrets +
   I/O + billing). The heavy slice.
4. **Recursive fill + insert-reference wiring** — auto-run/pin missing upstream; feed pinned
   outputs into the expressions `{{ }}` picker.

## 9. Verification plan

- Pins: CRUD round-trip; interpreter e2e proving a real run IGNORES pins (executes upstream).
- Pure single-node: unit — resolver output matches a full-run output for the same node+inputs.
- Activity single-node: worker e2e — `runSingleNode` for an httpRequest/agent returns the same
  output shape as the interpreter, with secrets fetched in-activity and usage metered.
- Isolation: a test call for tenant A can't read tenant B's pins or credentials.

## 10. Residual open questions

- **Mini-ctx auto-fill depth** — recursively running unpinned upstream is convenient but can fan
  out into a partial real run. Default: require a pin/override; make recursion explicit opt-in.
- **Pin staleness** — a pin taken before a node's config changed may mislead. Show an "edited since
  pinned" hint; don't auto-invalidate.
- **`runSingleNode` reuse vs duplication** — option 1 (dedicated workflow) duplicates a little of
  the interpreter's per-node dispatch; option 2 (interpreter with a target flag) reuses it but
  complicates the hot path. Prototype both on the agent node before committing.
- **Large pinned outputs** — claim-check offload keeps Temporal/DB payloads small, but the canvas
  must render a truncated preview, not the whole blob.
