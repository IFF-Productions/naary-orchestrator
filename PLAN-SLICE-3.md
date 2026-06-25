# PLAN.md — Vertical Slice #3: Budget Enforcement & Circuit Breaking

> **For the executing agent:** Builds on Slice #1 (durable interpreter + approval) and
> Slice #2 (real agent + BYOK + usage ledger). Do not rebuild those. One task at a
> time, in order; verify before moving on. Stay in plan mode until approved.

## 1. Purpose

Slice #2 *records* spend. This slice *enforces* it: stop an execution before it
spends money a tenant doesn't have, and stop a runaway agent loop before it burns a
fortune. Three mechanisms:

1. **Pre-flight cost check** — estimate a call's cost before making it; reject or
   downgrade if it would exceed the tenant's budget.
2. **Per-execution cost cap** — the workflow tracks cumulative spend across nodes and
   halts when a single run exceeds its cap.
3. **Circuit breaker** — a max-step / max-agent-call counter halts runaway loops.

## 2. Scope

**In scope:**
- `tenant_budgets` table + a budget service (get/set).
- A token-estimation utility (pre-call) reusing Slice #2's fallback estimator.
- Pre-flight budget check inside the agent activity, with a configurable
  `onBudgetExceeded` policy: `'reject'` (non-retryable failure) or `'downgrade'`
  (swap to a cheaper configured fallback model).
- Per-execution cumulative-cost cap + max-step counter in the **workflow** (this is
  deterministic — it sums the `costUsd` each agent activity *returns*).
- API to view budget + remaining, and an execution status that reflects a budget stop.

**Explicitly OUT of scope:**
- No atomic budget *reservation* / locking. Pre-flight uses month-to-date spend, which
  is eventually consistent — concurrent runs for one tenant can briefly overshoot.
  Acceptable for this slice; true reservation is noted in §8.
- No usage-based invoicing/billing of the tenant (we're not charging them; we cap them).
- No alerting/notifications on threshold (next slice).
- No MCP, no canvas, still linear graph.

## 3. Architecture constraints (in addition to CLAUDE.md)

- **Pre-flight estimate is I/O (reads the ledger) → stays in the activity.**
- **Cumulative-cost enforcement is deterministic → lives in the workflow**, driven
  only by `costUsd` values returned from activities (never by a fresh DB read in
  workflow code).
- **A budget stop is a clean terminal state**, not a crash: status `budget_exceeded`
  or `circuit_open`, returned normally so the execution history stays tidy.

## 4. Data model

```prisma
model TenantBudget {
  id                String  @id @default(uuid())
  tenantId          String  @unique
  monthlyCapUsd     Decimal @db.Decimal(12, 2)
  perExecutionCapUsd Decimal @db.Decimal(12, 2)
  maxStepsPerRun    Int     @default(50)   // circuit breaker
  onBudgetExceeded  String  @default("reject") // 'reject' | 'downgrade'
  fallbackModel     String?                 // used when policy = 'downgrade'
}
```

## 5. Tasks

### Task 0 — Budget table + service
- `tenant_budgets` (above), migration, `budget.service.ts` (get/set), and
  `GET/PUT /tenants/:id/budget`.
- **Verify:** set a budget via API, read it back.

### Task 1 — Month-to-date spend + estimate
- **Files:** `src/usage/spend.ts`. `monthToDateSpend(tenantId): Promise<number>`
  (sum `usage_events.costUsd` for the current calendar month). `estimateCallCost(cfg,
  input)`: estimate input tokens (reuse Slice #2 estimator), assume a configured max
  output, run through Slice #2's `computeCost`.
- **Verify:** unit test — MTD sum matches seeded rows; estimate is non-zero and uses
  the pricing table.

### Task 2 — Pre-flight check in the agent activity
- Before the LLM call in `runAgent`: `if (mtdSpend + estimate > monthlyCap)` apply
  policy:
  - `'reject'` → `ApplicationFailure.nonRetryable('Monthly budget exceeded','BUDGET')`.
  - `'downgrade'` → switch `cfg.model` to `fallbackModel` and proceed (record which
    model actually ran).
- **Verify:** integration test — tenant near cap with `reject` fails non-retryably and
  records no charge; with `downgrade`, the call runs on the fallback model and the
  `UsageEvent` shows the fallback.

### Task 3 — Per-execution cap + circuit breaker (workflow)
- In `runGraph`, accumulate `ctx.__costUsd += result.costUsd` from each agent activity,
  and increment a `stepCount`. Before dispatching the next agent node:
  - if `__costUsd >= perExecutionCapUsd` → return `{ status: 'budget_exceeded', ctx }`.
  - if `stepCount >= maxStepsPerRun` → return `{ status: 'circuit_open', ctx }`.
- The agent activity must **return** its `costUsd` (add it to the activity result) so
  the workflow can accumulate deterministically.
- **Verify:** test with a low per-execution cap halts mid-flow with `budget_exceeded`;
  a graph that would exceed `maxStepsPerRun` halts with `circuit_open`. Confirm both
  are returned as terminal states, not thrown.

### Task 4 — Surface budget state
- `GET /tenants/:id/budget` returns `{ monthlyCapUsd, mtdSpendUsd, remainingUsd,
  perExecutionCapUsd, maxStepsPerRun, policy }`.
- `GET /executions/:id` reflects a `budget_exceeded` / `circuit_open` status.
- **Verify:** after a capped run, the budget endpoint shows reduced remaining and the
  execution shows the stop reason.

### Task 5 — Docs & honesty
- README: document the eventual-consistency limitation (pre-flight reads MTD spend; no
  locking, so concurrent runs can briefly overshoot the monthly cap), and that the
  pre-flight figure is an *estimate* — the recorded `UsageEvent` is the actual.
- **Verify:** the limitation is documented; `npm test` green.

## 6. Definition of done
- [ ] A tenant over their monthly cap is stopped pre-flight (reject) or downgraded.
- [ ] A single execution stops cleanly at its per-execution cap.
- [ ] A runaway loop is stopped by the max-step circuit breaker.
- [ ] Budget stops are terminal statuses, not exceptions; history stays clean.
- [ ] The budget endpoint shows accurate MTD spend and remaining.
- [ ] Cumulative enforcement reads only activity-returned costs (no DB read in workflow).

## 7. Verification philosophy
Show evidence: tests for each stop condition, the budget endpoint before/after a run.
Review subagent checks against this plan — correctness, the determinism boundary, and
the documented limitations only.

## 8. Next slices (context only — do NOT build now)
1. **Atomic budget reservation** — reserve estimated cost before the call, reconcile
   after, to remove the concurrent-overshoot window (DB transaction or a per-tenant
   Temporal entity workflow as a serialization point).
2. **Threshold alerting** — notify at 80%/100% of cap.
3. **MCP tool nodes**, **multi-model routing**, **graph from Postgres**, **canvas** (as before).
