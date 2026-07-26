# Workflow evals & regression test-runs (#575)

Run a workflow against a named set of golden cases and record a verdict per case, linked to the
graph version that produced it.

---

## 1. Data model

| Table | Holds |
|---|---|
| `EvalDataset` | the golden dataset body (`{ assertions?, cases[] }`) — env-scoped, `@@unique(tenantId, environmentId, workflowKey, name)` |
| `EvalRun` | one batch execution: `workflowId`, `graphVersion`, `graphContentHash`, counts, cost |
| `EvalCaseResult` | one case's `verdict` / `score` / `costUsd` / `latencyMs` / `assertions[]` |

`EvalDataset` follows the **`PinnedData` substrate pattern** — author-owned sample I/O in a `Json`
column, environment-scoped, cascading on environment delete — scaled from one node's output to a set
of whole-run cases. Body shape and write gate live in `packages/dsl/src/assertions.ts`.

`EvalCaseResult` is unique on `(evalRunId, caseName)`, which doubles as the **idempotency key**: a
retried scoring activity upserts the same row rather than duplicating a verdict (the shape
`recordUsage` uses).

---

## 2. Assertions v1

```jsonc
{ "kind": "jsonPathEquals",    "path": "agent.output.category", "value": "billing" }
{ "kind": "jsonPathContains",  "path": "tags",                  "value": "urgent" }   // array membership OR substring
{ "kind": "numericTolerance",  "path": "score", "expected": 0.8, "tolerance": 0.05 }
{ "kind": "schemaValid",       "path": "agent.output", "schema": { /* JSON Schema */ } }
{ "kind": "llmJudge",          "criteria": "Is the reply polite?", "threshold": 0.8 }
```

`path` addresses the **run ctx** (`<nodeId>.<field>…`), the same shape expressions use, so an
assertion reads exactly what a downstream node would have read.

`schemaValid` is **real zod**: the JSON Schema is compiled with `z.fromJSONSchema`. Verified coverage
on zod 4.4.3 — object+`required`, `additionalProperties:false`, nested arrays-of-objects,
`oneOf`/`anyOf`, `enum`, `format`, tuple `items`, `$ref`/`$defs` all convert; `{type:"nonsense"}` and
a non-object THROW at conversion. A schema that cannot be converted becomes an assertion **error**
(surfaced to the author) — never a silent pass, and never a thrown activity.

**`error` ≠ `fail`.** A case aggregates to `error` when any assertion could not be evaluated
(unusable schema, missing path, judge unavailable) or when the child run did not complete. That is
deliberate: a broken environment or a bad credential must not read as a quality regression on a
promote screen. `pass` requires every assertion to pass; a case with *no* assertions passes (it
proved the graph runs end to end).

---

## 3. Execution shape

An eval run is an **ordinary Temporal execution** of the `evalRun` workflow
(`apps/worker/src/temporal/workflow/eval-run.ts`, registered from `workflows.ts`):

1. `loadEvalPlan` (activity) → the case list.
2. Per case, in chunks of `EVAL_CONCURRENCY` (4): `wf.executeChild(runGraph, …)` with the
   **version-pinned snapshot** the API resolved at start, the case's payload as the trigger input, and
   a deterministic child id `<evalRunId>-case-<index>` (so the case is drillable in the Runs list).
3. `evaluateEvalCase` (activity) scores the child's ctx projection and upserts the result row.
4. `finalizeEvalRun` (activity) aggregates **from the rows** — idempotent, cannot double-count.

Determinism (Tier-1 rule 2): cases are iterated by index over an activity-returned array; every child
id derives from the eval-run id + index; the dataset read, zod compilation, judge call, clock stamps
and all writes are in activities. `Date.now()` in the workflow is the Temporal sandbox's **workflow
time** (the justification written out in `engine/node-exec.ts`), which is what makes per-case latency
measurable there.

**Per-case timeout.** Each child carries `workflowExecutionTimeout = EVAL_CASE_TIMEOUT_MS` (15 min).
Without it, a case that parks forever — most realistically on a #576 forced-approval tool gate, which
waits indefinitely by design — would hang the whole batch. A timed-out or failed child is an `error`
verdict, and the batch continues (a child rejection is caught per case, exactly like `forEach`).

**Concurrency is bounded** for the same reason `forEach`'s fan-out is: 200 simultaneous child runs
would swamp the worker pool and the tenant's provider rate limits.

**Scoring is AT-MOST-ONCE** (`maximumAttempts: 1`), for the reason `runAgentTooled` is: one
`evaluateEvalCase` can make up to `MAX_ASSERTIONS_PER_CASE` sequential LLM-judge calls, and a retry
re-runs the *whole* activity — replaying every judge call already made. `recordUsage` is
first-write-wins on `(executionId, nodeId)`, so a second attempt would spend money and record
nothing: a silently-free call, which rule 6 forbids. A scoring failure is therefore caught per case
(one unscoreable case cannot take the other 199 down); that case has no result row, so the
row-derived `total` comes out below `EvalRun.totalCases` — an honest "incomplete" signal rather than
a fabricated verdict.

**A failed batch closes its row out** as `status: "failed"` before rethrowing. Leaving it `running`
with `finishedAt: null` would be indistinguishable from a batch still in progress.

**The GRAPH is pinned; the DATASET is not.** `evaluateEvalCase` re-reads the dataset body per case,
so editing assertions mid-batch can score later cases against a different rubric, and renaming a case
makes it unscoreable (skipped, batch continues). Pinning the body would mean threading it through
every case's activity arguments; the graph — the thing under test — is what must be immutable.

---

## 4. LLM judge — billed through the existing path

The judge calls **`runAgent`**, the same activity a real agent node uses, so it inherits the
in-activity BYOK key fetch, the atomic budget **reservation**, the pricing table and the rule-6
fail-safe (a provider reporting no usage is billed an estimate, never zero) with no second copy of
that logic to drift (#575 AC3).

Ledger identity: `executionId = evalRunId`, `nodeId = eval-judge:<caseName>:<assertionIndex>`. The
INDEX (not the optional `label`) guarantees uniqueness, because `recordUsage` upserts on
`(executionId, nodeId)` with `update: {}` — two judge calls sharing a key would silently collapse into
one billed row. `AgentMeta.ledgerNodeType` tags the row `evalJudge` so judge spend is attributable
and does not distort by-node-type rollups; no other activity reads that field (each hardcodes its own
`nodeType`), so it cannot bleed into a TTS/RAG/codeAgent row.

A judge that cannot run (bad credential, quota) is an assertion **error** costing nothing, not a
case failure.

---

## 5. Privacy — what reaches Postgres

The results tables store **verdicts, scores, cost and latency**. They never store the trigger
payload's values, the run's output, or the judge's prose.

This is **structural**, not a convention: every persisted outcome goes through
`buildPersistableOutcome`, whose explicit field allowlist is `{ label, kind, passed, score, error }`.
A spread-then-`delete` would survive one refactor; an explicit constructor survives all of them. The
judge IS asked for a `reason` (a rubric score without reasoning is a worse score) — it is read into a
local and never referenced again; `judgeOutcome` has no field that could carry it.

Error detail is an enumerated **code** (`missing-path` | `invalid-schema` | `not-a-number` |
`judge-unavailable`), not a message — "expected X, got Y" would carry the model's output.

Asserted in `apps/worker/test/evals.activity.spec.ts`: a case whose output *and* judge reason both
contain a distinctive string, with the full object handed to prisma (and every log line) grepped for
it.

---

## 6. API

| Route | Verb (RBAC) |
|---|---|
| `GET/PUT/DELETE /graphs/:workflowKey/evals/datasets[/:name]` | `view` / `edit` / `edit` |
| `POST /graphs/:workflowKey/evals/runs` (body `{ dataset }`) | `run` — an eval executes the real workflow with real spend |
| `GET /graphs/:workflowKey/evals/runs` | `view` — each row carries `graphVersion` + `graphContentHash` |
| `GET /evals/runs/:id` | `view`, gated on the run's own workflow |

Dataset PUT is whole-body (a merge could never delete a case) and capped at `MAX_DATASET_BYTES`
(512 KB) because the whole body becomes one activity result the batch holds in history.

**DELETE is refused while the dataset has runs.** `EvalRun.datasetId` cascades, so a routine
delete-and-recreate would take every `EvalRun` and `EvalCaseResult` with it — i.e. exactly the
`graphVersion`/`graphContentHash` history the promote comparison reads. Losing the regression record
is worse than having to rename, so it is a 400.

The runs list is what satisfies AC2 — "vN passed 18/20 vs vN-1 20/20" needs only the version, hash
and counts each row already carries; there is no separate comparison endpoint.

---

## 7. Not in this slice

- **The eval tab UI** (run history, per-case drill-down, score trend, an "eval before promote"
  badge). The API is complete and the ACs are satisfiable through it; the screen is the follow-up.
- Selecting a SUBGRAPH to eval (the whole workflow runs).
- A tenant opt-in to store prompt/output text alongside verdicts (the issue mentions it as an
  option; nothing here writes text, so opting in would be additive).
- Scheduled / on-promote automatic eval triggering.
