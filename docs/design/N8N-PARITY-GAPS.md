# Design — n8n Feature Parity: Gap Analysis + Roadmap

**Status:** proposed · **Date:** 2026-07-05
**Purpose:** inventory what naary already does, compare against n8n's feature surface,
and sequence the missing capabilities into small, shippable, **stacked** slices. Naary's
differentiator stays constant: **durable, long-running, human-in-the-loop execution on a
Temporal interpreter** — this roadmap closes the *authoring/automation* gap without
compromising Tier-1 rules (interpreter-not-codegen, side-effects-in-activities, determinism).

---

## 1. What naary already has (grounded)

**Nodes (31).** Triggers: `start`, `webhookTrigger`, `pollTrigger`, `errorTrigger`.
AI/tools: `agent`, `mcpTool`. Data sources: `httpRequest`, `sqlQuery`, `sqlExec`,
`rssRead`. Transform (pure): `set` (Edit Fields), `renameKeys`, `filter`, `aggregate`,
`listOps`, `compareDatasets`, `xml`, `dateTime`. Flow: `merge`, `forEach`,
`executeSubWorkflow`, `wait`, `stopAndError`, `respondToWebhook`, `code` (QuickJS),
`humanApproval`. Crypto: `hmac`, `jwt`, `totp`. Comms: `sendEmail`. Terminal: `end`.

**Execution.** One generic Temporal workflow interprets the graph. Branching is
**structured edge conditions** (`eq/neq/in/exists/gt/lt` on a dotted `ctx` path) — pure,
no eval. Fan-out = parallel `Promise.all`; fan-in = `merge`. Loops via back-edges, bounded
by a step circuit-breaker + `continueAsNew`. Human approval = Signal + `condition()`.
Durable timers (`wait`). Per-tenant budget/cost metering. Payload offload for big blobs.
Workflow-level **error-handler graphs** (`ErrorHandler` binding).

**Data model.** A single `ctx = { nodeId: output }` map; nodes read upstream via
**`ArgBinding` (`{from, path}`)** — NOT an `{{ }}` expression language, and NOT n8n's
per-item array model. Deliberate: bindings are safe, deterministic, replay-stable.

**Platform.** Versioned/content-hashed graphs, templates, BYOK credentials, MCP/DB/SMTP
connections, Temporal Schedules (cron), webhooks (HMAC), notifications, audit log,
membership + RBAC (in flight), usage/billing.

## 2. n8n's surface, and where we stand

| n8n capability | naary today | Gap |
|---|---|---|
| Items array model (run once per item) | single-object `ctx` | **Deliberately different** — not adopting; `forEach` covers per-item work |
| Expressions `{{ $json.x }}` | `ArgBinding` (structured) | Partial — no inline transforms; safe by design |
| IF / Switch nodes | edge conditions only | **Missing** dedicated router nodes + rich operators |
| Rich condition operators (contains/regex/…) | 6 basic ops | **Missing** |
| Retry On Fail (per node) | Temporal transient retry only | **Missing** author-facing retry |
| Continue On Fail / error output | workflow-level handler only | **Missing** per-node continue |
| HTTP Request | ✅ `httpRequest` | close (add pagination later) |
| Code (JS) | ✅ `code` (QuickJS) | ✅ |
| Edit Fields / Set | ✅ `set` | ✅ |
| Merge / Aggregate / Sort / Dedupe | ✅ | ✅ |
| HTML Extract (CSS selectors) | — | **Missing** |
| Spreadsheet / CSV | — | **Missing** |
| Text / string manipulation | — (only via `code`) | **Missing** convenience node |
| Crypto / Hash (no-key) | `hmac`/`jwt`/`totp` (key'd) | **Missing** plain hash |
| Split Out (array→items) | `forEach` (child runs) | different model — low priority |
| Sub-workflow / Execute Workflow | ✅ | ✅ |
| Wait (time + webhook resume) | ✅ time; ❌ resume-on-webhook | partial |
| Triggers: manual/webhook/schedule/poll | ✅ | ✅ (form/chat triggers missing) |
| AI Agent + tools | ✅ `agent` + `mcpTool` | ✅ (naary's real strength) |
| Manual step run + pinned data (authoring UX) | — | **Missing** (bigger, web-heavy) |

## 3. The roadmap — stacked slices (each its own PR)

Ordered so each builds on the last (they all touch the same registry files —
`dsl/types.ts`, `branch.ts`, `workflows.ts`, `graph-model.ts`, `CanvasPage.tsx` — so a
**linear stack** avoids constant conflicts). Each slice = full vertical (DSL + interpreter +
web panel + tests), verified by `pnpm build && npx vitest run` + `pnpm -r typecheck`.

1. **Rich branch conditions** — add `gte,lte,contains,notContains,startsWith,endsWith,
   regex,isEmpty,notEmpty` to `EdgeCondition`. Pure; upgrades **all** branching + the
   `filter` node at once + the web condition editor. *(Foundation for Switch.)*
2. **Switch node** — one node, N named rules → outputs `{ matched }`; author routes edges
   on `<id>.matched`. Cleaner than hand-wiring N conditional edges. Pure.
3. **Per-node error handling** — `onError: "stop" | "continue"` (+ `continue` writes
   `{ error }` to `ctx` and proceeds so a graph can branch on it) and author-facing
   `retry: { maxAttempts, waitSeconds }` mapped to the activity's Temporal RetryPolicy.
   Interpreter-level; n8n table-stakes.
4. **HTML Extract node** — CSS-selector extraction (activity; `node-html-parser`). Scraping.
5. **CSV node** — parse (text→rows) / build (rows→text) (activity). Import/export.
6. **Text node** — split/join/replace/upper/lower/trim/substring/regex-extract (pure).
7. **Hash node** — sha256/sha512/md5/base64 of a value, no connection needed (pure/activity).
8. **String-template interpolation** *(stretch)* — safe `{{ nodeId.path }}` interpolation
   into string fields (no eval), as an incremental step toward expressions.

Out of scope here (tracked, larger): the items-array model, a full expression engine,
manual per-node execution + pinned data (authoring UX), form/chat triggers.

## 4. Non-negotiables carried into every slice

- New branching/eval stays **pure structured data** — no `eval`/`new Function` in workflow
  code (regex uses `RegExp`, which is deterministic). Side effects (HTML/CSV parse, hashing
  large inputs) run in **activities**.
- No secrets in node `config` (rides in Temporal history) — keyed material only via
  `connectionId`, resolved in-activity.
- Every slice ships tests that encode the behavior, and updates the three web registries
  (`NODE_KINDS`, `ACCENT`, `LABEL`) + a `ConfigPanel` branch.

---

## 5. Where naary already *leads* n8n (market these, don't rebuild)

Grounded in n8n's own docs — these are structural advantages, not parity items:

- **Unbounded, exponential retries.** n8n caps Retry-On-Fail at **5 tries / 5000 ms wait**
  (hard UI caps). Temporal activity retry policies are unbounded with exponential backoff —
  naary wins by default. *(n8n: build/flow-logic/handle-errors-gracefully)*
- **Durable, multi-day Wait / HITL.** n8n's Wait + Send-and-Wait pause in a way that leans on
  execution records and has queue-mode caveats (its Simple Memory "doesn't work in queue
  mode"). naary's Signal + `condition()` survive worker crashes and wait for days natively.
- **Execution introspection.** Temporal history + graph content-hash snapshot at start already
  give naary the hard half of n8n's "reproduce a past execution in the editor" + version
  history. *(n8n: build/manage-workflows/view-change-history)*
- **Per-tenant usage/cost ledger + budget caps** — a first-class concept n8n lacks.

## 6. The real competitive gate (bigger, sequenced later)

n8n's stickiness comes from two coupled things this roadmap deliberately defers because they
are architectural, not a node:

1. **The items model** — every edge carries an *array of items* (`{json, binary}`), and nodes
   run **once per item automatically** (implicit map). This is the spine of both n8n's runtime
   and its authoring feel. naary passes one object per edge; adopting items is a deliberate
   interpreter decision (with a batched map-activity), not a slice.
   *(n8n: build/work-with-data/understand-n8ns-data-structure)*
2. **Expressions + live-preview editor + drag-to-map** — `{{ $json.x }}` over the items, a
   `$`-variable set, a rich per-type method library (String/Array/Object/DateTime), JMESPath,
   and a drag-from-input-panel mapper. Determinism constraint: `$now`/`Date.now()` must
   resolve **in an activity / at execution start**, never live in workflow code (Tier-1 #2).
   *(n8n: build/work-with-data/transform-data/expression-reference)*

The node slices in §3 stand on their own value **without** these, but items+expressions are
the prerequisite for per-item AI enrichment and the visual authoring the market expects; they
warrant their own design doc before any code.

## 7. Sourced gap ranking (n8n docs → naary)

Build-now (self-contained, high value, in this roadmap) vs. Defer (architectural / web-heavy):

| # | n8n capability | naary | Plan |
|---|---|---|---|
| 1 | Items model + per-item fan-out | one object/edge | **Defer** (own doc) |
| 2 | Expression lang + live editor + drag-map | `ArgBinding` pickers | **Defer** (own doc) |
| 3 | Rich condition operators | 6 → **15** ✅ | **Slice 1 (done)** |
| 4 | IF / Switch / rich control-flow nodes | edge conditions | **Slice 2 (Switch)** |
| 5 | Per-node retry + continue-via-error-output | activity-retry only | **Slice 3** (naary can beat n8n's caps) |
| 6 | HTML Extract (CSS selectors) | — | **Slice 4** |
| 7 | CSV / Spreadsheet | — | **Slice 5** |
| 8 | Text / string + Hash convenience nodes | via `code` | **Slices 6–7** |
| 9 | Single-node exec + data pinning + NDV | — | **Defer** (authoring-UX doc) |
| 10 | Executions list: Waiting filter, Retry, reproduce | partial | **Defer** (leverages Temporal) |
| 11 | Schedule/Cron **trigger node** | workflow-level Schedules | **Defer** (expose as node) |
| 12 | Vector store / RAG (PGVector) + chat trigger | agent + MCP | **Defer** (AI doc) |

*Citations:* all paths under `https://docs.n8n.io/` (2026 docs tree): `build/work-with-data/*`,
`build/flow-logic/handle-errors-gracefully`, `integrations/builtin/core-nodes/*` (if/switch/
merge/splitinbatches/html/httprequest), `integrations/builtin/trigger-nodes/*`,
`build/manage-workflows/view-change-history`.
