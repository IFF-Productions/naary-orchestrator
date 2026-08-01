/**
 * Connecting nodes from the CONFIG PANEL (#1026) — the pure decisions behind the "Connects to"
 * section, so they can be unit-tested as the real rules instead of being re-derived by eye in JSX.
 *
 * ## Edge ORDER is semantic — this module never sorts
 *
 * The interpreter's `nextNodes` (packages/dsl/src/branch.ts) walks `graph.edges` IN DECLARED ORDER
 * and returns EVERY outgoing edge whose condition passes. That order survives `compileGraph` and
 * `canonicalize()`/`contentHash`, which is why `diffGraphs` reports a pure reorder as a real change
 * (`edgesReordered`). Two run-time behaviours ride on it:
 *
 *  1. fan-out order — `Promise.all(nexts.map(…))` starts the branches in edge order;
 *  2. first-terminal-wins — when several branches reach a terminal status, the run takes the one
 *     belonging to the EARLIER edge (`for (const r of results) if (r !== null) return r`).
 *
 * So `outgoingConnections` returns a node's edges in their true array order, with their global
 * index, and `moveConnection` reorders by SWAPPING two siblings' slots in that same array. A panel
 * that sorted this list (by target name, say) would show one precedence and execute another.
 *
 * NOTE what is NOT true: an unconditional edge does not "capture" the traffic of the conditional
 * edges beside it, wherever it sits in the list. Every passing edge fires. The panel's copy has to
 * say that, because the author will act on what it says.
 */
import type { NodeType } from "@naary/dsl";
import { isEntryType } from "../../lib/compile-graph";
import type { EdgeConditionDraft } from "../../lib/graph-model";

/** The minimum an edge must carry for this module (a React Flow `FlowEdge` satisfies it). */
export interface ConnectEdge {
  id: string;
  source: string;
  target: string;
  data?: { condition?: EdgeConditionDraft } & Record<string, unknown>;
}

/** A node as the connect UI needs it: what it is, and what to call it on screen. */
export interface ConnectNode {
  id: string;
  kind: NodeType;
  label: string;
}

/** An outgoing edge together with WHERE it sits in the canvas's edge array. */
export interface OutgoingConnection<E extends ConnectEdge = ConnectEdge> {
  edge: E;
  /** Index in the full edge array — the thing that decides execution order. */
  index: number;
  /** 1-based position among this node's own outgoing edges (what the panel numbers). */
  position: number;
}

/**
 * Can a node of this kind have OUTGOING edges?
 *
 * Deliberately the same rule the canvas draws its handles by (`flow.tsx` renders the source Handle
 * for every kind except `end`), so the panel can never offer a connection dragging would refuse —
 * or refuse one dragging allows. One rule, not two. That includes `stopAndError`, which throws at
 * run time and so has no reachable successor but is still given a source handle: diverging here
 * would be a second, quieter opinion about the same graph.
 */
export function canHaveOutgoing(kind: NodeType): boolean {
  return kind !== "end";
}

/**
 * Can a node of this kind have INCOMING edges? Entry/trigger nodes can't — they have no target
 * handle on the canvas, and `compileGraph` makes one of them the graph's `startNodeId`. Asked of
 * `isEntryType` (lib/compile-graph.ts), the SAME list the compiler uses, so this can't drift.
 */
export function canHaveIncoming(kind: NodeType): boolean {
  return !isEntryType(kind);
}

/** This node's outgoing edges, in EXECUTION ORDER. Never sorted — see the module note. */
export function outgoingConnections<E extends ConnectEdge>(
  nodeId: string,
  edges: readonly E[],
): OutgoingConnection<E>[] {
  const out: OutgoingConnection<E>[] = [];
  edges.forEach((edge, index) => {
    if (edge.source !== nodeId) return;
    out.push({ edge, index, position: out.length + 1 });
  });
  return out;
}

/** This node's incoming edges, in the same declared order (read-only orientation in the panel). */
export function incomingConnections<E extends ConnectEdge>(
  nodeId: string,
  edges: readonly E[],
): E[] {
  return edges.filter((e) => e.target === nodeId);
}

/** Is there already an edge source→target? React Flow's `addEdge` refuses a duplicate connection
 *  (same source/target/handles), so the panel must refuse the same one. */
export function hasConnection(
  edges: readonly ConnectEdge[],
  source: string,
  target: string,
): boolean {
  return edges.some((e) => e.source === source && e.target === target);
}

/**
 * The nodes this one may be connected TO, in canvas order. Excludes:
 *  · itself (a self-edge is an immediate cycle);
 *  · nodes that take no incoming edge (triggers/entries);
 *  · nodes already connected from this source — that connection exists, and `addEdge` would drop
 *    a second one anyway.
 * A node further UP the flow is deliberately still offered: a back-edge is a legal loop.
 */
export function connectableTargets(
  sourceId: string,
  nodes: readonly ConnectNode[],
  edges: readonly ConnectEdge[],
): ConnectNode[] {
  const source = nodes.find((n) => n.id === sourceId);
  if (!source || !canHaveOutgoing(source.kind)) return [];
  return nodes.filter(
    (n) =>
      n.id !== sourceId &&
      canHaveIncoming(n.kind) &&
      !hasConnection(edges, sourceId, n.id),
  );
}

/**
 * Append a connection. LAST is the honest default: a new edge fires alongside the existing ones
 * (every passing edge is taken), and appending is exactly what dragging on the canvas does — so the
 * two entry points produce the same graph rather than two orders for the same gesture. Refuses a
 * duplicate by returning the array unchanged BY IDENTITY, so the caller's `setEdges` is a no-op.
 */
export function appendConnection<E extends ConnectEdge>(
  edges: E[],
  edge: E,
): E[] {
  if (hasConnection(edges, edge.source, edge.target)) return edges;
  return [...edges, edge];
}

/**
 * Move one outgoing edge one place earlier (-1) or later (+1) AMONG ITS SIBLINGS — the other edges
 * leaving the same node — by swapping the two edges' slots in the full array. Swapping (rather than
 * splicing) leaves every unrelated edge exactly where it was, so the saved diff is the one reorder
 * the author asked for. At either end of the sibling list the array comes back unchanged, by
 * identity.
 */
export function moveConnection<E extends ConnectEdge>(
  edges: E[],
  edgeId: string,
  dir: -1 | 1,
): E[] {
  const edge = edges.find((e) => e.id === edgeId);
  if (!edge) return edges;
  const siblings = outgoingConnections(edge.source, edges);
  const at = siblings.findIndex((s) => s.edge.id === edgeId);
  const swapWith = siblings[at + dir];
  if (at < 0 || !swapWith) return edges;
  const next = [...edges];
  const a = siblings[at].index;
  const b = swapWith.index;
  [next[a], next[b]] = [next[b], next[a]];
  return next;
}

/** The condition summary a row shows — "always" when the edge is unconditional. */
export function conditionSummary(condition?: EdgeConditionDraft): string {
  if (!condition?.path.trim()) return "always";
  if (condition.op === "exists") return `${condition.path} exists`;
  return `${condition.path} ${condition.op} ${condition.value}`.trim();
}
