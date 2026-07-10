# Design — Items Model (A): the Current-Item Execution Context

**Status:** proposed · **Date:** 2026-07-09
**Decision:** Option **(A)** from `ITEMS-MODEL.md` §0 was chosen — the faithful, implicit per-item
model. This doc is the detailed design that must land + be reviewed **before any `execNode` change**
(an interpreter change is frozen for all in-flight runs by `workflow.patched()`).
**Builds on:** Slice 1 (#206) — `Item`, `toItems`, `itemsJson` in `@naary/dsl`.

---

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
back-compat wall — but NOT a correctness proof; see §8 for the multi-item expected outputs that are).

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
mode. Getting a node's mode wrong is a semantic change → it is covered by the §7 parity test.

## 4. Determinism, history, billing (Tier-1)

- **One `patched()` gate** — `wf.patched("items-model-v1")` — wraps the entire per-item execution
  path. In-flight runs replay on the old single-value path; new runs use items. The gate is chosen
  ONCE and its semantics are frozen — hence this doc.
- **Batched map-activity (Slice A3).** An `"each"` **activity** node with `card = N` dispatches ONE
  activity `mapNode(type, cfg, frames[])` that loops the N frames **inside the activity** (all I/O in
  the activity, per Tier-1 #3) with bounded concurrency (`maxParallelItems`, default 10) and per-item
  checkpointing. NEVER one Temporal activity per item — event history stays O(nodes), not O(items).
- **Billing:** the map-activity sums `totalUsage` across the N per-item LLM calls into ONE usage
  event (fail-safe estimate if any item's usage is missing — never record zero).
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
  arrays; cross-lineage fail-closed; rewrite §2.1 items-authoritative. Ships all six §8 traces as
  tests. This is the slice that proves the model — pure nodes only (activities in A3).
- **A3 — batched map-activity.** `agent`/`httpRequest`/`mcpTool`/… `"each"` nodes fan out via one
  `mapNode` activity (bounded concurrency, per-batch usage event). The headline: an agent over N rows.
- **A4 — aggregation surface + `limit`.** Formalize `"all"` semantics, add `limit`; per-item error
  routing (an item's failure → `{ error }` in that item, continue) building on per-node onError.
- **A5 — authoring.** Canvas input panel shows the items table; run view shows per-item output + the
  failing item.

## 8. Worked multi-item traces (the correctness spec — expected outputs frozen here)

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

## 7. Non-negotiables / test obligations

- **Single-item equivalence is the back-compat wall (NOT correctness):** a property test asserting
  every existing graph (card ≡ 1, no lineage) produces byte-identical `ctx` with the items path ON
  vs OFF. Necessary, but it exercises none of §8 — the §8 traces are the correctness obligation.
- **Cross-lineage fail-closed** (§8.5) and **reducer keeps item-space** (§8.2) are the two
  must-have multi-item tests; without them A2 can be green and still wrong.
- `itemMode` map is exhaustive (build fails on a missing node) + a parity test pins each node's mode.
- Zip/broadcast + incompatible-cardinality behavior is unit-tested at 0/1/N and N-vs-M.
- No `Date.now`/IO/zod in the interpreter frame code; the map-activity holds all I/O.
- The `patched("items-model-v1")` gate is introduced exactly once (A2) and never re-defined.
