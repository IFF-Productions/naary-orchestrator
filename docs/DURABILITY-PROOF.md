# Durability proof: scenario → guarantee → evidence

Naary's engine claim is **durable, long-running, human-in-the-loop execution** — runs that pause for
days and survive crashes. This page is the evidence for that claim: each row names a fault, the
guarantee we make under it, and the automated test that demonstrates it.

Everything listed here runs in CI on every pull request (`pnpm test`, GitHub Actions workflow
`.github/workflows/ci.yml`, step _"Test (build + vitest, incl. determinism replay + pause/resume)"_).
No row is a manual runbook step and none is skipped by default.

Source of the claims: issue #577 (durability proof suite) and issue #681 (bounding event history via
`continueAsNew`).

## How these tests work (and what they do not prove)

The scenarios run the **real** graph interpreter (`runGraph`) inside Temporal's
`TestWorkflowEnvironment`, with I/O activities mocked so the suite is hermetic (no LLM keys, no
Postgres, no network). Two things follow from that, stated plainly:

- **"Worker killed" means the worker is shut down and a NEW worker rebuilds the run from history
  alone.** `worker.runUntil(...)` stops the worker and discards its in-memory state; a second
  `Worker.create(...)` then has to replay the workflow's event history to continue. That is the same
  recovery path a `SIGKILL`, an OOM kill or a rolling redeploy takes, but it is **not** an OS-level
  kill: same process, no signal handling, and the Temporal server runs in-process rather than as a
  separate cluster. Multi-process/host-level kill remains a manual runbook exercise.
- **The 30-day scenarios use Temporal's time-skipping test server**, so the workflow's own clock
  advances a month while the test takes milliseconds. The tests assert the recorded timer really is
  `2592000s` / `720h` of workflow time, so the durations are not scaled-down stand-ins.
- **A signal arriving in the instant between a `continueAsNew` command being emitted and the server
  committing it** is handled by the Temporal server (the workflow task is failed and retried so the
  signal is delivered to the continued run). That is server behavior we rely on, not something these
  tests can trigger deterministically — so it is documented here rather than asserted.

## Scenarios

| # | Fault injected | Guarantee | Evidence (test name) |
|---|---|---|---|
| 1 | Worker shut down while a run is parked on `humanApproval`; the decision Signal is then delivered **with zero workers running**; a fresh worker takes over | The pause is server-side state, not worker memory. The decision is never lost, and a new worker resumes to the correct terminal state with the reviewer's comment intact | `worker KILLED mid-humanApproval wait, signal delivered with NO worker running, second worker resumes to completed` |
| 2 | Worker shut down **after** a billed activity completed but before the run finished — twice, so the run is replayed by two successive workers | The billed activity **function executed exactly once** (asserted directly by counting its invocations), because a completed activity's result is served from history on replay rather than re-run — so the run's accumulated cost is charged once, and is neither doubled nor zero (Tier-1 rule 6). This counts activity executions in-process; it is not a diff of a ledger table | `crash AFTER a billed activity completed but BEFORE the run finished: replay re-reads the result, so no double-charge and no zero-charge` |
| 3 | A wait-webhook **resume Signal arrives while the run is parked elsewhere**, then the run crosses a `continueAsNew` boundary before reaching the gate that consumes it | A Signal that has arrived but not yet been consumed survives the boundary — it is carried in the snapshot, not dropped (the pre-#681 bug: the run then waited forever) | `a wait-webhook RESUME signal pending at the boundary is CARRIED across continueAsNew, not dropped` |
| 4 | An **approval decision arrives early** and is still pending when the run reaches a `continueAsNew` boundary | The boundary is no longer blocked by a pending decision (which used to mean unbounded history growth), and the downstream gate still finds the decision | `an APPROVAL signal pending at the boundary no longer BLOCKS continueAsNew and survives it (patched: can-carry-signals-v1)` |
| 5 | A `respondToWebhook` reply is produced, then the run crosses a `continueAsNew` boundary | The synchronous reply the ingress polls (and a child run's `RunGraphResult.reply`) survives the boundary — queries by workflow id hit the continued run | `a respondToWebhook reply produced BEFORE the boundary is still readable after it (the ingress polls the latest run)` |
| 6 | A run whose accumulated `ctx` (~1.4 MB of node outputs) would push the `continueAsNew` payload toward Temporal's ~2 MB cap | The largest outputs are claim-checked to object storage and carried as references; the run continues and completes instead of failing on the payload cap. The offload is the minimum set that fits, and each reference still resolves to the original value | `an OVERSIZED ctx is claim-checked at the boundary (patched: can-claim-check-v1) so the snapshot stays under the ~2MB payload cap` |
| 7 | An ordinary run crosses a `continueAsNew` boundary on the current interpreter | The common path is byte-identical to the pre-#681 interpreter: no offload activity, neither `patched()` marker recorded, and every segment replays cleanly. This is what makes deploying the change safe for in-flight runs (Tier-1 rule 2) | `REPLAY INVARIANT: an ordinary small-ctx run crosses the boundary with NO new commands (no offloadCtxEntry, no patch marker) and its history replays` |
| 8 | A **30-day** durable wait mid-run (time-skipped) | The run sleeps for a month on a durable timer, resumes, and completes with the spend it accrued **before** the wait intact — the budget/ledger is not reset by the pause | `a 30-DAY wait node resumes and completes with the pre-wait spend intact (budget/ledger not reset)` |
| 9 | A **30-day approval SLA reminder** (time-skipped) | The reminder fires on a real 720-hour durable timer via the notification activity, and the gate is still decidable after it — a month-long human wait is a normal state, not a stuck one | `a 30-day approval SLA reminder fires on its durable timer, and the gate is still decidable afterwards` |
| 10 | Every scenario above, re-run through `Worker.runReplayHistory` — including **each segment** of a run that continued as new | Determinism: the recorded history of every scenario replays against the current interpreter with no non-determinism error | asserted inside each test (`replayAll` / `runReplayHistory`) |

All of the above live in `apps/worker/test/chaos-durability.e2e.spec.ts`.

### Supporting coverage (pre-existing, same suite)

| Property | Evidence |
|---|---|
| Durable pause → Signal → resume, auto-reject timer, reminder/escalation timers, budget pause-and-resume, and their history replays | `apps/worker/test/interpreter-pause-resume.e2e.spec.ts` |
| Long/looping run bounded by `continueAsNew` with `stepCount` carried across the boundary | `apps/worker/test/branching.e2e.spec.ts` — `loops bounded by the circuit breaker, surviving continueAsNew with stepCount intact` |
| Per-item diagnostics survive a `continueAsNew` boundary | `apps/worker/test/interpreter-items.e2e.spec.ts` — `A5-trace: __regionTrace SURVIVES continueAsNew` |
| Billing never records zero when the provider omits usage (the other half of rule 6) | `apps/worker/test/agent.activity.spec.ts` — `records a non-zero FALLBACK estimate when the provider omits usage` |
| Claim-check planner + offload activity (unit level, incl. the deterministic largest-first plan) | `apps/worker/test/items-claim-check.spec.ts` |

## Known limits (fail closed, not silently)

Stated here because a proof page that only lists wins is not a proof page.

- **Workflow-side readability of an offloaded output.** When scenario 6's offload triggers, that node
  output becomes a reference. Activities rehydrate references transparently, but expressions and edge
  conditions evaluated in workflow code cannot read *into* one, so `{{ bigNode.body.status }}` would
  resolve to `undefined` after the boundary. The offload therefore only engages when the snapshot
  would otherwise be near the payload cap (`CAN_CTX_BUDGET_BYTES`), only for entries above
  `CAN_CTX_ENTRY_FLOOR_BYTES`, and only for the smallest number of entries that makes it fit — the
  most recent/smaller outputs conditions usually branch on stay inline. The offloaded ids are recorded
  in `ctx.__offloaded` (ids only, never content) so the effect is visible rather than mysterious.
- **Many small outputs.** If a run's `ctx` exceeds the budget purely through many sub-64 KB entries,
  no offload can shrink it (each would still need its own reference) and the `continueAsNew` fails on
  the payload cap. Same honest limit as the items model's "many small items" case.
- **A single output larger than `CAN_CTX_MAX_OFFLOADABLE_ENTRY_BYTES`** cannot be offloaded, because
  it would exceed the payload cap as the offload activity's own argument. Only a pure workflow-side
  node (`merge`/`aggregate`/`listOps` over several already-large parents) can produce one, since every
  activity output is already claim-checked at 1 MB.
- **A carried Signal keeps the same semantics it has WITHIN a segment — including the sharp edge.** An
  un-consumed decision is consumed by the next gate the walk reaches, so a duplicate approval click can
  satisfy a later gate. That is pre-existing behavior inside a single segment (the value simply lives in
  engine state until something reads it); carrying it makes a run that continues as new behave the same
  as one that does not, rather than introducing a new rule.
- **If the object store is unavailable when an oversized snapshot needs offloading**, the offload
  activity fails, the `continueAsNew` does not happen, and the workflow task retries — the run stalls
  visibly instead of losing state. Continuing without the offload would fail on the payload cap anyway.
- **`continueAsNew` happens between node executions, never mid-node.** A run parked on a
  `humanApproval` gate does not continue as new while it waits. That is safe because a gate's history
  growth is bounded by its configuration (a finite `remindAfterHours` list plus at most one
  escalation), not by how long the human takes — so a 90-day pause costs a handful of timer events,
  not an unbounded stream.
- **Postgres availability during a pause** is not covered by an automated scenario. Temporal owns
  execution state, and the read-model writes that touch Postgres are best-effort, but the "Postgres
  briefly down" case from issue #577 remains manual.
