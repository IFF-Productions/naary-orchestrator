# Design — The Items Model (per-item fan-out)

**Status:** proposed · **Date:** 2026-07-09
**Prereq reading:** `N8N-PARITY-GAPS.md` §6.1 (this is that deferred item, specced).
**Owner risk it retires:** per-item AI enrichment + the authoring feel the market expects.

---

## 1. The gap, precisely

n8n's spine is that **every connection carries an array of items** (`[{ json, binary }, …]`)
and **most nodes run once per item automatically** (an implicit map). "Fetch 100 rows → call an
LLM on each → write each back" is the default shape, with no explicit loop.

naary today passes **one object per edge** (`ctx = { nodeId: output }`); per-item work is explicit
via the `forEach` node (which starts a child run per item). That's correct and durable, but it's a
different authoring model and it makes the common "map an agent over N rows" case a sub-workflow
instead of a one-liner.

This doc specs adopting an items model **without** breaking Tier-1 (interpreter-not-codegen,
determinism, side-effects-in-activities) and **without** a big-bang rewrite of the 40+ existing
nodes.

## 2. Design — items as an interpreter concern, not a node

### 2.1 Data shape (additive, back-compatible)
- An edge value is normalized to `Item[]` where `Item = { json: Record<string, unknown>, binary?: BinaryRef }`.
- **COEXIST (decided — the hinge of the whole program):** `ctx[nodeId]` (a node's raw output)
  CONTINUES to exist and stays the source of truth for every existing read — `getByPath(ctx[from],
  path)`, edge conditions, bindings are **untouched**. The **items view** `items[nodeId]: Item[]`
  is an ADDITIVE projection on top, defined as `items[nodeId] === toItems(ctx[nodeId])`. Because the
  view is derived from `ctx` and never replaces it, no back-compat read ever reconstructs a scalar
  from items — so there is deliberately **no `fromItems`** (its length-collapse would reintroduce the
  wrapped-array-vs-two-item ambiguity this model exists to kill). A legacy single-object output is
  `[{ json: output }]` (one item): **every existing graph keeps working** because one object == a
  one-item array.
- `Item` is minimal — `{ json }` — in Slice 1. `binary` is intentionally NOT modeled yet; when it
  lands it MUST reuse the existing claim-check machinery (`resolveClaimChecks`/`maybeOffload`/the
  object store), so it is defined WITH its consumer, later.
- `binary` never inlines bytes into Temporal history — it's a claim-check reference to object
  storage (reuse the existing payload-offload store). Determinism + the 2MB payload cap are safe.

### 2.2 Per-item execution (implicit map) — in the interpreter
- A node is either **item-wise** (runs once per input item) or **aggregating** (sees all items:
  `merge`, `aggregate`, `filter`, `compareDatasets`, the new `splitOut`/`limit`). A per-node
  `itemMode: "each" | "all"` (defaulted per node type in the registry) declares which.
- For an item-wise **pure** node the interpreter maps `runPureNode` over the items — still pure,
  still deterministic, no activity.
- For an item-wise **activity** node (agent/httpRequest/mcpTool/…), the interpreter dispatches a
  **single batched map-activity** `mapNode(nodeType, cfg, items[])` that loops **inside the
  activity** (all I/O in the activity, per Tier-1 #3) and returns `Item[]`. One activity call per
  node per run — NOT one Temporal activity per item (history stays small; retries/heartbeats are
  per-batch with per-item checkpointing inside).
- Fan-out width is bounded (config `maxParallelItems`, default e.g. 20) inside the activity.

### 2.3 Determinism
- The map order is the input array order (stable). No `Promise.race`/`Math.random` in the
  interpreter. `$now`/timestamps resolve **inside** the map-activity (never in workflow code) —
  same rule as everywhere else.
- Billing: the map-activity sums `totalUsage` across all per-item LLM calls and records ONE usage
  event with the batch's tokens+cost (fail-safe estimate if usage is missing on any item).

## 3. Roadmap — stacked slices

1. **Normalize layer (no behavior change).** ✅ **SHIPPED (Slice 1).** Ships ONLY the normalize
   primitive in `@naary/dsl` — `Item = { json }`, `toItems(value) = [{ json: value }]` (always
   wraps; never splits an array; never auto-detects `Item[]`), and `itemsJson(items)`. **No
   interpreter change** — the `items[nodeId]` view + map-over-items land in Slice 2 behind
   `workflow.patched()`, per the COEXIST contract in §2.1. `fromItems` and `binary` are deliberately
   deferred until they have a consumer (see §2.1). *(Pure plumbing; the whole migration rests on
   the contract, not the two functions.)*
2. **Item-wise pure map.** `itemMode` in the registry; interpreter maps pure item-wise nodes over
   items. `set`/`text`/`if`-per-item become real maps. Tests: 0/1/N items, empty array identity.
3. **Batched map-activity for agent/httpRequest.** `mapNode` activity loops with bounded
   concurrency + per-item checkpoint; one usage event per batch. The headline feature:
   "agent over N rows" with no `forEach`.
4. **Aggregating nodes see all items.** `merge`/`aggregate`/`filter` formalized as `itemMode:"all"`;
   add `splitOut` (one item → N) and `limit`.
5. **Authoring:** the canvas input panel shows the items table; the run view shows per-item
   output + which item failed. (Web-heavy; can trail the engine.)

Out of scope here: the full expression language (own doc), drag-to-map UI, JMESPath.

## 4. Non-negotiables

- The one-object → one-item equivalence MUST hold so existing graphs and the 40+ nodes are
  untouched. Any node not yet `itemMode`-annotated defaults to operating on item 0 (today's
  behavior) — no silent breakage.
- One batched activity per item-wise node per run (never one Temporal activity per item) — protects
  event-history growth and the payload cap.
- Interpreter changes ride `workflow.patched()` so in-flight runs replay deterministically.
- Binary stays a claim-check reference; bytes never enter history.

## 5. Why this is the highest-leverage next program

It's the prerequisite for per-item AI enrichment (the thing agents are *for*) and for the visual
authoring users expect, and it subsumes several parity gaps (`splitOut`, implicit loops, per-item
error routing). It's deliberately sequenced as **normalize → map pure → map activity → aggregate**
so each slice ships green and the risky interpreter change lands last, patched.
