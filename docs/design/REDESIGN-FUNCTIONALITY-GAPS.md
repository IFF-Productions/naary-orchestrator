# Redesign functionality gaps — backend roadmap

**Status:** roadmap (living doc) · **Source:** the honest-data deviation log from the
full product redesign (PRs #420/#421). Every screen was implemented against the design
comps (`design_handoff_naary_redesign`, mirrored in `_design-reference/redesign/`) under
one rule: *bind only to real APIs; omit or substitute what the backend can't back*.
Each omission below is therefore a comp-specified behavior with no backing today —
i.e. the functionality roadmap the design implies.

Ordering follows the product's three differentiators (durable · human-in-the-loop ·
budget-governed): the HITL cluster first (the design's hero), then the observability
change with the widest leverage, then budgets, then the long tail.

---

## Slice 1 — Approval routing + SLA/escalation (HITL depth) ← **first**

The comps treat approvals as the hero surface; almost everything they show on a gate
beyond title/instructions is missing. Today `ApprovalNodeConfig` =
`{ title?, instructions?, timeoutHours? }` and anyone with the `run` verb can decide.

| Gap (comp) | Change |
|---|---|
| Approvers per gate (`sam@acme.io, @finance-leads`) | `approvers?: { emails?: string[]; groupIds?: string[] }` on the node config (zod, @naary/dsl). Enforced at decide time in `executions.service` approve path: when set, the actor must match an email / be a member of a listed group (owner/admin bypass, consistent with RBAC §4). Tokens: group membership via GroupTokenMember. |
| SLA chips (`SLA 2d` / `due 2h` / `breached`) | `slaHours?: number`. Display-only derivation (due = pausedAt + slaHours) — no timer needed; inbox/run-detail/public page chips switch from age-only to real due-by tones. |
| Reminders (`Reminders sent: 1`, Remind button) | `remindAfterHours?: number[]` → durable Temporal timers **in the interpreter's approval wait** (`condition(decided, nextTimeout)` loop — deterministic, config-snapshot-driven), each firing the existing notification-channel activity with a `reminder` flavor. Manual "Remind now" = API endpoint that invokes the same activity via a Signal. |
| Escalation (`escalates in 20h → @ops-oncall`) | `escalateAfterHours?: number`, `escalateTo?: string` → same timer loop; escalation notification mentions the target. v1 = notify-only (no approver-set mutation). |
| Structured context (`Company / Amount / Stage` card) | `contextFields?: Record<string, string>` (values are expressions) evaluated **in the approval activity** at pause time; stored in the awaiting payload; surfaced in `GET /executions/awaiting`, the inbox detail card, and the public approve page. |
| Public page trust line (`on behalf of Acme · expires in 20h`) | Expose workspace display name + signed-link expiry on the public approval prompt endpoint. |

Touchpoints: `packages/dsl` (schema + registry docs) · `apps/worker` interpreter approval
wait + notification activity flavor · `apps/api` executions approve enforcement +
awaiting payload + public prompt + remind endpoint · web (canvas gate config editor,
approvals inbox chips/routing card, run-detail hero chips, Team routing card reads real
gates, public approve). Determinism: timers only via Temporal APIs; expression eval and
notification sends live in activities (Tier-1 rules).

## Slice 2 — Per-node timing + cost (observability leverage)

One recording change lights up omissions on four screens (Run detail durations/costs,
Observe latency histogram + median KPI, Usage avg-duration widget, canvas cost chips).

- Worker stamps `startedAt`/`finishedAt` per node into execution state (small, bounded
  map keyed by nodeId; survives via the existing state query + curated history).
- Usage events gain `nodeId` (nullable; expand/contract migration) so ledger rollups can
  aggregate per node/per node-type.
- `GET /executions` rows gain `finishedAt`/`durationMs`; insights rollups add
  by-node-type duration + a runs-by-day outcome rollup (fixes the capped-list floors:
  30d counts, throughput series, KPI deltas).
- Persist a failure classification on terminal runs (timeout / upstream 5xx / rate
  limit / budget / rejected) from the error the activity already sees.
- `testNode` returns measured duration + usage (metered like any activity; billing
  fail-safe rules apply).

## Slice 3 — Budget alert + pause-not-fail

- `alertThresholdPct?: number` on budget policy → crossing it (checked at reservation
  time, fail-safe) emits a `budgetThreshold` notification event (see Slice 4 channels).
- Optional `onBudgetExceeded: "pause"`: instead of the terminal `budget_exceeded`, the
  run parks on a durable `condition()` wait ("paused on budget") and a Signal resumes it
  (sent automatically on cap raise / month rollover reconcile). Comp copy ("resume when
  you raise the cap") becomes true; Overview/Usage banners switch from "stopped" to the
  comp's "paused" language.
- Live run spend: expose the run's reserved/spent-so-far in the state query so run
  detail (and later canvas run-watch) can show a real budget meter.

## Slice 4 — Notification channels: email + event matrix

- New `email` channel type (SMTP connection reuse) beside Slack/Teams webhooks.
- Event flags grow beyond `onApprovalPending`/`onRunFailed`: `onBudgetThreshold`,
  `onPromotion` (+ reminder/escalation flavors from Slice 1).
- Settings matrix then renders real per-event × channel toggles (the comp's grid).

## Long tail (ordered, independent)

1. **Templates**: sample-data seeding on install (pre-pinned trigger inputs per
   template) + "Send a test event" action → the comp's teaching loop.
2. **AI builder clarifying turns**: builder-session assistant turns that ask a question
   with structured quick-reply options (schema addition to the session contract).
3. **Hosted chat citations** (RAG nodes already know their sources → reply contract
   gains `citations[]`) + starter-chip config on the chat definition; **hosted form**
   submit response echoes outcome (`needs_approval` / `completed` + run ref) — privacy
   note: only with an explicit per-form opt-in.
4. **Integrations metadata**: per-connection "used by N nodes" (server-computed
   reference counts), webhook delivery metrics (7d calls/health), stored last-4 display
   fragment for credentials, expose `ApiToken.environmentId` (exists in DB, not in API).
5. **Workflows version history**: capture actor + optional message on save (promotes
   already record actor) → comp's "who/when/why" rows.
6. **Team**: member last-active timestamp; actually send invitation emails (needs the
   email channel from Slice 4).
7. **Audit**: stamp `environmentId` on audit events → env chips per the comp.
8. **Canvas run-watch**: animate a real run on the canvas via the existing
   `/api/v1` watch machinery ("Run all" step-through, frontend-only).
9. **Runs list pagination/time-windows** (removes the "N+" floors everywhere).
10. **MCP/Slack apps**: per-env MCP exposure toggle; Slack OAuth app (beyond webhooks)
    — only if product wants them; comps show both.

## Non-goals (comp elements deliberately not planned)

- Fake token-streaming visuals, fabricated logs, or invented risk scores — anything the
  comps show as texture without a truthful data source stays out until the source exists.
- Design's multi-env segmented pair inside screen headers — the shell owns env context.
