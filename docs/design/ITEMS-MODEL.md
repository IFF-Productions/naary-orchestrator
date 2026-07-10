# Design — The Items Model (per-item fan-out)

**Status:** proposed · **Slice 1 shipped (#206); Slice 2+ BLOCKED on the §0 architecture decision.**
**Date:** 2026-07-09 (§0 added after the Slice-2 architecture review)
**Prereq reading:** `N8N-PARITY-GAPS.md` §6.1 (this is that deferred item, specced).
**Owner risk it retires:** per-item AI enrichment + the authoring feel the market expects.

---

## 0. Architecture finding — the original slice plan (§3.2) is unsound as written

Reviewing Slice 2 surfaced two things that invalidate the "map pure item-wise nodes over items"
step and must be decided **before** any `execNode` change (an interpreter change is frozen for all
in-flight runs by `workflow.patched()` — we cannot quietly fix mapping semantics later):

1. **Items-authoritative INVERTS Slice 1's contract.** Slice 1 (#206) pinned
   `items[nodeId] === toItems(ctx[nodeId])` — ctx is source of truth, items derived. But the moment a
   producer (`splitOut`) emits N>1 items, `toItems(ctx)` (always length 1) can't represent them, so
   the model must flip to **items-authoritative**: `items[nodeId]` is primary and `ctx[nodeId]` for
   legacy binding reads becomes `items[nodeId][0].json` (n8n's "expressions default to the first
   item"). That is a clean rule, but it is a **replacement** of §2.1, not an extension — adopting it
   requires rewriting §2.1 in the same PR so the tree doesn't carry two contradictory contracts.

2. **"Map over the incoming edge's source" is the WRONG AXIS.** naary decouples control-flow edges
   from data: a node's inputs come from config `from` **bindings** that can reference *any* prior
   node, not its edge predecessor. A `set` (edit-fields) node reads MANY bindings — so an
   edge-based "single input" rule would push the node n8n most wants per-item into the run-once
   bucket. Honest implicit per-item therefore requires a **current-item execution context**: inside
   a mapped region, iteration `i` must make EVERY `getByPath(ctx[from], path)` read resolve to
   `items[from][i].json` (and `resolveTemplates` likewise). naary has only a global `ctx` and no
   such cursor — introducing one is a pervasive change to the whole resolution layer, not a slice.

**Relevant context:** naary already has `forEach` (a child run per array item) + the array nodes
(`listOps`/`aggregate`/`filter`/`compareDatasets`), which already cover "process each element of an
array" — just not with n8n's *implicit* per-node fan-out authoring feel.

### The decision — **(A) CHOSEN.** Detailed design: `ITEMS-MODEL-CURRENT-ITEM.md`.
The full current-item model, designed there via **cardinality + lineage propagation** (no region
detection): a fourth `"reducer"` mode so `split→filter→map` works, and cross-lineage zip that
**fails closed** rather than positionally pairing independent lists. Options B/C below are recorded
for context but not taken.
- **(A) Full current-item model.** Introduce the per-item execution context (item-index resolution
  through bindings). Faithful to n8n; large, invasive, highest frozen-by-patched risk — hence the
  dedicated design doc, reviewed before any `execNode` change.
- **(B) Explicit items construct.** Ship items as an explicit array capability — `splitOut`
  (array→items) feeding an explicit map region — *without* claiming every node auto-maps. Smaller,
  but overlaps heavily with the existing `forEach`.
- **(C) Stop; lean on `forEach` + array nodes.** Conclude the implicit-items model is a poor fit for
  naary's binding architecture and NOT worth freezing a deep interpreter semantic; keep Slice 1's
  primitive as latent groundwork and de-prioritize the rest. Market the durable per-item strengths
  naary already has.

§§2–3 below are the ORIGINAL plan; they stand only under decision (A) and are superseded by this
section until (A) is explicitly chosen and re-specced.

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
