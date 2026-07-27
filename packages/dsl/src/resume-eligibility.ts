/**
 * Can this failed run be resumed AT its failed node, or must we refuse?
 *
 * See docs/design/RESUME-FROM-FAILED-NODE.md §3. Pure and platform-agnostic on purpose: every
 * refusal branch below is a case where restarting at a single node id would produce a
 * plausible-looking WRONG run, so each one needs to be unit-testable without Temporal, Postgres or a
 * browser. The API composes this with "is there a ctx snapshot"; the graph analysis lives here.
 */
import { computeItemsRegions } from "./items-region";
import type { GraphDef, NodeType } from "./types";

/** Why a resume is refused. Returned to the UI verbatim so the button can explain itself. */
export type ResumeRefusal =
  | "not_a_failure"
  | "graph_unavailable"
  | "no_failed_node"
  | "unknown_node"
  | "snapshot_missing"
  | "inside_item_region"
  | "loop_or_child_node"
  | "parallel_fanout";

/** Allowed, but the caller must acknowledge it (see §3). */
export type ResumeWarning = "at_most_once_node";

export interface ResumeEligibility {
  resumable: boolean;
  reason?: ResumeRefusal;
  /** Human-readable expansion of `reason`, safe to show a user (never run content). */
  detail?: string;
  warnings: ResumeWarning[];
  /** Echoed back so a caller doesn't re-derive it. */
  failedNodeId?: string;
}

export interface ResumeEligibilityInput {
  /** The run's terminal status. Only "failed" is resumable. */
  status: string;
  /** The node that threw. NULL for non-thrown terminals — see `no_failed_node`. */
  failedNodeId?: string | null;
  /** The EXACT graph snapshot the run walked, recovered from history — never the latest version. */
  graph?: GraphDef | null;
  /** Node ids that produced output. Used to detect a fan-out that ACTUALLY happened. */
  executedNodeIds?: readonly string[];
  /** Whether a ctx snapshot is retrievable. False ⇒ refuse; `snapshotDetail` says why. */
  hasSnapshot: boolean;
  /** Distinguishes disabled / unconfigured / expired for the `snapshot_missing` message. */
  snapshotDetail?: string;
}

/**
 * Node kinds whose activity may have taken effect even though the node reported failure (a 500
 * after the write, an SMTP handoff that then timed out). Resuming re-runs the node, so these need an
 * explicit acknowledgement — the mirror image of `RETRYABLE_NODE_KINDS`' membership rule.
 */
const AT_MOST_ONCE_KINDS: readonly NodeType[] = [
  "sqlExec",
  "sendEmail",
  "code",
  "codeAgent",
  "integration",
];

/** Nodes that own child runs / per-iteration state the snapshot cannot express. */
const LOOP_OR_CHILD_KINDS: readonly NodeType[] = [
  "forEach",
  "executeSubWorkflow",
];

/**
 * Is `nodeId` inside a `splitOut … loopEnd` region?
 *
 * Deliberately STRUCTURAL — forward reachability from every `splitOut`, stopping at any `loopEnd` —
 * rather than asking `computeItemsRegions`. That helper validates the region and returns
 * `{ regions: [] }` on any config problem (e.g. a `loopEnd` with no `collectFrom`), which would make
 * this check silently pass a region member through: the precise failure mode the refusal exists to
 * prevent. `computeItemsRegions` is still consulted afterwards, purely to catch a region member that
 * is somehow NOT forward-reachable from its own splitOut.
 */
function isInsideItemRegion(graph: GraphDef, nodeId: string): boolean {
  const out = new Map<string, string[]>();
  for (const e of graph.edges) {
    const list = out.get(e.from);
    if (list) list.push(e.to);
    else out.set(e.from, [e.to]);
  }
  const typeOf = new Map(graph.nodes.map((n) => [n.id, n.type]));

  for (const start of graph.nodes.filter((n) => n.type === "splitOut")) {
    const seen = new Set<string>([start.id]);
    const queue = [...(out.get(start.id) ?? [])];
    while (queue.length > 0) {
      const id = queue.shift() as string;
      if (seen.has(id)) continue;
      seen.add(id);
      if (id === nodeId) return true;
      // The region ENDS at loopEnd — don't walk past it into the rest of the graph, or every
      // downstream node would look like a region member.
      if (typeOf.get(id) === "loopEnd") continue;
      queue.push(...(out.get(id) ?? []));
    }
  }
  return computeItemsRegions(graph).regions.some((r) =>
    r.regionNodeIds.includes(nodeId),
  );
}

const refuse = (
  reason: ResumeRefusal,
  detail: string,
  failedNodeId?: string,
): ResumeEligibility => ({
  resumable: false,
  reason,
  detail,
  warnings: [],
  ...(failedNodeId ? { failedNodeId } : {}),
});

export function evaluateResume(
  input: ResumeEligibilityInput,
): ResumeEligibility {
  const { status, failedNodeId, graph, hasSnapshot } = input;
  const executed = new Set(input.executedNodeIds ?? []);

  if (status !== "failed") {
    return refuse(
      "not_a_failure",
      `Only a failed run can be resumed (this one is "${status}").`,
    );
  }
  if (!graph) {
    // Pairing a recovered ctx with the LATEST graph is silent wrongness (renamed/deleted ids), so
    // an unrecoverable snapshot is a hard stop rather than a fallback.
    return refuse(
      "graph_unavailable",
      "The exact graph this run walked could not be recovered, and resuming against a newer version would target the wrong nodes.",
    );
  }
  if (!failedNodeId) {
    return refuse(
      "no_failed_node",
      "This run has no recorded failing node — it ended without a node throwing (e.g. rejected, budget exceeded, or an invalid graph), so there is nothing to resume at.",
    );
  }

  const node = graph.nodes.find((n) => n.id === failedNodeId);
  if (!node) {
    return refuse(
      "unknown_node",
      `The failing node "${failedNodeId}" is not in the recovered graph.`,
      failedNodeId,
    );
  }

  if (!hasSnapshot) {
    return refuse(
      "snapshot_missing",
      input.snapshotDetail ??
        "No saved state is available for this run, so the resumed run would start with an empty context.",
      failedNodeId,
    );
  }

  // --- per-item regions: the strongest silent-wrongness hazard ---------------------------------
  // Only the LAST item survives in ctx[splitOutId] and the iteration index lives in a workflow
  // local, so resuming at a region member re-runs it against stale data and SUCCEEDS with the wrong
  // result. `splitOut`/`loopEnd` themselves are region boundaries and equally unresumable.
  if (node.type === "splitOut" || node.type === "loopEnd") {
    return refuse(
      "inside_item_region",
      "This node brackets a per-item region. Per-iteration progress isn't recorded, so a resume can't tell which items were already handled.",
      failedNodeId,
    );
  }
  if (isInsideItemRegion(graph, failedNodeId)) {
    return refuse(
      "inside_item_region",
      "The failure happened inside a per-item region. Only the last item's data survives, so resuming would re-run the node against the wrong item.",
      failedNodeId,
    );
  }

  if (LOOP_OR_CHILD_KINDS.includes(node.type)) {
    return refuse(
      "loop_or_child_node",
      `A "${node.type}" node owns child runs whose per-iteration progress isn't recorded, so resuming would re-run every child — including the ones that already succeeded.`,
      failedNodeId,
    );
  }

  // --- parallel fan-out ------------------------------------------------------------------------
  // Detected from what ACTUALLY ran, not statically: a static "any node with 2 out-edges" rule
  // would refuse every graph containing an unused switch branch. If two successors of the same node
  // both produced output, the interpreter genuinely ran them concurrently (exec-chain fans out when
  // more than one next node is satisfied) — and one startNodeId cannot express "branch B failed
  // while A finished and C was still in flight", so C's remaining work would be dropped.
  const fanOut = graph.nodes.find((n) => {
    if (!executed.has(n.id)) return false;
    const takenTargets = graph.edges
      .filter((e) => e.from === n.id)
      .map((e) => e.to)
      .filter((to) => executed.has(to) || to === failedNodeId);
    return new Set(takenTargets).size > 1;
  });
  if (fanOut) {
    return refuse(
      "parallel_fanout",
      `This run branched in parallel at "${fanOut.id}". Resuming at a single node would silently drop the other branch's remaining work.`,
      failedNodeId,
    );
  }

  const warnings: ResumeWarning[] = AT_MOST_ONCE_KINDS.includes(node.type)
    ? ["at_most_once_node"]
    : [];
  return { resumable: true, warnings, failedNodeId };
}

/** Message for the one warning, shared by the API and the UI so they can't diverge. */
export function resumeWarningText(
  warning: ResumeWarning,
  nodeType: string,
): string {
  if (warning === "at_most_once_node") {
    return `The failing "${nodeType}" node may already have taken effect before it reported failure. Resuming re-runs it, which could duplicate that effect.`;
  }
  return "";
}
