/**
 * Items model — Slice 1: the normalize primitive (design docs/design/ITEMS-MODEL.md).
 *
 * n8n's spine is that an edge carries an ARRAY OF ITEMS (`[{ json }, …]`) and most nodes run once
 * per item. naary passes one object per edge today. This slice ships ONLY the normalization
 * primitive — the type + `toItems` + `itemsJson` — that every later slice builds on. There is NO
 * interpreter change here; the map-over-items execution lands in Slice 2, behind `workflow.patched()`.
 *
 * COEXIST CONTRACT (the decision the whole program rests on — pinned here):
 *   `ctx[nodeId]` (a node's raw output) CONTINUES to exist and is the source of truth for every
 *   existing read — `getByPath(ctx[from], path)`, edge conditions, bindings. The items view is an
 *   ADDITIONAL projection layered on top: `items[nodeId] === toItems(ctx[nodeId])`. Slice 2 adds
 *   the view WITHOUT rewriting a single existing `ctx` read. This is why there is no `fromItems`
 *   (nothing ever reconstructs a scalar from items — back-compat reads hit `ctx` directly), and it
 *   is what keeps the migration additive and replay-safe.
 */

/**
 * One item on an edge. Deliberately minimal — just `json`. Binary is intentionally NOT modeled yet:
 * when it lands it MUST reuse the existing claim-check machinery (resolveClaimChecks / maybeOffload
 * / the object store), not a freshly-invented ref shape, so it is defined WITH its consumer, later.
 */
export interface Item {
  json: unknown;
}

/**
 * Normalize a legacy single-value node output into the items view: the WHOLE value becomes ONE
 * item's `json`. This preserves today's exact semantics (one object per edge == a one-item array)
 * — an array output is one item whose json is that array, NOT N items (splitting an array into
 * items is a later, explicit `splitOut`/aggregate concern, never an implicit guess here).
 *
 * Always wraps; never inspects `value` to decide it is "already `Item[]`". Auto-detecting
 * item-shaped arrays from arbitrary `unknown` would reintroduce the exact ambiguity the items model
 * exists to avoid, so it is forbidden by construction.
 */
export function toItems(value: unknown): Item[] {
  return [{ json: value }];
}

/** Project an items array to its `json` values (order-preserving). The unambiguous inverse view —
 *  no length-dependent collapse, so it is safe for the multi-item case the whole program targets. */
export function itemsJson(items: Item[]): unknown[] {
  return items.map((it) => it.json);
}
