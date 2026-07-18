# Queue mode (multi-worker fleet: registry, config, ops)

**Status:** design (doc-first). No schema/code changes land with this doc.
**Scope (from [ROADMAP-ENTERPRISE.md](../ROADMAP-ENTERPRISE.md) §D):** "Horizontal scaling — multiple
worker instances pulling from Temporal task queues (Temporal already supports this; the work is worker
registry/heartbeat, config, and the ops story). Prereq for **Worker view**."

Related: **Worker view** (a later, dependent feature — the UI over the registry this doc designs) and
[OBSERVABILITY](./OBSERVABILITY.md)-style operator surfaces.

---

## 1. The key insight — Temporal already *is* the queue

n8n's "queue mode" swaps its single-process executor for a Redis/BullMQ job queue + separate worker
processes. **We don't need that.** Temporal task queues already are a durable, distributed work queue,
and our workers are already **stateless and disposable** (CLAUDE.md Tier-1 §7 — "state lives in
Temporal, not the worker"). Multiple worker replicas polling the same task queue (`orchestrator`)
**already** scale horizontally: `docker-compose.yml` even says *"scale by raising `replicas` (execution
state lives in Temporal, not here)."*

So **"queue mode" here is not a new queue.** It is the missing layer *around* the already-distributed
fleet: **identity + config + a registry the control plane can see + the ops story.** Building a
second queue in front of Temporal would be redundant and would fight its at-least-once + replay model.

### Non-goals
- **No Redis / BullMQ / custom job queue.** Temporal owns distribution, retries, and durability.
- **No worker-side state.** Workers stay stateless; nothing here makes a worker remember a run.
- **No per-worker routing of specific runs.** Temporal decides which idle worker takes the next task;
  we don't pin runs to workers (that would break failover).

---

## 2. What exists today vs the gaps

**Exists:** one worker binary (`apps/worker/src/worker.ts`) that `Worker.create`s against
`TASK_QUEUE = "orchestrator"` (`@naary/contracts`), runs `runGraph`, emits Prometheus metrics
(`startMetricsServer`) and Sentry traces/logs. Prod rolls it start-first via docker-rollout (scale to
2 → drain old). Horizontal scale already works.

**Gaps (the actual work):**
1. **No worker identity.** `Worker.create` sets no `identity`, so pollers are anonymous — the fleet
   can't be told apart in Temporal or a future Worker view.
2. **No concurrency / capacity config.** No `maxConcurrentActivityTaskExecutions`,
   `maxConcurrentWorkflowTaskExecutions`, or cache sizing — every replica uses SDK defaults with no
   env knob to tune per-box capacity.
3. **No registry / heartbeat.** The control plane has zero view of connected workers → **blocks
   Worker view**.
4. **No explicit graceful-drain config.** The TS SDK drains on SIGTERM by default, but
   `shutdownGraceTime` isn't set, so a deploy could cut in-flight activities short.
5. **Single task queue.** All work (interactive runs *and* long/heavy activities like `codeAgent`)
   shares `orchestrator`, so a burst of heavy activities can starve interactive latency.

---

## 3. Design

### 3.1 Worker identity + capacity config (foundation)
Give every worker a meaningful identity and env-tunable capacity:
- `identity`: `"<hostname>/<pid>/<version>"` (host, pid, the deployed tag). Temporal surfaces this on
  every poller — the cheapest possible registry key, no new plumbing.
- Env knobs (defaults preserve today's behavior):
  `WORKER_MAX_ACTIVITIES` → `maxConcurrentActivityTaskExecutions`,
  `WORKER_MAX_WORKFLOW_TASKS` → `maxConcurrentWorkflowTaskExecutions`,
  `WORKER_MAX_CACHED_WORKFLOWS` → `maxCachedWorkflows`,
  `WORKER_SHUTDOWN_GRACE` → `shutdownGraceTime` (drain window on SIGTERM; align with the deploy's
  rollout wait).

### 3.2 Worker registry — Temporal-native first, heartbeat later
Two sources of "who's in the fleet"; take them in order so the MVP adds **zero worker→API coupling**
(keeps workers stateless + backend-independent):

- **Slice A — Temporal `DescribeTaskQueue` (recommended MVP).** The API asks Temporal directly for the
  pollers on `orchestrator`: each poller carries `identity` + `lastAccessTime` + task-queue *kind*
  (workflow vs activity). Plus `DescribeTaskQueue`'s backlog/add-rate stats give queue depth. This is
  **enough for a first Worker view** — connected workers, their identities, last-poll recency, and
  queue backlog — and needs no new worker code, no DB table, no secret.
- **Slice B — enriched heartbeat (optional, additive).** For metrics Temporal doesn't expose (live
  slot usage, build/version, host resource hints), workers POST a small heartbeat to an
  **internal-only** endpoint every ~15s → a `WorkerHeartbeat` row (identity PK, lastSeen, version,
  slotsUsed/Total, taskQueue). A staleness reaper marks a worker offline after ~3 missed beats. This
  is the ONE place a worker talks to the API; it carries **no tenant data** and **no secrets** (fleet
  telemetry only), and a heartbeat failure must never affect run execution (fire-and-forget).

Decision to make (Q for product/ops): is `DescribeTaskQueue` (Slice A) enough for the first Worker
view, or do we want live slot usage (Slice B) from day one? Recommendation: **ship A, add B when the
Worker view needs richer gauges.**

### 3.3 Per-workload task queues (optional scaling slice)
Split long/heavy activities onto a dedicated queue so they can't starve interactive runs:
- Add `TASK_QUEUE_HEAVY = "orchestrator-heavy"`; route `codeAgent` (and any long activity) there via a
  second `proxyActivities` bound to that queue in the workflow.
- Run a separate worker pool (its own replicas) polling `orchestrator-heavy` with lower concurrency
  and a longer `startToCloseTimeout`. Interactive runs on `orchestrator` keep low latency.
- Determinism-safe: choosing the queue is static per activity (graph data → which proxy), not a
  runtime decision in workflow code. Defer unless heavy-workload starvation is observed.

### 3.4 Worker view (downstream — the dependent feature)
Not built here; this doc fixes its seam:
- **API:** `GET /workers` (owner/admin-gated) → the fleet from §3.2 (identity, kind, lastSeen,
  online/stale, queue backlog + add-rate). Infra-scoped, **not** tenant data.
- **Web:** an operator screen (likely under Settings/Observability) listing workers + queue depth +
  a staleness badge. Its own slice with the design MCP.

### 3.5 Ops story
- **Scale:** raise worker `replicas` (compose) / the deploy's worker count. Stateless → linear, no
  coordination. Document the knob + a rough "N activities per replica" guide from §3.1.
- **Drain on deploy:** docker-rollout is already start-first (new replica healthy → old drained);
  set `WORKER_SHUTDOWN_GRACE` so in-flight activities finish (or Temporal retries them elsewhere —
  at-least-once makes a hard kill safe, but a clean drain avoids needless retries).
- **Health:** the metrics server already provides a liveness surface; add a readiness signal
  (worker polling) if the orchestrator/LB needs it.

---

## 4. Security & Tier-1

- Workers stay **stateless** (Tier-1 §7). Nothing here caches run state on a worker.
- **No secrets in the registry.** Identity = host/pid/version; heartbeat = fleet telemetry only. No
  `tenantId`, no provider keys, no run payloads (Tier-1 §4).
- `GET /workers` is **operator-only** (owner/admin), infra data — never tenant-scoped run content.
- The heartbeat endpoint (Slice B) is **internal** (worker→API on the private network), authenticated
  by a shared internal token, and its failure is non-fatal to execution (fail-open for runs).

---

## 5. Slices (proposed order)

1. **Worker identity + capacity/drain config** (§3.1) — small; makes pollers identifiable + tunable.
2. **Registry read + `GET /workers`** via `DescribeTaskQueue` (§3.2 A) — the MVP fleet view backend.
3. **Worker view UI** (§3.4) — the dependent M feature (design-MCP slice).
4. **Enriched heartbeat** (§3.2 B) — only if the view needs live slot/version gauges.
5. **Per-workload task queues** (§3.3) — only if heavy activities starve interactive latency.

Each slice is independently shippable; 1–2 unblock the Worker view. 4–5 are demand-driven.

## 6. Verification per slice
- Slice 1: worker boots with the identity + env knobs; `DescribeTaskQueue` shows the identity; no
  behavior change at defaults. Scale to 2 replicas locally → both appear as pollers.
- Slice 2: `GET /workers` returns both replicas (unit-test the Temporal→DTO mapping with a mocked
  client; live-check against the dev stack).
- Slice 4: heartbeat row upserts + the reaper marks a killed worker stale; execution unaffected when
  the endpoint is down.
- Slice 5: a heavy activity runs on `orchestrator-heavy`; interactive runs on `orchestrator` keep
  latency under a concurrent heavy burst.
