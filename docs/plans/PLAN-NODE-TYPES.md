# PLAN — Node Types Roadmap (closing the n8n core-node gap)

Prioritized plan for adding the missing **core node types** to the interpreter. The
gap analysis lives in `docs/n8n-node-types.ts` (67 n8n core nodes mapped to our 8 DSL
node types; **3 covered / 7 partial / 47 gaps / 10 n-a**). This doc turns the 47 gaps
into ordered, vertical slices.

> Source of truth for the list: `docs/n8n-node-types.ts` (the exact complement of the
> 240 app integrations in `docs/n8n-integration-catalog.ts`). Update `coverage` there
> as each slice lands.

---

## Two node shapes (which pattern a slice uses)

Every new node type is one of two shapes. Picking the right one is the first design
decision of each slice.

1. **Pure deterministic node** — no I/O, no secrets. Runs entirely in the interpreter
   (a `case` in `execNode` that reads/writes `ctx`), like `webhookTrigger`. Reuses the
   binding infra (`getByPath`, `ArgBinding`, a pure `resolve*` function in
   `packages/dsl/src`). **No activity.** Most data-transformation nodes are this shape.
   Cheapest, safest slices.

2. **Side-effecting node** — sibling of `mcpTool`/`httpRequest`/`sqlQuery`. DSL type +
   `*NodeConfig` + pure resolver in the interpreter; the actual I/O is an **activity**
   in `apps/worker/src/temporal/activities.ts`. Reuses `assertEgressAllowed` (SSRF),
   connection secrets (`@naary/connections`), `maybeOffload`/`resolveClaimChecks`
   (`@naary/storage`, 2 MB cap), `toSanitizedRetryable`. Secrets resolve in-activity by
   `connectionId` — never in `config` (rides in Temporal history).

**Add-a-node-type checklist** (both shapes):
`NodeType` union + `*NodeConfig` in `packages/dsl/src/types.ts` → pure `resolve*` in
`packages/dsl/src` (if it takes bindings) → export from `packages/dsl/src/index.ts` →
`case` in `execNode` (`apps/worker/src/temporal/workflows.ts`) [+ activity if shape 2]
→ web: `NODE_KINDS` + the `Record<NodeType,…>` accent maps + a `ConfigPanel` branch
(`apps/web/src`) → `pnpm build && npx vitest run` + `pnpm -r run typecheck`.

---

## Out of scope (deliberate non-goals — not "gaps" to close)

These are marked `gap` in the data but are **architectural non-goals**; leaving them out
is a decision, not a backlog omission:

- **Execute Command (`ExecuteCommand`) / SSH (`Ssh`)** — arbitrary shell/remote exec on
  the worker. Conflicts with stateless, sandboxed activities. Not planned.
- **Local-disk file nodes** (`Files`, `Read/WriteBinaryFile`, `LocalFileTrigger`) — a
  disposable cloud worker has no durable local FS. File *content* work is fine (Tier 3
  below) but it flows through object storage, not disk.
- **Inline Code node (`Code`/`Function`/`FunctionItem`)** — arbitrary user JS. Cannot go
  in workflow code (determinism, Tier-1 §2). *If* built, it's a **sandboxed activity**
  (isolated-vm/worker) with no ambient network/FS — a large slice, parked until demanded.
- **`na` nodes (10)** — n8n-internal/training/editor-only (`StickyNote`, `DebugHelper`,
  `Simulate`, training nodes). No runtime meaning for us.

Write-capable SQL stays out too (see `sql-node-engine-backlog` — needs an idempotency-key
design because Temporal retries would double-apply).

---

## Slices (in order)

Each slice is one PR, one vertical slice, its own verification. Don't build ahead.

### Tier 1 — Control flow + data shaping (unlocks real workflows)

- **Slice N1 — `set` (Edit Fields).** *Pure node.* Build a JSON object from static values
  + `ArgBinding`s (reuse `getByPath`/`setByPath`). The single most-used n8n node; nothing
  today reshapes data between nodes. Establishes the pure-transform pattern. **First slice.**
- **Slice N2 — `executeSubWorkflow`.** *Side-effecting-ish.* Start/await a child `runGraph`
  by saved-graph key (Temporal child workflow). Highest-leverage composability primitive.
  Must snapshot the child graph version (same as top-level) and meter child cost into the
  parent budget. Larger slice — do after N1 proves the flow.
- **Slice N3 — `stopAndError`.** *Pure node.* Terminal node that ends the run as `failed`
  with a message (mirrors the existing `rejected` terminal path in `execNode`). Tiny.
- **Slice N4 — `wait` (timed delay).** *Pure/timer.* Durable `sleep`/timer via Temporal
  (not a busy-loop). We have durable *approval* waits; this adds an unconditional delay.
- **Slice N5 — `merge`.** *Pure node.* Join multiple upstream branches into one output
  (append / by-key / combine). Requires the interpreter to await multiple parents — check
  how `nextNodes`/fan-in behaves first; may need a join-readiness rule.
- **Slice N6 — `filter`.** *Pure node.* Drop/keep by a structured predicate (reuse
  `EdgeCondition`'s op set). Note: single-value routing is already edges; this is for
  when we add item-collections (see N7).

### Tier 2 — Triggers + more transforms

- **Slice N7 — `scheduleTrigger`.** *Control-plane.* Time-based start via a **Temporal
  Schedule** (owned by the API/control plane, not workflow code). Collapses n8n's
  `Schedule`/`Cron`/`Interval` into one. Touches api scheduling, not just the interpreter.
- **Slice N8 — transform helpers.** *Pure nodes*, likely one small slice each or a couple
  grouped: `dateTime`, `renameKeys`, `html`/`htmlExtract`, `xml`, `markdown`,
  `itemLists` (split-out/aggregate — depends on an item-collection model), `compareDatasets`.
- **Slice N9 — `sendEmail` (SMTP).** *Side-effecting.* Outbound email via a `smtp`
  connection (secret in-activity). Or defer in favor of an MCP/HTTP email provider.
- **Slice N10 — `rssRead`.** *Side-effecting.* Fetch+parse a feed (egress-guarded, like
  httpRequest). Small.
- **Slice N11 — `respondToWebhook`.** *Interpreter + api.* Synchronous response for a
  webhook-triggered run. Only meaningful once we support sync (request/response) triggers;
  today triggers are fire-and-forget. Sequence after that exists.
- **Slice N12 — crypto helpers.** *Pure nodes.* `crypto` (hash/HMAC), `jwt` (sign/verify),
  `totp`. Deterministic given inputs; keys via connection where needed.

### Tier 3 — Files & binary (needs object-storage plumbing)

All *side-effecting*, all route content through `@naary/storage` (claim-check refs, 2 MB
cap) — never Temporal payloads, never local disk.

- **Slice N13 — `spreadsheetFile`** (CSV/XLSX ⇄ rows).
- **Slice N14 — `readPdf`**, **`editImage`**, **`compression`** (zip/unzip), **`iCalendar`**.

### Parked (revisit on demand)

`code` (sandboxed activity), `graphql` dedicated node (usable today via `httpRequest`),
`aiTransform`/`evaluation` (approximate with `agent` today), `errorTrigger` /
`n8nTrigger` / `workflowTrigger` / `sseTrigger` / `emailReadImap` (event sources — design
once trigger infra generalizes).

---

## Verification (definition of done, per slice)

Per CLAUDE.md: verification is the definition of done. Each slice ships with:
- unit test for the pure `resolve*` (deterministic, table-driven) where applicable;
- an interpreter test that runs a graph through `execNode` and asserts `ctx`;
- `pnpm build && npx vitest run` + `pnpm -r run typecheck` green;
- for side-effecting nodes: the security checklist (no secret in config/history/logs,
  egress guard on resolved targets, connection-picker UI not free-text).
