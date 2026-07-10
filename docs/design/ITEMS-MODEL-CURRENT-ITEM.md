# Design — Items Model (A): the Current-Item Execution Context

**Status:** proposed · **Date:** 2026-07-09
**Decision:** Option **(A)** from `ITEMS-MODEL.md` §0 was chosen — the faithful, implicit per-item
model. This doc is the detailed design that must land + be reviewed **before any `execNode` change**
(an interpreter change is frozen for all in-flight runs by `workflow.patched()`).
**Builds on:** Slice 1 (#206) — `Item`, `toItems`, `itemsJson` in `@naary/dsl`.

---

## 0.1. OPEN (blocks A2) — implicit-inference vs explicit-brackets, a frozen sub-fork

The A2 pre-implementation review surfaced a third silent-corruption landmine and, with it, a fork
inside Option (A) that was never explicitly chosen and that `patched()` freezes forever:

**The landmine.** The `items[nodeId]` cardinality engine needs to know, per node, WHICH prior nodes
it reads (its lineage participation). naary has no such primitive, and a generic heuristic
(deep-walking config for `{from: …}` keys) is *corrupting*: a `set`/`sendEmail` node with a data key
`{from: <address>}` that happens to collide with a node id is falsely marked as participating →
runs N times producing N identical copies → a downstream `aggregate`/`merge` silently sums N copies
instead of 1. Single-lineage fail-closed never fires (one lineage). Under-collection is the mirror
(a real map silently degrades to run-once). A structural guess cannot carry a frozen semantic.

**The fork (pick before A2):**
- **(A-implicit)** Infer participation EXACTLY via ~40 per-node `sourceRefs(config)` functions
  co-located with each resolver (node author declares its binding fields) ∪ `walkForTokens` on the
  RAW config. Faithful to n8n's implicit auto-map feel. Cost: ~40 exact functions + still-subtle
  behavior around loops/back-edges (a node reffing a not-yet-executed node breaks the topological
  lineage assumption) — highest frozen risk; the extractor is the correctness lynchpin.
- **(A-explicit) ← recommended.** The AUTHOR draws the map region: a `splitOut … loopOverItems/collect`
  bracket; the mapped region is the nodes structurally BETWEEN them. This DELETES the extraction /
  inference problem entirely (no `sourceRefs`, no lineage guessing), keeps the exact current-item
  semantics the user picked (every read inside the bracket resolves to item `i`), and is arguably
  MORE n8n-faithful — n8n ships explicit **Split Out** + **Loop Over Items** nodes, not magic. Edges
  are the wrong axis only when *inferred*; when the author *draws* the bracket, the region is
  declared intent.

Until this is decided, A2 is blocked (implementing the inference engine would freeze the landmine).
§§1–8 below assume A-implicit; under A-explicit the cardinality rules stay identical but participation
is the bracket, not inferred, and `sourceRefs`/lineage-guessing is removed wholesale.

## 0.2. CHOSEN — A-explicit brackets. This section is the frozen spec; §§1–8 are superseded.

The user chose **A-explicit** (§0.1). Participation is DRAWN, not inferred, which deletes
`sourceRefs`, lineage-guessing, and all three prior landmines. The cardinality *semantics* (what a
mapped node computes on iteration `i`) are unchanged; only WHICH nodes map changes — from "inferred
from bindings" to "the nodes the author bracketed."

### The two nodes
- **`splitOut`** (region OPENER) — config `{ from, path? }`. Reads an ARRAY from a binding and opens
  a per-item region: on iteration `i`, `ctx[splitOut.id] = array[i]`. (Non-array / empty → the region
  runs 0 times; a non-array value is a save-time validation error.)
- **`loopEnd`** (region CLOSER) — config `{ from }`. Gathers the per-iteration output of the region
  node it binds to (its single incoming edge's source) into an ARRAY: `ctx[loopEnd.id] =
  [out₀, out₁, …]`. After `loopEnd` the run is back to single-value (card 1). Exactly one `loopEnd`
  matches each `splitOut`.

### The region = the drawn subgraph (declared intent, VALIDATED AT SAVE — fail closed there, not at runtime)
The region is the set of nodes on paths from `splitOut` to its matched `loopEnd`. `compileGraph` /
`validateGraph` enforces, at SAVE time (so unsupported shapes are a 400, never a frozen runtime
guess):
1. **Single-entry / single-exit:** every path into the region passes through `splitOut`; every path
   out passes through `loopEnd`. No edge crosses the region boundary bypassing the markers.
2. **No nesting (v1):** a region contains no other `splitOut`/`loopEnd`. Nested maps are a later
   slice; drawn nesting is rejected now.
3. **An outside node reading a region node resolves to the FIRST item** (items-authoritative §2 —
   `ctx[regionNode]` is restored to its iteration-0 projection after the loop). This is defined,
   non-corrupting behavior, so it is NOT rejected (A-explicit deleted binding inspection); it is the
   n8n "expressions default to the first item" rule applied to a region node read from outside.
   Conditional edges INSIDE a region, and a `loopEnd` fan-out (≥2 out-edges), ARE rejected at save
   (the body runs unconditionally per item; the loop resumes via a single exit edge).
4. **Pure nodes only inside a region (A2).** A region runs N times, so a durable/control node inside
   it (`wait`, `humanApproval`, `respondToWebhook`, `executeSubWorkflow`, `forEach`, `agent`,
   `mcpTool`, `httpRequest`, and any other activity) is a **save-time 400** — N durable pauses have
   no way to say which iteration a single `approval`/`resume` signal answers (a frozen determinism
   hole). A2 regions are PURE nodes; activities arrive in A3 (batched map-activity), durable-in-region
   is a later design if ever.
5. **`splitOut`↔`loopEnd` matching:** each `splitOut` matches the UNIQUE `loopEnd` reachable from it
   (well-defined under rule 2's no-nesting). Zero, or ≥2, candidate `loopEnd`s → save-time 400.
6. **Linear region (A2 only).** The region between `splitOut` and `loopEnd` is a LINEAR chain (each
   region node has exactly one in- and one out-edge within the region) — no branches/merges/loops
   inside. This makes region execution a bounded `for` loop over `execNode` (no fan-out/merge/
   continueAsNew leaking across the boundary), the smallest correct interpreter surgery. Non-linear
   regions are a later slice; a drawn branch inside a region is a save-time 400.
Violations are save-time errors naming the offending node id. This replaces the entire runtime
lineage/participation machinery with a static, author-visible check — the fail-closed linchpin, so
its adversarial cases (an edge sneaking across the region boundary) are the hardest-tested surface.

### Runtime (interpreter, behind `wf.patched("items-model-v1")`)
Reaching `splitOut` with `N` items: execute the region subgraph `N` times in declared topological
order; on iteration `i`, `ctx[splitOut.id] = array[i]`, and region nodes write their per-iteration
outputs into a scratch keyed by `(nodeId, i)`. `loopEnd` reads its source's `N` scratch outputs →
one array. Region nodes read the CURRENT item because they bind to `splitOut` (or to region nodes,
which are per-iteration). Outside the region: unchanged, single-value — so **a graph with no
`splitOut` is byte-identical to today** (the back-compat wall). `N` counts toward the step breaker.

### Why this is sound where the others weren't
No `{from}` heuristic (participation is the drawn box), no cross-lineage zip (one region, one item
stream), no reducer taxonomy needed at the engine level (`filter`/`limit` inside a region just run
per-item like any node; array-level ops stay their normal selves outside). The only new frozen
surface is the region-validity rules above — and those are checked at save, where a bad graph is a
correctable 400, not a silent corruption.

---

## 0.4. A4 — non-linear regions (proposed; the effort/worth question is open)

A2/A3 regions are a LINEAR pure/activity chain (conditional intra-region edges + branches/merges are
a save-time 400). A4 would allow a per-item **sub-DAG**: branches (`if`/`switch` routing each ITEM down a
different path) and a merge back, so "for each row, if X do A else B, then combine" runs per item.
`limit` is NOT part of A4 — `listOps` already limits, and region-level limiting is just slicing the
source array before `splitOut`.

### Why this is the hardest frozen slice
The region would become a real subgraph executed N times. The outer interpreter's per-item state —
`nextNodes` edge-condition branching, the `merge` fan-in gate (`mergeArrivals`), `Promise.all`
fan-out — all become **per-item** inside the region. Options:
- **(i) Recurse the traversal per item.** Run a scoped `execChain`-like walk over the region sub-DAG,
  once per item, with its OWN merge-arrival counters and a frame ctx. Faithful, but it re-implements
  (or carefully reuses) the outer traversal with per-item isolation — a large change to the most
  determinism-sensitive code, frozen by the same gate.
- **(ii) Keep regions linear; add a per-item `switch`-with-branches as ONE node.** A single "route"
  construct that picks a path from inline sub-configs — avoids sub-DAG execution but is a weaker,
  bespoke model.

### The decisive argument: per-item branching ALREADY EXISTS via `forEach`
`forEach` runs a child graph per array item, and a child graph can contain **any** branches/merges.
So A4-full is **not a new capability** — it is an *inline optimization* of `forEach` for the
branching case, trading the **highest frozen-interpreter risk in the whole items program** (a
per-item sub-DAG with per-item merge-fan-in) to avoid child-run overhead on a niche path. That
inverts the cost/value: high risk, low marginal value over what `forEach` already does. (The "read
an `if` output field" idea is NOT a substitute — per-item *routing* needs the conditional edges that A2/A3
ban; `forEach` is the honest, sufficient escape hatch, and it stands alone.)

### Verdict: DEFER A4 (recorded so it isn't naively re-opened)
A2/A3 is a **complete, coherent milestone** — map + per-item LLM/API over N rows. A4 is a NEW,
optional thing, not "finishing the program", and absent concrete demand for per-item conditional
routing both A4-full and A4-min fail the worth test against their frozen-interpreter cost. Do not
build A4 without a real user need; `forEach` covers the branching case today.

## 0.3. A3 — batched activities inside a region (proposed; frozen decisions flagged)

A2 regions are PURE nodes only. A3 lets a region contain `"each"` **activity** nodes
(`agent`/`httpRequest`/`mcpTool` first; the rest later) so you can "call an LLM/API once per item"
— without emitting one Temporal activity per item (that would grow event history O(items)).

### Execution: NODE-major for activity regions (A2's item-major stays for pure-only)
- A2's per-item loop calls `execNode` once per item — fine for pure nodes (no history events), but
  an activity node there = **N activity commands** (O(items) history). A3 batches: for an activity
  region node, the interpreter resolves the node's inputs for ALL N frames (deterministic, in
  workflow: `resolveTemplates` + the node's arg resolution against frame `i`), then makes **ONE**
  `mapNode` activity call with the N resolved inputs. One activity per node per run, not per item.
- **FROZEN DECISION 1 (needs sign-off):** keep A2's exact **item-major loop for a pure-only region**
  (byte-identical to shipped A2 — an in-flight A2 run always has a pure-only region, so its replay
  is untouched), and use **node-major only when the region contains ≥1 activity node** (which can
  only exist in an A3+ graph, i.e. a new run, patched=true). Same `patched("items-model-v1")` gate:
  no existing run ever emits a `mapNode` command, so no v2 gate is needed. (Alternative — always
  node-major — is command-neutral for pure regions too, but preserving the item-major path is the
  zero-risk choice.)

### `mapNode` activity
- Signature ≈ `mapNode(nodeType, perItemInputs[], meta) → { outputs[], costUsd }` (the full return
  contract, incl. per-item error handling and the `maxAttempts: 1` retry policy, is fixed under
  "Retry + per-item errors" below — this bullet is just the shape).
- It dispatches by `nodeType` to the SAME underlying activity impl A2/execNode uses (`runAgent`,
  `callHttpRequest`, `callMcpTool`), looping the N inputs with **bounded concurrency**
  (`maxParallelItems`, default 10). Per-index heartbeat checkpointing (skip-completed-on-retry) is a
  LATER slice — A3 uses `maxAttempts: 1` instead (see below), so there is no partial-retry to resume.
- The interpreter passes ALREADY-RESOLVED per-item inputs (the exact payloads `execNode` would build
  for a single call), so `mapNode` contains no template/binding logic — it's a pure fan-out loop
  over an existing activity fn. Keeps determinism in the workflow, I/O in the activity (Tier-1 #3).

### Billing (Tier-1 #6 — fail-safe). DECISION 2 RESOLVED — per-item recording, not per-batch.
The original "one aggregate usage event" idea is **wrong and violates Tier-1 #6**: if item 20 throws
after items 1–19 made real LLM calls, the end-of-batch aggregate write never happens → 19 paid calls
billed as **zero**. `runAgent` already records its own usage row IN-ACTIVITY per call (`recordUsage(...)`
keyed by `meta.nodeId`) — so for the agent (the token-metered case that matters), `mapNode` simply
**loops it unchanged** and each item's tokens land in the ledger as it completes. (`httpRequest` cost
is ~0 and `mcpTool` cost is a flat operator-set value; those flow into the run budget only via
`mapNode`'s returned `costUsd` sum — correct under per-ITEM failure, and lost only on a genuine
mapNode infra-throw under `maxAttempts:1`, same narrow window as a single-call crash.) So `mapNode`
**loops those activity fns unchanged**: each per-item call records its own row as it completes (N rows keyed by the
same nodeId — fine; the ledger is Postgres, not history, and aggregates by node). A mid-batch failure
leaves completed items already billed. `costUsd` returned = the sum of completed items, accumulated
into the run budget. The "keep it to one event" instinct was about history/payload size, which the
usage TABLE doesn't share.

### Retry + per-item errors — A3 owns a MINIMAL per-item contract (forced by fail-safe billing)
Batching amplifies the non-idempotent-retry hole: one `mapNode` activity doing N I/O calls, if it
THREW mid-batch and Temporal retried the whole activity, would re-charge items 1–19 and duplicate
POST/email side effects. So:
- `mapNode` **catches per-item**, records the completed item's cost (in-activity, as above), and
  **RETURNS `{ outputs, costUsd }`** where a failed item's output is `{ error }` — it does NOT throw
  for item reasons. No item error → no whole-batch Temporal retry → no duplicate charges/effects.
- `mapNode` runs with **`maxAttempts: 1`** (a genuine infra crash fails the node once; retrying a
  batch of non-idempotent I/O is worse than failing). Documented frozen; per-index heartbeat
  checkpointing (skip-completed-on-retry) is a later slice if transient resilience is wanted.
- The WORKFLOW then applies the node's error policy: if any item errored and `onError !== "continue"`
  → fail the node (cost already recorded); `onError: "continue"` → each errored item keeps `{ error }`
  and the run proceeds. (This is the minimal slice of per-item error semantics A3 is forced to own;
  richer per-item routing is A4.)
- Bounded concurrency inside `mapNode`: `maxParallelItems` default 10.

### FROZEN: the activity's `input` inside a region IS THE CURRENT ITEM
Outside a region an activity's `input` is the run `__input`. INSIDE a region it is `ctx[splitOut.id]`
(the current item `i`) — so "agent/http over N rows" works with the item as input, matching n8n
(a node's input is the current item). Per-item variation still ALSO flows through templated config
(`{{ splitOut.x }}`); a static-config agent now maps over the items as its input rather than making
N identical calls.

### Save-validation relaxation
- `regionAllowed` gains the batchable `"each"` activities (`agent`/`httpRequest`/`mcpTool` in A3;
  more later). Durable/control nodes STAY banned (`wait`/`humanApproval`/`respondToWebhook`/
  `executeSubWorkflow`/`forEach`) — N durable pauses with one signal handler is the determinism hole
  A2 §0.2 rule 4 forbids, unchanged.
- The per-execution budget cap is checked before each `mapNode` (as today) — a region can't bypass it.

### DECISION 1 — KEPT (item-major-for-pure + node-major-for-activity, one gate). Load-bearing reason:
the graph is **content-hash-snapshotted at run start**, so a run's region shape (pure-only vs
contains-activity) is immutable for its lifetime — an in-flight A2 run can never acquire an
activity-in-region and can never take the node-major path, so no existing run emits a `mapNode`
command and the single `patched("items-model-v1")` gate suffices. (`computeItemsRegions` runs on the
snapshotted `graph` arg. Node-major is also provably identical to item-major for pure nodes — each
reads prior region nodes at index `i` either way — so mixed regions are safe.)

## 1. The core insight — cardinality propagates through bindings (no region detection)

The hard part everyone hits is "which nodes run per-item, and over which list?" n8n answers it with an
implicit single input connection; naary can't, because a node's data comes from config `from`
**bindings** to any prior node, not its edge predecessor. Region-boundary detection over naary's
arbitrary control-flow graph is where a naive design dies.

The resolution: **don't detect regions — let item cardinality flow along the binding edges — but
gate alignment on LINEAGE, not on positional index.**

**Lineage.** Positional index alone is the wrong alignment key: zipping two *independent* multi-item
lists by index is a semantic accident that "works" only when their lengths coincidentally match
(and hard-errors otherwise) — a length-dependent footgun. So every multi-item `items[n]` carries a
**lineage tag**: the id of the `splitOut`/reducer that created its index space. Two multi-item
sources may be aligned ONLY if they share the same lineage tag (⇒ they are 1:1 index-aligned
descendants of the same producer, and by construction have equal cardinality). Single-item sources
carry NO lineage and broadcast to any iteration. Anything else **fails closed** (§4).

The four node modes (a trichotomy is not enough — the fourth, **reducer**, is what makes
`split → filter → map` work):

- **`"each"` (item-wise map, N→N):** reading binding sources `S₁…Sₖ`, `card(n) = max(card(Sᵢ))` and
  lineage = the shared multi-item lineage (or none if all sources are single). Runs **once per index
  `i`**; on iteration `i` each source contributes `items[Sᵢ][ card(Sᵢ)===1 ? 0 : i ]` — zip the
  same-lineage multi sources, broadcast the single ones. Output → `items[n][i]`, same lineage/card.
- **`"reducer"` (N→M, STAYS in item-space):** `filter`/`limit`/`dedupe`/`listOps`. Reads its
  source's full array, emits the surviving M ≤ N items. Because it changes the index space it mints
  a **NEW lineage** (its M outputs are 1:1 with nothing upstream). This is the category the first
  draft was missing — misclassifying `filter` as `"all"` collapses it to one item and silently
  breaks `split → filter → set`.
- **`"all"` (aggregator, N→1):** `aggregate`/`merge`/`compareDatasets`. Reads sources' FULL arrays
  (`itemsJson`), emits ONE item (`card = 1`, no lineage). This is where items collapse to an object.
- **producer (`splitOut`, 1→N):** the only node that RAISES cardinality; mints a fresh lineage.

Everything downstream of a `splitOut` that is `"each"`/`"reducer"` fans out automatically; the first
`"all"` on each path collapses it — **without** the interpreter computing a region. Single-item
graphs (no `splitOut`) have `card ≡ 1`, no lineage, everywhere ⇒ **byte-identical to today** (the
back-compat wall — but NOT a correctness proof; see §7 for the multi-item expected outputs that are).

### The current-item rule (what the advisor required, stated exactly)
Inside iteration `i` of node `n`, EVERY `getByPath(ctx[from], path)` and every `resolveTemplates`
`{{ from.path }}` read resolves against a **frame ctx** where `ctx[from] = items[from][ card===1 ? 0 : i ].json`.
That is the current-item execution context. It is built per iteration and thrown away — the pure
resolvers (`resolveSet`, `resolveText`, …) are unchanged; they just run against the frame.

## 2. items-authoritative — REWRITES §2.1 of ITEMS-MODEL.md

Slice 1 pinned `items === toItems(ctx)` (ctx source of truth). Under (A) that inverts, because a
producer makes N items that a single `ctx` value can't hold:

- **`items[nodeId]` is authoritative.** `ctx[nodeId]` is retained ONLY as the legacy/first-item
  projection for reads that are not inside a frame: `ctx[nodeId] === items[nodeId][0]?.json`.
- Single-item ⇒ `ctx[nodeId]` is exactly today's value (`items[0].json === the output`) ⇒ every
  existing non-mapped read, edge condition, and the `stateQuery` ctx snapshot are unchanged.
- Edge conditions (`evaluateCondition` over a dotted ctx path) evaluate against **item 0** (n8n's
  "expressions default to the first item"). Branching is per-node, not per-item, in v1.

This §2.1 rewrite ships in the SAME PR that first materializes `items` (Slice A2), never split from it.

## 3. `itemMode` classification (registry metadata)

One field per node type in the registry; the interpreter reads it. Proposed:

- **`"each"` (item-wise map, N→N):** `set`, `renameKeys`, `text`, `json`, `number`, `if`, `switch`,
  `httpRequest`, `agent`, `mcpTool`, `sqlQuery`, `sqlExec`, `xml`, `htmlExtract`, `markdown`, `csv`,
  `encode`, `dateTime`, `hmac`, `jwt`, `totp`, `hash`, `random`, `sendEmail`, `respondToWebhook`,
  `code`, `stopAndError`.
- **`"reducer"` (N→M, item-space, mints a new lineage):** `filter`, `limit` (new), `listOps`
  (sort/dedupe/limit already live here). These keep the data as items — misclassifying them as
  `"all"` is the bug that breaks `split → filter → map`.
- **`"all"` (aggregator, N→1):** `aggregate`, `merge`, `compareDatasets`, `rssRead`(source),
  `forEach`, `executeSubWorkflow`, `humanApproval`, `wait`.
- **producer:** `splitOut` (new) — array→items.
- **entry/exit** (`start`, triggers, `end`, `noOp`): `card = 1` (a trigger's output is one item;
  splitOut fans it out explicitly).

Classification is a compile-time exhaustive map (like `NodeConfigMap`) so a new node must declare its
mode. Getting a node's mode wrong is a semantic change → it is covered by the §8 parity test.

## 4. Determinism, history, billing (Tier-1)

- **One `patched()` gate** — `wf.patched("items-model-v1")` — wraps the entire per-item execution
  path. In-flight runs replay on the old single-value path; new runs use items. The gate is chosen
  ONCE and its semantics are frozen — hence this doc.
- **Batched map-activity (Slice A3) — see §0.3 for the frozen contract.** An `"each"` **activity**
  node with `card = N` dispatches ONE activity `mapNode` that loops the N frames **inside the
  activity** (all I/O in the activity, per Tier-1 #3) with bounded concurrency (`maxParallelItems`,
  default 10) and **`maxAttempts: 1`** (no whole-batch retry; per-index checkpointing is a later
  slice). NEVER one Temporal activity per item — event history stays O(nodes), not O(items).
- **Billing (per §0.3):** `mapNode` loops the underlying activity fns, each of which records its own
  usage row **per item as it completes** (fail-safe under partial failure — completed items stay
  billed; never record zero). NOT one aggregate event.
- **Payload cap:** `items[nodeId]` can be large → the existing claim-check offload applies to the
  whole items array; `binary` (still deferred) will be per-item claim-check refs.
- **Fail closed on unaligned zip (frozen-forever ⇒ err, don't approximate):** an `"each"` node with
  ≥2 multi-item sources that do NOT share a lineage tag → deterministic `ApplicationFailure`
  (`ITEMS_CARDINALITY`). This is the critical rule: positional zip of independent `splitOut`
  lineages must NEVER silently pair them (it "works" only when their lengths coincidentally match).
  Same-lineage multi sources are equal-cardinality by construction and zip safely; single-item
  sources broadcast. An error can be relaxed to real cross-lineage pairing later (n8n's paired-items
  machinery); a silent semantic can't be un-frozen. **v1 supports a single active splitOut lineage
  per path; a second, independent lineage feeding one node is rejected, not guessed.**
- **Circuit breaker:** `card(n)` counts toward the per-run step budget (N items = N logical steps)
  so a runaway `splitOut` trips the existing breaker.

## 5. Interaction with `forEach` (keep both)

`forEach` (a CHILD RUN per item) stays for heavy, durable, isolated per-item sub-workflows (its
own budget, its own history). The inline items model is for lightweight per-item transforms/calls in
ONE run. Docs will steer: inline items for map/enrich; `forEach` for "run a whole sub-flow per item".
No migration of `forEach`.

## 6. Roadmap — re-sliced under (A)

Each slice ships green; the interpreter change is one patched gate introduced in A2.

- **A1 — primitive.** ✅ #206 (`Item`, `toItems`, `itemsJson`).
- **A2 — cardinality+lineage engine + `splitOut` + pure map (the core, patched).** Materialize
  `items` + lineage tags in the interpreter; `itemMode` registry (each/reducer/all/producer); the
  lineage-gated zip/broadcast frame execution for PURE `"each"` nodes; the `"reducer"` path
  (filter/listOps stay item-space, mint a new lineage); `splitOut` producer; `"all"` nodes read full
  arrays; cross-lineage fail-closed; rewrite §2.1 items-authoritative. Ships all six §7 traces as
  tests. This is the slice that proves the model — pure nodes only (activities in A3).
- **A3 — batched map-activity.** `agent`/`httpRequest`/`mcpTool`/… `"each"` nodes fan out via one
  `mapNode` activity (bounded concurrency; **per-item** usage recording — fail-safe under partial
  failure; `maxAttempts: 1`; per-item `{ error }` return). The headline: an agent over N rows. Full
  frozen spec in §0.3.
- **A4 — aggregation surface + `limit`.** Formalize `"all"` semantics, add `limit`; per-item error
  routing (an item's failure → `{ error }` in that item, continue) building on per-node onError.
- **A5 — authoring.** Canvas input panel shows the items table; run view shows per-item output + the
  failing item.

## 7. Worked multi-item traces (the correctness spec — expected outputs frozen here)

The single-item equivalence test proves back-compat, not that the multi-item path is *right*. These
are the authoritative expected outputs A2 must reproduce (each is a test):

1. **map:** `splitOut([{n:1},{n:2},{n:3}]) → set{doubled: {{split.n}}*... }`
   → items = `[{doubled:1},{doubled:2},{doubled:3}]` (card 3, lineage L₁). `ctx[set] = {doubled:1}`
   (item 0).
2. **reduce then map (the flow the first draft broke):** `splitOut([1,2,3,4]) → filter(x>2) → set`
   → filter emits `[3,4]` (card 2, NEW lineage L₂); set maps over 2 → 2 items. NOT one item over
   `[3,4]`.
3. **aggregate collapses:** `splitOut([1,2,3]) → aggregate(sum)` → `card 1`, `[{sum:6}]`. Downstream
   is back to single-item (no lineage).
4. **broadcast:** `splitOut([a,b])`(L₁) + `httpConfig`(card 1) → `set` reading both → card 2, the
   single-item config broadcast to both iterations. Allowed.
5. **cross-lineage → ERROR:** `splitOutA([1,2,3])`(L₁) + `splitOutB([4,5,6])`(L₃) → `set` reading
   both → `ITEMS_CARDINALITY` (NOT a positional zip, even though both are length 3).
6. **same-lineage zip:** `splitOut([a,b])`(L₁) → `text`(L₁) and `number`(L₁), then `set` reading
   both text and number → same lineage L₁, card 2 → zips `(text₀,number₀),(text₁,number₁)`. Allowed.

## 8. Non-negotiables / test obligations

- **Single-item equivalence is the back-compat wall (NOT correctness):** a property test asserting
  every existing graph (card ≡ 1, no lineage) produces byte-identical `ctx` with the items path ON
  vs OFF. Necessary, but it exercises none of §7 — the §7 traces are the correctness obligation.
- **Cross-lineage fail-closed** (§7 trace 5) and **reducer keeps item-space** (§7 trace 2) are the two
  must-have multi-item tests; without them A2 can be green and still wrong.
- `itemMode` map is exhaustive (build fails on a missing node) + a parity test pins each node's mode.
- Zip/broadcast + incompatible-cardinality behavior is unit-tested at 0/1/N and N-vs-M.
- No `Date.now`/IO/zod in the interpreter frame code; the map-activity holds all I/O.
- The `patched("items-model-v1")` gate is introduced exactly once (A2) and never re-defined.
