# QA Findings — naary-orchestrator

**Reviewer role:** QA engineer
**Date:** 2026-06-25
**Scope reviewed:** Slices #1–#4 (durable interpreter, BYOK + spend, budget enforcement,
webhooks + MCP) plus the unbuilt Slice #5 plan. Source under `apps/` and `packages/`,
the `PLAN*.md` requirement docs, `README.md`, and `CLAUDE.md` Tier-1 rules.

## Method & baseline evidence

The build and the existing suite are green, so these findings are about *gaps and
risks*, not a broken build:

```text
$ npx tsc -b            # exit 0, clean
$ npx vitest run
 Test Files  18 passed (18)
      Tests  67 passed (67)
```

Findings below are things the automated suite does **not** catch.

## Severity legend

| Sev | Meaning |
|-----|---------|
| **S1 — Critical** | Security/correctness defect that can leak data, lose/duplicate money, or corrupt a run in production. |
| **S2 — High** | Real defect or missing guardrail likely to bite in normal use; should be fixed before GA. |
| **S3 — Medium** | Correctness/robustness gap with limited blast radius or an easy workaround. |
| **S4 — Low / Doc** | Minor, cosmetic, or a documentation/scope-honesty issue. |

## Findings at a glance

| # | Sev | Area | Summary |
|---|-----|------|---------|
| 1 | S1 | Security | No authentication/authorization — any caller can act for any `tenantId`. |
| 2 | S2 | Billing | Cached input tokens are billed twice (full-rate **and** cache-rate). |
| 3 | S2 | Billing | Activity retries re-call the paid LLM and double-write `UsageEvent` (known gap, but live). |
| 4 | S2 | Robustness | No request validation anywhere — missing/garbage bodies fail silently or oddly. |
| 5 | S2 | Requirements | Slice #5 (graph versioning from Postgres) is unbuilt; runtime still uses the hardcoded registry. |
| 6 | S3 | Correctness | `downgrade` policy doesn't re-check the fallback model's cost; unknown fallback pricing throws post-call. |
| 7 | S3 | Correctness | Circuit breaker can't fire in practice — `walk()` is linear and throws on cycles. |
| 8 | S3 | Correctness | `walk()` throwing inside the workflow causes infinite workflow-task retries. |
| 9 | S3 | Correctness | B5 GitHub-review reference flow is structurally wired but semantically a stub (one hardcoded output schema). |
| 10 | S3 | Operational | Dedupe and OAuth-state rows accumulate forever (no TTL/cleanup). |
| 11 | S3 | Robustness | `GET /executions/:id` returns 500 (not 404) for unknown/terminated runs. |
| 12 | S4 | API | `POST /executions` can't pass real input — payload is hardcoded. |
| 13 | S4 | Perf | `monthToDateSpend` / usage aggregation load all rows into memory instead of a DB aggregate. |
| 14 | S4 | Doc | `schema.prisma` header still says "Slice #2"; comments claim graphs are hardcoded "for now". |

---

## Detailed findings

### 1. (S1) No authN/authZ — tenant isolation is unenforced
**Where:** every controller — `apps/api/src/**/*.controller.ts`.
**Observed:** `tenantId` is taken from a URL param or request body with no auth. Anyone
who can reach the API can:
- save/overwrite a provider key for any tenant (`POST /tenants/:id/credentials`),
- read any tenant's spend (`GET /tenants/:id/usage`),
- set any tenant's budget, create/delete connections, register webhooks, and
- **approve or reject any execution** by id (`POST /executions/:id/approve`).

**Impact:** Complete cross-tenant compromise of a product whose entire value prop is
per-tenant BYOK secrets and spend. The human-approval gate (the slice's headline
feature) is bypassable by anyone who can guess/observe a workflow id.

**Plan context:** Auth is explicitly "out of scope" for Slice #1 (`PLAN.md §2`), and the
later plans never re-introduce it. That is the gap: by Slice #4 there is tenant-scoped
secret + money data with **no plan to ever gate it**. This should be an explicit backlog
item, not an unstated omission.

**Recommendation:** Add an auth guard that derives `tenantId` from the caller's
credential (not from the URL/body), and authorize `:id` against it. Treat webhook
ingress separately (it authenticates via HMAC, which is correct).

---

### 2. (S2) Cached input tokens are double-billed
**Where:** `apps/worker/src/temporal/activities.ts` (builds `usage` with both
`inputTokens` and `cachedInputTokens`), `packages/usage/src/pricing.ts:computeCost`.
**Observed:** `computeCost` bills `inputTokens` at the full rate **and**
`cachedInputTokens` at the cache rate as two independent buckets:

```76:87:packages/usage/src/pricing.ts
export function computeCost(input: CostInput): number {
  const price = MODEL_PRICING[input.provider]?.[input.model];
  if (!price) {
    throw new UnknownModelPricingError(input.provider, input.model);
  }
  const cached = input.cachedInputTokens ?? 0;
  return (
    (input.inputTokens / 1_000_000) * price.inputPerMTok +
    (cached / 1_000_000) * price.cachedInputPerMTok +
    (input.outputTokens / 1_000_000) * price.outputPerMTok
  );
}
```

If the AI SDK's `usage.inputTokens` is the *total* prompt tokens (cache-read included,
as Anthropic-style normalization commonly does), the cached portion is charged twice:
once at full rate inside `inputTokens` and again at cache rate. CLAUDE.md rule 6 makes
billing accuracy a Tier-1 concern, so this needs verification.

**Impact:** Over-stated cost → premature `budget_exceeded` / wrongful pre-flight
rejection, and inaccurate tenant spend reporting.

**Recommendation:** Confirm whether `inputTokens` includes cached tokens for each
provider; if so, bill `(inputTokens − cachedInputTokens)` at full rate. Add a unit test
that pins the intended semantics.

---

### 3. (S2) Activity retry re-calls the LLM and double-writes usage
**Where:** `apps/worker/src/temporal/workflows.ts:14` (`retry: { maximumAttempts: 3 }`),
`activities.ts:runAgent`.
**Observed:** `UsageEvent` has no idempotency key on `(executionId, nodeId)` (README
acknowledges this as deferred). But it is *live*: any throw after `generateText` returns
— e.g. the `recordUsage` DB insert fails, or `computeCost` throws
`UnknownModelPricingError` for a downgrade fallback model (see #6) — bubbles up bare and
Temporal retries the **whole activity up to 3×**, re-calling the paid model and writing
duplicate ledger rows each time it gets past the call.

**Impact:** Real double/triple spend + inflated ledger on transient post-call failures.
This is the most likely "money bug" in production.

**Recommendation:** Make `recordUsage` idempotent (`@@unique([executionId, nodeId])` +
upsert), and/or split "call model" and "record usage" so a recording failure doesn't
re-trigger the call. At minimum, raise this from "deferred note" to a tracked S2.

---

### 4. (S2) No input validation on any endpoint
**Where:** `apps/api/src/main.ts` (no global `ValidationPipe`); controllers accept loosely
typed bodies, e.g. `start(@Body() body: { tenantId: string })`.
**Observed:** There is no `class-validator`/DTO layer and no `app.useGlobalPipes(...)`.
Consequences:
- `POST /executions` with no/empty `tenantId` produces a workflow id like
  `exec-undefined-<uuid>` and runs anyway.
- `POST /executions/:id/approve` with a missing `approved` field → `approved` is
  `undefined` → falsy → the run is silently **rejected** rather than erroring.
- `POST /tenants/:id/credentials` with a missing `apiKey`/`provider` reaches the provider
  validator / `encrypt(undefined)` before failing.

**Impact:** Silent wrong behavior (especially the approve→reject footgun) and unhelpful
500s instead of 400s.

**Recommendation:** Add a global `ValidationPipe({ whitelist: true })` with DTOs that
require the fields, and make `approved` a required boolean.

---

### 5. (S2) Slice #5 (durable graph versioning) is unbuilt while its plan is the newest doc
**Where:** `PLAN-SLICE-5.md` (most recently edited) vs. the code.
**Observed:** None of Slice #5 exists: no `GraphDefinition` Prisma model, no
`GraphsService`, no canonical hashing/versioning. The runtime still uses the hardcoded
registry the slice was meant to delete:

```72:77:apps/api/src/webhooks/hooks.controller.ts
    const graph = getGraphForWorkflow(endpoint.workflowId);
    if (!graph) {
      throw new NotFoundException(
        `No graph registered for workflowId '${endpoint.workflowId}'`,
      );
    }
```

`executions.service.start` likewise hardcodes `sampleGraph`. So the core anti-corruption
guarantee Slice #5 promises ("editing a flow can never corrupt an in-flight run", a
content-hash on each run) is **not delivered**.

**Impact:** Expected if Slice #5 simply hasn't started — but it should be explicitly
tracked as "planned, not implemented" rather than assumed done, since the README's
"slices implemented" wording stops at #4 while a #5 plan is present.

**Recommendation:** Confirm Slice #5 status; if not started, mark it clearly as backlog.

---

### 6. (S3) `downgrade` policy doesn't re-validate the fallback model
**Where:** `apps/worker/src/temporal/activities.ts:144-155`.
**Observed:** When `mtd + estimate > monthlyCap` and policy is `downgrade`, the code
swaps `model = budget.fallbackModel` and proceeds **without** re-estimating against the
cheaper model and without confirming the fallback is even priced. If `fallbackModel`
isn't in `MODEL_PRICING`, the call succeeds (spending money) and then `computeCost`
throws `UnknownModelPricingError` — which combines with #3 to cause repeated paid calls.

**Impact:** Downgrade can still blow the cap (no re-check), and a typo'd/unpriced
fallback model turns into wasted spend with no ledger row.

**Recommendation:** Validate `fallbackModel` against `MODEL_PRICING` when the budget is
set; after downgrade, re-estimate and still reject if the fallback also exceeds the cap.

---

### 7. (S3) Circuit breaker can't actually trip given linear traversal
**Where:** `apps/worker/src/temporal/workflows.ts:70-77`, `packages/dsl/src/walk.ts`.
**Observed:** `maxStepsPerRun` is meant to "halt a runaway loop" (`PLAN-SLICE-3 §1`), but
`walk()` precomputes a **linear, acyclic** order and *throws* on any cycle
(`walk: cycle detected`). There is no loop to run away. The breaker can only fire on a
hand-authored chain of >50 nodes — not the runaway-agent-loop scenario it advertises.

**Impact:** A guardrail that reads as protective but provides no protection against the
named threat until Slice #6 (loops) lands. Low blast radius, but misleading.

**Recommendation:** Document that the breaker is forward-looking for Slice #6, or move it
to count agent-calls so it's at least meaningful today.

---

### 8. (S3) `walk()` throwing inside the workflow → infinite workflow-task retries
**Where:** `workflows.ts:65` iterates `walk(graph)`; `walk` throws on cycles/unknown nodes.
**Observed:** A graph with a cycle or a dangling edge makes `walk()` throw *inside the
deterministic workflow*. A thrown error in workflow code is a workflow-task failure,
which Temporal retries indefinitely — the run wedges rather than failing cleanly.

**Impact:** A malformed graph (more likely once graphs come from the DB/canvas in later
slices) produces a stuck, perpetually-retrying execution instead of a clean
`failed`/`invalid` terminal state.

**Recommendation:** Validate the graph (acyclic, all edges resolve) in the control plane
before `workflow.start`, and/or catch the structural error in the workflow and return a
terminal `invalid_graph` status.

---

### 9. (S3) GitHub-review reference flow is wired but semantically a stub
**Where:** `packages/dsl/src/sample-graph.ts:githubReviewGraph`,
`activities.ts:outputSchema`.
**Observed:** Every agent node — including the "Review the pull request" one — is forced
through the single hardcoded output schema `{ category: string, urgency: number }`
(activities.ts comment admits per-node schemas are a later slice). The B5 binding feeds
`{ from: "agent", path: "output" }` (i.e. `{category, urgency}`) as the PR comment
**body**, so the "review comment" is a classification object, not a review.

**Impact:** The headline B5 demo ("agent reviews → comments back") doesn't actually
produce a review. Functionally a placeholder.

**Recommendation:** Per-node output schema (or a free-text mode for review-style agents);
make the binding produce a string body.

---

### 10. (S3) Unbounded growth of dedupe + OAuth-state rows
**Where:** `webhook.service.ts:isDuplicateDelivery` (`WebhookDelivery` rows),
`oauth.ts:startConsent`/`stateKey` (state rows written into `TenantCredential`).
**Observed:** Every webhook delivery writes a permanent `WebhookDelivery` row; every
abandoned OAuth consent leaves a `oauth-state:*` secret row (`isValid: true`) forever.
Neither is ever pruned, and the "expired state" message in `completeConsent` has no TTL
behind it.

**Impact:** Tables grow without bound; stale OAuth-state secrets linger indefinitely.

**Recommendation:** Add a TTL/cleanup job (or `createdAt`-based purge) for both, and
enforce a real expiry on OAuth state.

---

### 11. (S3) `GET /executions/:id` 500s for unknown/terminated runs
**Where:** `executions.service.ts:getState` → `getHandle(id).query(stateQuery)`.
**Observed:** Querying a non-existent or closed workflow throws and surfaces as a 500
(the README even documents a 500 while the worker is down). There is no mapping to 404
for "no such execution".

**Impact:** Clients can't distinguish "not found" from "server error"; noisy 500s.

**Recommendation:** Catch `WorkflowNotFoundError` → 404; consider a fallback to
`describe()` for closed runs so a completed run is still queryable.

---

### 12. (S4) `POST /executions` cannot accept real input
**Where:** `executions.service.ts:start` hardcodes
`{ message: "I was charged twice this month" }`.
**Observed:** The manual start endpoint accepts only `{ tenantId }`; the actual workflow
input is a fixed demo string. There's no way to start a run with real data via the API.

**Impact:** Demo-only ergonomics; fine for the current slice but a missing product
capability.

**Recommendation:** Accept an optional `input` in the body and pass it through.

---

### 13. (S4) Spend aggregation reads all rows into memory
**Where:** `packages/usage/src/spend.ts:monthToDateSpend`,
`apps/api/src/usage/usage.service.ts:getUsage`.
**Observed:** Both `findMany` then sum/group in JS rather than using Prisma
`aggregate`/`groupBy`. Fine at low volume; for a busy tenant the month-to-date sum (run
on **every** pre-flight check inside the agent activity) loads the whole month of rows
each call.

**Impact:** Latency/memory growth on the hot path as the ledger grows.

**Recommendation:** Use `aggregate({ _sum: { costUsd } })` for MTD and `groupBy` for the
by-model rollup.

---

### 14. (S4) Stale schema/comments imply less is built than is
**Where:** `packages/db/prisma/schema.prisma:1` ("Slice #2"), line 19
("graphs are hardcoded for now").
**Observed:** The schema header and comments predate Slices #3–#4 (budgets, connections,
webhooks all present in the same file). Harmless but misleading during review/onboarding.

**Recommendation:** Refresh the header/comments to reflect current scope.

---

## Things verified as correct (no action)

These were checked and look right — noted so the report isn't read as "all bad":

- **Secrets never enter Temporal:** keys/tokens are fetched inside activities by
  `tenantId`/`connectionId`; `workflows.ts` imports activities **type-only**; only
  non-secret config flows through workflow args. (`workflows.ts`, `activities.ts`.)
- **`.env` is git-ignored** (only `.env.example` is tracked); `ENCRYPTION_KEY` is required
  at boot and never logged. (`crypto.ts:createKeyEncryptor`, `.gitignore`.)
- **AES-256-GCM** with a 12-byte random IV per message and auth-tag tamper detection;
  32-byte key length enforced. (`crypto.ts`.)
- **Webhook HMAC** verification is over the raw body, length-guarded, timing-safe; dedupe
  happens *after* signature verification; Atlassian fails closed. (`webhook.service.ts`,
  `hooks.controller.ts`.)
- **Billing fail-safe:** undefined provider usage falls back to a non-zero estimate
  rather than recording zero; `totalUsage` is preferred over `usage`. (`activities.ts`.)
- **Error mapping:** `401/403/429`, missing-credential, and MCP needs-reauth map to
  **non-retryable** failures so Temporal doesn't burn retries on a user-fixable problem.
- **Determinism boundary:** per-execution cost cap + step counter use only
  activity-returned costs and `wf.workflowInfo()`; no I/O, `Date.now`, or DB read in
  workflow code. (`workflows.ts`.)
- **OAuth refresh-token rotation** is persisted before the new access token is used, with
  a per-connection in-process lock (its multi-worker limitation is documented). (`oauth.ts`.)
- **`ai` is pinned exact** (`6.0.210`) in both `apps/worker` and `packages/secrets`, per
  the usage-undefined bug rationale.

## Suggested priority order

1. **#1 auth/tenant isolation** (blocks any real multi-tenant deployment).
2. **#3 + #6 retry/idempotency + downgrade pricing** (live money bugs).
3. **#2 cached-token billing** (verify + fix).
4. **#4 input validation** (cheap, removes the approve→reject footgun).
5. Remaining S3/S4 as cleanup.
