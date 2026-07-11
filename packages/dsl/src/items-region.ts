/**
 * Items model (design ITEMS-MODEL-CURRENT-ITEM.md §0.2 + §0.4.1) — the fail-closed region linchpin.
 *
 * A `splitOut … loopEnd` pair brackets a per-item region: the nodes between them run once per array
 * element. Participation is DRAWN (the bracket), never inferred — so the whole correctness story
 * reduces to validating the drawn region STRUCTURALLY at save time, where a bad graph is a correctable
 * 400 rather than a frozen runtime corruption.
 *
 * A region is one of two KINDS:
 *   - **linear** (A2/A3) — a single chain of allowed nodes; runs item-major (A2) or node-major batched
 *     (A3). This is the original, unchanged path.
 *   - **a4** — a per-item sub-DAG with `if`/`switch`/`merge` + conditional edges; runs item-major via a
 *     per-item dead-branch dataflow pass in the interpreter.
 *
 * `computeItemsRegions` is the single source of truth: the save-time validator and the interpreter
 * both call it, so they can never disagree about what a region is. A region is A4 ONLY when it can't be
 * a linear region (a branch/join/conditional edge / merge appears) — so a linear region's output here is
 * byte-identical to before A4 existed (critical: the interpreter runs this at runtime too, so a changed
 * classification of an existing graph would be a replay nondeterminism).
 */
import { isPureNode } from "./pure-node";
import type { EdgeDef, GraphDef, NodeDef } from "./types";

export interface ItemsRegion {
  splitOutId: string;
  loopEndId: string;
  /** Region nodes (excludes splitOut + loopEnd). LINEAR: execution order. A4: topological order. */
  regionNodeIds: string[];
  /** The node whose per-iteration output `loopEnd` collects (a region node, or the splitOut). */
  collectFrom: string;
  /** How the interpreter runs the region. Absent-in-old-callers defaults are not relied on — always set. */
  kind: "linear" | "a4";
}

/** Per-item trace grid (items-model §0.4.2), the wire shape shared by the worker (which writes it into
 *  `ctx.__regionTrace`, keyed by splitOut id) and the run view (which renders it). A cell is tri-state:
 *  the value, a dead branch (A4), or an `onError:"continue"` error. Defined here — beside the region
 *  model it derives from — so worker and web share ONE definition (both already depend on @naary/dsl). */
export type TraceCell = { v: unknown } | { dead: true } | { err: string };
export type RegionTrace =
  | {
      nodes: string[];
      items: Record<string, TraceCell>[];
      truncatedItems?: number;
    }
  /** A3 node-major region carries no grid; `budget` = the aggregate trace byte cap was hit first. */
  | { unavailable: "batched" | "budget" };

export interface ItemsRegionResult {
  regions: ItemsRegion[];
  /** First structural violation (node id named), or null when every region is valid. */
  error: string | null;
}

/** "each" activity nodes that A3 can BATCH inside a LINEAR region (design §0.3). MUST match what the
 *  `mapNode` activity dispatches. DURABLE/control nodes stay banned everywhere. */
export const BATCHABLE_REGION_ACTIVITIES: ReadonlySet<string> = new Set([
  "agent",
  "httpRequest",
  "mcpTool",
]);

/** Node types allowed inside a LINEAR region: pure + no-op (A2) + batchable activities (A3). */
function regionAllowed(type: string): boolean {
  return (
    isPureNode(type) || type === "noOp" || BATCHABLE_REGION_ACTIVITIES.has(type)
  );
}

/** Node types allowed inside an A4 region: everything a linear region allows, PLUS `merge` (the rejoin).
 *  `if`/`switch` are already pure ⇒ allowed. Durable/control + nested splitOut/loopEnd stay banned. */
function a4RegionAllowed(type: string): boolean {
  return regionAllowed(type) || type === "merge";
}

/** The branch nodes whose per-item routing an A4 region can prove EXHAUSTIVE at save (see §0.4.1). */
function isBranchNode(type: string): boolean {
  return type === "if" || type === "switch";
}

export function computeItemsRegions(graph: GraphDef): ItemsRegionResult {
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const outEdges = new Map<string, EdgeDef[]>();
  const inEdges = new Map<string, EdgeDef[]>();
  for (const e of graph.edges) {
    (outEdges.get(e.from) ?? outEdges.set(e.from, []).get(e.from)!).push(e);
    (inEdges.get(e.to) ?? inEdges.set(e.to, []).get(e.to)!).push(e);
  }
  const outFrom = (id: string): string[] =>
    (outEdges.get(id) ?? []).map((e) => e.to);
  const inTo = (id: string): string[] =>
    (inEdges.get(id) ?? []).map((e) => e.from);
  const hasConditionalOut = (id: string): boolean =>
    (outEdges.get(id) ?? []).some((e) => e.condition !== undefined);

  const regions: ItemsRegion[] = [];
  const claimedLoopEnds = new Set<string>();
  const err = (msg: string): ItemsRegionResult => ({ regions, error: msg });

  for (const n of graph.nodes) {
    if (n.type !== "splitOut") continue;

    // Try the strict LINEAR walk first; its success output is byte-identical to pre-A4. Only when it
    // fails for a NON-LINEAR reason (a branch/join/conditional edge / merge / splitOut fan-out) do we
    // fall back to the A4 sub-DAG validator. A hard failure (durable node, nested splitOut, dangling
    // path) is rejected for both kinds.
    const linear = walkLinearRegion(n, {
      nodeById,
      outFrom,
      inTo,
      hasConditionalOut,
    });
    let region: ItemsRegion;
    if (linear.ok) {
      region = linear.region;
    } else if (linear.tryA4) {
      const a4 = validateA4Region(n, {
        graph,
        nodeById,
        outEdges,
        inEdges,
        outFrom,
        inTo,
      });
      if (!a4.ok) return err(a4.error);
      region = a4.region;
    } else {
      return err(linear.error);
    }

    if (claimedLoopEnds.has(region.loopEndId)) {
      return err(
        `loopEnd '${region.loopEndId}' is claimed by more than one splitOut`,
      );
    }
    claimedLoopEnds.add(region.loopEndId);
    regions.push(region);
  }

  for (const n of graph.nodes) {
    if (n.type === "loopEnd" && !claimedLoopEnds.has(n.id)) {
      return err(`loopEnd '${n.id}' has no matching splitOut`);
    }
  }

  return { regions, error: null };
}

// ── LINEAR region (A2/A3) — the original walk, factored out unchanged in its SUCCESS output ──

interface LinearDeps {
  nodeById: Map<string, NodeDef>;
  outFrom: (id: string) => string[];
  inTo: (id: string) => string[];
  hasConditionalOut: (id: string) => boolean;
}

type LinearResult =
  | { ok: true; region: ItemsRegion }
  /** A NON-LINEAR shape (branch/join/conditional/merge/splitOut-fanout) — the A4 validator should try. */
  | { ok: false; tryA4: true; error: string }
  /** A hard violation banned for BOTH kinds (durable node, nested splitOut, dangling path). */
  | { ok: false; tryA4: false; error: string };

function walkLinearRegion(n: NodeDef, d: LinearDeps): LinearResult {
  const { nodeById, outFrom, inTo, hasConditionalOut } = d;
  const a4 = (error: string): LinearResult => ({
    ok: false,
    tryA4: true,
    error,
  });
  const hard = (error: string): LinearResult => ({
    ok: false,
    tryA4: false,
    error,
  });

  const outs = outFrom(n.id);
  if (outs.length !== 1) {
    return a4(`splitOut '${n.id}' must have exactly one outgoing edge`);
  }
  if (hasConditionalOut(n.id)) {
    return a4(
      `splitOut '${n.id}' has a conditional outgoing edge — region edges must be unconditional`,
    );
  }
  const regionNodeIds: string[] = [];
  const seen = new Set<string>();
  let cur: string | undefined = outs[0];

  while (true) {
    if (cur === undefined) {
      return hard(`splitOut '${n.id}' has no matching loopEnd on its path`);
    }
    const node = nodeById.get(cur);
    if (!node)
      return hard(`splitOut '${n.id}' path reaches unknown node '${cur}'`);
    if (node.type === "loopEnd") break;

    if (node.type === "splitOut") {
      return hard(
        `nested splitOut '${cur}' inside region of '${n.id}' (not supported in v1)`,
      );
    }
    if (!regionAllowed(node.type)) {
      // `merge` is the one disallowed-in-linear type that A4 permits — route to A4; everything else
      // (durable/control/non-batchable activity) is banned in both.
      return node.type === "merge"
        ? a4(`region node '${cur}' is a merge — non-linear region`)
        : hard(
            `node '${cur}' (${node.type}) is not allowed inside a splitOut region — only pure nodes and the batchable activities (agent/httpRequest/mcpTool) may appear in a region`,
          );
    }
    if (inTo(cur).length !== 1) {
      return a4(
        `region node '${cur}' has a join (must be a linear chain in v1)`,
      );
    }
    if (outFrom(cur).length !== 1) {
      return a4(
        `region node '${cur}' has a branch (must be a linear chain in v1)`,
      );
    }
    if (hasConditionalOut(cur)) {
      return a4(
        `region node '${cur}' has a conditional outgoing edge — region edges must be unconditional`,
      );
    }
    if (seen.has(cur))
      return hard(`cycle in splitOut '${n.id}' region at '${cur}'`);
    seen.add(cur);
    regionNodeIds.push(cur);
    cur = outFrom(cur)[0];
  }

  const loopEndId = cur;
  if (inTo(loopEndId).length !== 1) {
    return a4(`loopEnd '${loopEndId}' must have exactly one incoming edge`);
  }
  if (outFrom(loopEndId).length > 1) {
    return hard(
      `loopEnd '${loopEndId}' must have at most one outgoing edge (fan-out after a loop is not supported in v1)`,
    );
  }
  const loopEnd = nodeById.get(loopEndId);
  const collectFrom = String(
    (loopEnd?.config as { from?: unknown } | undefined)?.from ?? "",
  );
  if (collectFrom !== n.id && !regionNodeIds.includes(collectFrom)) {
    return hard(
      `loopEnd '${loopEndId}' collects '${collectFrom || "(unset)"}', which is not in its splitOut region`,
    );
  }
  return {
    ok: true,
    region: {
      splitOutId: n.id,
      loopEndId,
      regionNodeIds,
      collectFrom,
      kind: "linear",
    },
  };
}

// ── A4 region — a per-item sub-DAG (design §0.4.1) ──

interface A4Deps {
  graph: GraphDef;
  nodeById: Map<string, NodeDef>;
  outEdges: Map<string, EdgeDef[]>;
  inEdges: Map<string, EdgeDef[]>;
  outFrom: (id: string) => string[];
  inTo: (id: string) => string[];
}

function validateA4Region(
  n: NodeDef,
  d: A4Deps,
): { ok: true; region: ItemsRegion } | { ok: false; error: string } {
  const { nodeById, outEdges, inEdges, outFrom, inTo } = d;
  const bad = (error: string): { ok: false; error: string } => ({
    ok: false,
    error,
  });

  // 1) Find the region's loopEnd: forward reachability from splitOut, not expanding past a loopEnd.
  const forward = new Set<string>();
  const loopEnds = new Set<string>();
  const fstack = [...outFrom(n.id)];
  while (fstack.length) {
    const id = fstack.pop()!;
    if (forward.has(id) || loopEnds.has(id)) continue;
    const node = nodeById.get(id);
    if (!node)
      return bad(`splitOut '${n.id}' path reaches unknown node '${id}'`);
    if (node.type === "loopEnd") {
      loopEnds.add(id);
      continue; // don't expand past the closer
    }
    forward.add(id);
    for (const t of outFrom(id)) fstack.push(t);
  }
  if (loopEnds.size === 0) {
    return bad(`splitOut '${n.id}' has no matching loopEnd on its path`);
  }
  if (loopEnds.size > 1) {
    return bad(
      `splitOut '${n.id}' reaches multiple loopEnd nodes (${[...loopEnds].sort().join(", ")}) — a region has exactly one closer`,
    );
  }
  const loopEndId = [...loopEnds][0];

  // 2) Backward reachability from loopEnd (not past splitOut) — a region node must REACH the closer.
  const backward = new Set<string>();
  const bstack = [...inTo(loopEndId)];
  while (bstack.length) {
    const id = bstack.pop()!;
    if (backward.has(id) || id === n.id) continue;
    if (!nodeById.has(id))
      return bad(`region path reaches unknown node '${id}'`);
    backward.add(id);
    for (const s of inTo(id)) bstack.push(s);
  }
  // Region = reachable-from-split ∩ reaches-loopEnd.
  const regionSet = new Set([...forward].filter((id) => backward.has(id)));

  // 3) Single-entry / single-exit (SESE) — a bracket, no edge crossing the boundary except the markers.
  for (const id of forward) {
    if (!regionSet.has(id)) {
      return bad(
        `node '${id}' is reachable from splitOut '${n.id}' but does not reach loopEnd '${loopEndId}' (a dead-end path inside the region)`,
      );
    }
  }
  for (const id of regionSet) {
    for (const src of inTo(id)) {
      if (src !== n.id && !regionSet.has(src)) {
        return bad(
          `region node '${id}' has an inbound edge from '${src}' outside splitOut '${n.id}'s region (single-entry violation)`,
        );
      }
    }
    for (const dst of outFrom(id)) {
      if (dst !== loopEndId && !regionSet.has(dst)) {
        return bad(
          `region node '${id}' has an outbound edge to '${dst}' outside splitOut '${n.id}'s region (single-exit violation)`,
        );
      }
    }
  }
  for (const e of outEdges.get(n.id) ?? []) {
    if (e.to !== loopEndId && !regionSet.has(e.to)) {
      return bad(
        `splitOut '${n.id}' has an outbound edge to '${e.to}' outside its region`,
      );
    }
    // splitOut isn't a branch node — a conditional edge off it can't be shown exhaustive.
    if (e.condition !== undefined) {
      return bad(
        `splitOut '${n.id}' has a conditional out-edge — only if/switch may route items in a region`,
      );
    }
  }
  for (const src of inTo(loopEndId)) {
    if (src !== n.id && !regionSet.has(src)) {
      return bad(
        `loopEnd '${loopEndId}' has an inbound edge from '${src}' outside the region`,
      );
    }
  }
  if ((outEdges.get(loopEndId) ?? []).length > 1) {
    return bad(
      `loopEnd '${loopEndId}' must have at most one outgoing edge (fan-out after a loop is not supported in v1)`,
    );
  }

  // 4) Allowed node types + no nesting.
  for (const id of regionSet) {
    const node = nodeById.get(id)!;
    if (node.type === "splitOut" || node.type === "loopEnd") {
      return bad(
        `nested ${node.type} '${id}' inside region of '${n.id}' (not supported in v1)`,
      );
    }
    if (!a4RegionAllowed(node.type)) {
      return bad(
        `node '${id}' (${node.type}) is not allowed inside a splitOut region`,
      );
    }
  }

  // 5) Only if/switch may carry CONDITIONAL out-edges (their routing is provably exhaustive below);
  //    any other conditional edge in a region can't be shown total, so reject it.
  for (const id of regionSet) {
    const node = nodeById.get(id)!;
    const outs = outEdges.get(id) ?? [];
    const conditional = outs.filter((e) => e.condition !== undefined);
    if (conditional.length > 0 && !isBranchNode(node.type)) {
      return bad(
        `region node '${id}' (${node.type}) has a conditional out-edge — only if/switch may route items in a region`,
      );
    }
  }

  // 6) Acyclic + topological order over the region sub-DAG (edges restricted to region-internal).
  const topo = topoSortRegion(regionSet, inEdges, n.id, loopEndId);
  if (!topo) return bad(`splitOut '${n.id}' region contains a cycle`);

  // 7) Exhaustive routing at every branch point (§0.4.1): every possible output value of an if/switch
  //    must have a covering out-edge, so no item is left with all-dead out-edges (→ no live path).
  for (const id of regionSet) {
    const node = nodeById.get(id)!;
    if (!isBranchNode(node.type)) continue;
    const e = exhaustivenessError(node, outEdges.get(id) ?? []);
    if (e) return bad(e);
  }

  // 8) collectFrom must be in the region AND post-dominate it (on EVERY splitOut→loopEnd path), so a
  //    live path's collected value is always defined.
  const loopEnd = nodeById.get(loopEndId);
  const collectFrom = String(
    (loopEnd?.config as { from?: unknown } | undefined)?.from ?? "",
  );
  if (collectFrom !== n.id && !regionSet.has(collectFrom)) {
    return bad(
      `loopEnd '${loopEndId}' collects '${collectFrom || "(unset)"}', which is not in its splitOut region`,
    );
  }
  if (
    collectFrom !== n.id &&
    !postDominates(collectFrom, n.id, loopEndId, regionSet, outFrom)
  ) {
    return bad(
      `loopEnd '${loopEndId}' collects '${collectFrom}', which is not on every per-item path (an item routed the other way would collect nothing) — collect from the rejoining merge`,
    );
  }

  return {
    ok: true,
    region: {
      splitOutId: n.id,
      loopEndId,
      regionNodeIds: topo,
      collectFrom,
      kind: "a4",
    },
  };
}

/** Kahn topological sort restricted to region-internal edges (source & target both in `regionSet`).
 *  Returns the order, or null on a cycle. Deterministic: ready nodes are dequeued in `regionSet`
 *  insertion order (which follows graph node order). */
function topoSortRegion(
  regionSet: Set<string>,
  inEdges: Map<string, EdgeDef[]>,
  splitOutId: string,
  loopEndId: string,
): string[] | null {
  const indeg = new Map<string, number>();
  for (const id of regionSet) {
    const ins = (inEdges.get(id) ?? []).filter(
      (e) => e.from !== splitOutId && regionSet.has(e.from),
    );
    indeg.set(id, ins.length);
  }
  const outAdj = new Map<string, string[]>();
  for (const id of regionSet) outAdj.set(id, []);
  for (const to of regionSet) {
    for (const e of inEdges.get(to) ?? []) {
      if (
        e.from !== splitOutId &&
        e.from !== loopEndId &&
        regionSet.has(e.from)
      ) {
        outAdj.get(e.from)!.push(to);
      }
    }
  }
  const order: string[] = [];
  const ready = [...regionSet].filter((id) => (indeg.get(id) ?? 0) === 0);
  while (ready.length) {
    const id = ready.shift()!;
    order.push(id);
    for (const to of outAdj.get(id) ?? []) {
      const d = (indeg.get(to) ?? 0) - 1;
      indeg.set(to, d);
      if (d === 0) ready.push(to);
    }
  }
  return order.length === regionSet.size ? order : null;
}

/** True iff `target` lies on EVERY path from splitOut to loopEnd within the region — i.e. removing it
 *  disconnects loopEnd from splitOut. (A graph post-dominator check via reachability.) */
function postDominates(
  target: string,
  splitOutId: string,
  loopEndId: string,
  regionSet: Set<string>,
  outFrom: (id: string) => string[],
): boolean {
  const seen = new Set<string>([target]); // block traversal through `target`
  const stack = outFrom(splitOutId).filter(
    (id) => id !== target && (regionSet.has(id) || id === loopEndId),
  );
  while (stack.length) {
    const id = stack.pop()!;
    if (id === loopEndId) return false; // reached the closer WITHOUT passing target
    if (seen.has(id) || !regionSet.has(id)) continue;
    seen.add(id);
    for (const t of outFrom(id)) {
      if (t === loopEndId) return false;
      if (!seen.has(t) && regionSet.has(t)) stack.push(t);
    }
  }
  return true; // loopEnd unreachable without target ⇒ target post-dominates
}

/** For an if/switch branch node, verify its out-edges exhaustively cover every value it can output
 *  (design §0.4.1), so an item is never left with all out-edges dead. Returns an error string or null. */
function exhaustivenessError(node: NodeDef, outs: EdgeDef[]): string | null {
  // Values an out-edge condition `<node>.<field> == V` covers. Under all-match routing the eq
  // conditions on a single field are mutually exclusive, so covering all values ⇒ exactly one live.
  const field = node.type === "if" ? "result" : "matched";
  const covered = new Set<unknown>();
  for (const e of outs) {
    const c = e.condition;
    if (!c) {
      // An unconditional out-edge always fires (all-match) — it can't express exclusive routing.
      return `branch node '${node.id}' (${node.type}) has an unconditional out-edge; a region branch must route via '${field} == <value>' edges covering every case`;
    }
    // Path MUST be the qualified `<id>.<field>`. A bare `field` reads `ctx.<field>` at runtime
    // (evaluateCondition = getByPath(ctx, path)) — but the branch writes to `ctx.<id>.<field>`, so a
    // bare path would silently never match, killing every out-edge for the item. Reject it here.
    if (c.op !== "eq" || c.path !== `${node.id}.${field}`) {
      return `branch node '${node.id}' (${node.type}) out-edge condition must be '${node.id}.${field} == <value>' for exhaustive routing`;
    }
    covered.add(c.value);
  }
  const need = branchOutcomes(node);
  const missing = need.filter((v) => !covered.has(v));
  if (missing.length > 0) {
    return `branch node '${node.id}' (${node.type}) is not exhaustive: no out-edge for ${missing
      .map((v) => JSON.stringify(v))
      .join(", ")} — every item must have a live path`;
  }
  return null;
}

/** The exhaustive set of values a branch node can output: `if` → true/false; `switch` → each rule
 *  name plus its fallback. */
function branchOutcomes(node: NodeDef): unknown[] {
  if (node.type === "if") return [true, false];
  const cfg = (node.config ?? {}) as {
    rules?: { name?: unknown }[];
    fallback?: unknown;
  };
  const names = (cfg.rules ?? []).map((r) => r.name);
  const fallback = cfg.fallback ?? "default";
  return [...new Set([...names, fallback])];
}
