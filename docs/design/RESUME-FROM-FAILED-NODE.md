# Resume a failed run from the failed node

Today a failed run can only be **rerun**: a brand-new run from the original trigger input, against
the current graph. If the flow already sent an email, charged a card, or wrote a row before a later
node failed on a network blip, rerunning **repeats those side effects**. That is the gap this closes.

The motivating shape, and the one the e2e test encodes:

```
sendEmail (succeeded, NOT idempotent)  →  httpRequest (failed: ECONNRESET)  →  set → end
                                          ^ retry from here, keep going, never re-send the email
```

---

## 1. What already exists (and why this is mostly plumbing)

The interpreter has accepted a resume descriptor since Slice #6 — it is how `continueAsNew` works:

```ts
ResumeState { ctx, costUsd, stepCount, startNodeId, mergeArrivals, approval, webhookResume, … }
```

`run-graph.ts` seeds ctx from it and starts the walk at `resume.startNodeId`. It is workflow **arg
4**, and *every* API/schedule/child call site passes only 3 args — so the capability is already
there and simply unused from outside the workflow.

`queryRunGraph` can also recover the **exact graph snapshot** a run walked, out of its history.

**The one thing genuinely missing is a durable ctx to resume from.** `Execution` stores
`failedNodeId` + `executedNodeIds` and, by explicit design, *no output content*:

> `schema.prisma` — "Node IDs ONLY — never ctx output content (privacy checklist)"

On a failed run the API returns `ctx: {}`.

---

## 2. Decision: ctx snapshots go to object storage, never to Postgres

The privacy rule stays intact. Postgres gets a **claim-check reference** (a URL-ish pointer plus a
size), never values. The values go to object storage under a `resume/<tenantId>/` prefix, which is
where CAN-boundary ctx entries already live via `offloadCtxEntry`, and which gets the same
lifecycle expiry as the existing `ctx/` prefix.

This is not a new class of data at rest — it is the same data, in the same bucket, for the same
reason (a run's ctx being too big or too transient for Temporal payloads). What is new is that it is
written for **every failed run** rather than only at a CAN boundary, so:

- **`RESUME_SNAPSHOTS`** (`on` | `off`, default `on`) is the kill switch. Off ⇒ no snapshot is
  written and resume reports `snapshot_disabled`.
- **No object store configured ⇒ no snapshot**, and resume reports `snapshot_unavailable`. The
  feature degrades to today's behaviour instead of half-working.
- The snapshot is written **only on terminal failure**, not on success, so a healthy run costs
  nothing.
- Retention is the bucket lifecycle (`s3_claim_check_retention_days`, default 30). A resume
  attempted after expiry fails loudly (`snapshot_expired`), never silently with a partial ctx.

**Rejected: reading ctx back out of Temporal history.** It works only for runs that continued-as-new
at least once, is stale to the last CAN boundary, and cannot see pure nodes (`set`/`if`/`filter`
produce output with no activity to read). A feature that works for long runs and silently not for
short ones is worse than one that states its precondition.

---

## 3. Decision: refuse loudly outside a narrow safe subset

This is the core of the design. Resume is **only** offered when restarting at a single node id
faithfully represents the run's remaining work. Everywhere else it must refuse with a reason, not
guess — every one of these would otherwise produce a plausible-looking wrong run.

| Refusal | Why restarting at one node is wrong |
|---|---|
| `inside_item_region` | A `splitOut` region keeps `items`/`regionOut`/iteration index in **workflow locals**; only the *last* item survives in `ctx[splitOutId]`. Resuming at a region member re-runs it against one stale item and **succeeds with wrong data**. There is no iteration index to resume from. |
| `loop_or_child_node` | `forEach` / `executeSubWorkflow` child ids embed `stepCount`, and per-iteration progress (`collected[]`) is a local. Re-entering re-runs **every** child, with full side effects. `forEach` also swallows child failures, so it isn't even the failed node. |
| `parallel_fanout` | Branches run under `Promise.all`. One `startNodeId` cannot express "B failed while A completed and C was in flight" — C's remaining work is silently dropped. |
| `no_failed_node` | `failedNodeId` is NULL for non-thrown terminals (`rejected`, `budget_exceeded`, `circuit_open`, `invalid_graph`) and for `onError: "continue"` nodes. Nothing to resume *at*. |
| `not_a_failure` | Only a `failed` run can be resumed. A completed or cancelled run has no failure to retry. |
| `snapshot_missing` / `_disabled` / `_unavailable` / `_expired` | No ctx ⇒ downstream `{{ … }}` would resolve to `undefined` rather than erroring. Refuse rather than run a graph against a hollow ctx. |
| `graph_unavailable` | The exact snapshot could not be recovered from history. Pairing a recovered ctx with the *latest* graph is silent wrongness — renamed or deleted node ids. |

And one **warning** rather than a refusal:

- `at_most_once_node` — the failed node is `sqlExec` / `sendEmail` / `code` / `codeAgent` /
  `integration`. It *failed*, but failed ≠ had no effect (a 500 after the write). Resume is allowed
  because only the caller knows, but the API requires `acknowledgeSideEffects: true` and the UI says
  what it might repeat.

Eligibility is computed by a **pure function over the recovered graph** (`packages/dsl`), so every
branch above is unit-testable without Temporal, Postgres, or a browser.

---

## 4. Decision: reuse `ResumeState`, and fix the two things that only worked for CAN

The resume call passes the recovered snapshot graph as arg 1 and
`{ ctx, startNodeId: failedNodeId, costUsd, stepCount, mergeArrivals }` as arg 4. Two latent traps
had to be fixed, because both are invisible until a *non-CAN* caller passes `resume`:

1. **`$vars` are skipped when `resume` is set** (`run-graph.ts` gates `loadVariables` on `!resume`).
   That is correct for CAN — the carried ctx already holds them — but an API resume would leave
   every `{{ $vars.KEY }}` unresolved. `ResumeState.reseedVars` opts back in.
2. **`stepCount` must be carried exactly.** It seeds child workflow ids; a wrong value re-runs
   completed children. It is snapshotted with the ctx, not recomputed.

`costUsd` is carried so the resumed run continues against the same budget rather than getting a
fresh allowance — a resumed run must not be a way to escape a spend cap.

---

## 5. Lineage: `resumedFromId`

A resumed run is a new `Execution` row (new Temporal workflow — a failed workflow is closed and
cannot be restarted). `resumedFromId` records the parent so the UI can show the chain and so cost
is attributable rather than double-counted as two independent runs. `POST` returns the new id.

---

## 6. Surfaces

- `GET /executions/:id/resume-eligibility` → `{ resumable, reason?, failedNodeId?, warnings[] }`.
  Separate from the POST because the **UI must be able to disable the button and say why** — a
  button that fails on click is how the graphQL-retry gap felt.
- `POST /executions/:id/resume` → `{ workflowId }`. 409 with the reason when ineligible.
- `POST /v1/runs/:id/resume` — same, on the public API, so the CLI/automation can do it.
- Run detail: **"Resume from failed node"** beside Rerun, on failed runs only, gated on the same
  `run` permission, disabled with the reason as its tooltip.

---

## 7. Out of scope, deliberately

- **Resuming inside a loop / region / fan-out.** Needs per-iteration progress durably recorded,
  which is a much larger change to the region walk. Refused, not approximated.
- **Editing inputs before resuming.** Resume replays the snapshot as-is.
- **Auto-resume on transient failure.** Per-node `retry` already covers the transient case inside a
  run; this is the manual escape hatch for when retries are exhausted or the failure outlived them.
