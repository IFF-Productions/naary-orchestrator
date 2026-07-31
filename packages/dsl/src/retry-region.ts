/**
 * RETRY REGIONS — a `retry … retryEnd` pair brackets a span that repeats until it succeeds.
 *
 * Asked for as: "anything between the start and end of the retry node can be repeated until success
 * or reach max retry". The gap it fills is a transient MULTI-STEP failure — fetch → parse →
 * validate, where retrying has to restart at the fetch. Per-node `retry` (NodeDef.retry → Temporal's
 * RetryPolicy) retries ONE activity in place and cannot span a sequence.
 *
 * Modelled on `items-region.ts` deliberately, including its central rule: participation is DRAWN
 * (the bracket), never inferred, so the whole correctness story reduces to validating the drawn
 * region STRUCTURALLY at save time — where a bad graph is a correctable 400 rather than a frozen
 * runtime corruption. Like `computeItemsRegions`, this function is the single source of truth: the
 * save gate and the interpreter both call it, so they cannot disagree about what a region is.
 *
 * WHAT MAY BE INSIDE IS THE INVERSE OF THE ITEMS REGION, and that is the interesting part. An items
 * region allows only PURE nodes, because it fans out. A retry region exists precisely to repeat the
 * things that FAIL — http, graphql, sql reads, mcp, agents — so it must allow those. What it must
 * not allow is anything whose effect cannot be undone: a second attempt would send the email again,
 * charge the card again, run the INSERT again.
 *
 * That line already exists. `RETRYABLE_NODE_KINDS` is the set the per-node retry policy is honored
 * for, and its comment says why the others are excluded: "whose retry would risk a double-effect".
 * Deriving from that constant rather than restating it means the two cannot drift, and a test
 * asserts they agree.
 */
import { isIntegrationWriteAction } from "./integration-write";
import { isPureNode } from "./pure-node";
import { RETRYABLE_NODE_KINDS } from "./types/core";
import type { EdgeDef, GraphDef, NodeDef } from "./types";

export interface RetryRegion {
  retryId: string;
  retryEndId: string;
  /** Nodes between the brackets, in execution order (excludes `retry` and `retryEnd`). */
  regionNodeIds: string[];
  /** Resolved attempt policy — defaults applied, so the interpreter never re-derives them. */
  policy: ResolvedRetryPolicy;
}

export interface ResolvedRetryPolicy {
  maxAttempts: number;
  initialIntervalSeconds: number;
  backoffCoefficient: number;
  maxIntervalSeconds?: number;
}

export interface RetryRegionResult {
  regions: RetryRegion[];
  /** Set when the graph is structurally invalid — the save gate turns this into a 400. */
  error?: string;
}

/**
 * Defaults, matching `NodeRetryPolicy`'s documented ones so the two retry features behave the same
 * when left alone. A region with no config retries 3 times, 1s then 2s.
 */
const DEFAULTS: ResolvedRetryPolicy = {
  maxAttempts: 3,
  initialIntervalSeconds: 1,
  backoffCoefficient: 2,
};

/** Hard ceiling on attempts. A typo'd 100000 would park a run for months on a durable timer. */
const MAX_ATTEMPTS_CEILING = 25;

/**
 * May this node type be repeated?
 *
 * Derived from `RETRYABLE_NODE_KINDS` rather than listed again — that constant already answers
 * "is this safe to run more than once", and it is the single source of truth the canvas and a
 * worker drift test already key off.
 *
 * `integration` is the one type that cannot be answered by kind alone: a READ (list issues) is
 * safe to repeat and a WRITE (create issue) is not, which is why it is absent from
 * `RETRYABLE_NODE_KINDS` wholesale. It is decided per-node in `unsafeNodeReason` below.
 */
const REPEATABLE_KINDS: ReadonlySet<string> = new Set<string>(
  RETRYABLE_NODE_KINDS,
);

/** Structural nodes that carry no effect at all, so repeating them is free. */
function structurallyRepeatable(type: string): boolean {
  return isPureNode(type) || type === "noOp";
}

/**
 * Why this node cannot be inside a retry region — or undefined if it can.
 *
 * The message NAMES the node and says what to do about it. An author who has drawn a bracket
 * around a `sendEmail` needs to know which node and where to move it, not that "the region is
 * invalid".
 */
export function unsafeNodeReason(node: NodeDef): string | undefined {
  const { type, id } = node;

  if (structurallyRepeatable(type)) return undefined;

  // Integration: safe to repeat only when the action READS. The write-set is derived from the
  // catalog (see integration-write.ts), so a new write action is covered without touching this.
  if (type === "integration") {
    const cfg = (node.config ?? {}) as { provider?: string; action?: string };
    // An unconfigured integration node is refused too: we cannot prove it is a read, and the save
    // gate is the last place to catch it before a retry could double an effect. Fail closed.
    if (
      !cfg.provider ||
      !cfg.action ||
      isIntegrationWriteAction(cfg.provider, cfg.action)
    ) {
      return (
        `retry region contains integration '${id}' (${cfg.provider}/${cfg.action}), which WRITES — ` +
        `a second attempt would perform it again. Move it after the retry end, or take it out of ` +
        `the region.`
      );
    }
    return undefined;
  }

  if (REPEATABLE_KINDS.has(type)) return undefined;

  // Repeating a human decision or a child run is not a retry; it is a different feature.
  if (
    type === "humanApproval" ||
    type === "wait" ||
    type === "executeSubWorkflow" ||
    type === "forEach"
  ) {
    return (
      `retry region contains ${type} '${id}', which can't be repeated — a retry would re-run the ` +
      `whole pause/child. Move it outside the region.`
    );
  }

  // Everything else is an at-most-once effect: sqlExec, sendEmail, code, codeAgent.
  return (
    `retry region contains ${type} '${id}', which can't be safely repeated — a second attempt ` +
    `would perform its effect again. Move it after the retry end, or take it out of the region.`
  );
}

/** Read the author's knobs, clamped. Invalid/absent values fall back rather than failing a save. */
function resolvePolicy(node: NodeDef): ResolvedRetryPolicy {
  const cfg = (node.config ?? {}) as Record<string, unknown>;
  const num = (k: string, min: number): number | undefined => {
    const v = cfg[k];
    return typeof v === "number" && Number.isFinite(v) && v >= min
      ? v
      : undefined;
  };
  return {
    maxAttempts: Math.min(
      num("maxAttempts", 1) ?? DEFAULTS.maxAttempts,
      MAX_ATTEMPTS_CEILING,
    ),
    initialIntervalSeconds:
      num("initialIntervalSeconds", 0) ?? DEFAULTS.initialIntervalSeconds,
    backoffCoefficient:
      num("backoffCoefficient", 1) ?? DEFAULTS.backoffCoefficient,
    ...(num("maxIntervalSeconds", 0) !== undefined
      ? { maxIntervalSeconds: num("maxIntervalSeconds", 0) }
      : {}),
  };
}

/**
 * How long to wait before `attempt` (1-based; attempt 1 never waits).
 *
 * Exported and pure so the interpreter and its tests agree on the schedule without either
 * re-deriving it — the same reason the region walk itself is shared.
 */
export function retryBackoffMs(
  policy: ResolvedRetryPolicy,
  attempt: number,
): number {
  if (attempt <= 1) return 0;
  const raw =
    policy.initialIntervalSeconds *
    policy.backoffCoefficient ** (attempt - 2) *
    1000;
  const capped =
    policy.maxIntervalSeconds !== undefined
      ? Math.min(raw, policy.maxIntervalSeconds * 1000)
      : raw;
  return Math.max(0, Math.round(capped));
}

export function computeRetryRegions(graph: GraphDef): RetryRegionResult {
  const nodeById = new Map((graph.nodes ?? []).map((n) => [n.id, n]));
  const outEdges = new Map<string, EdgeDef[]>();
  for (const e of graph.edges ?? []) {
    const list = outEdges.get(e.from);
    if (list) list.push(e);
    else outEdges.set(e.from, [e]);
  }
  const outFrom = (id: string): string[] =>
    (outEdges.get(id) ?? []).map((e) => e.to);

  const regions: RetryRegion[] = [];
  const claimedEnds = new Set<string>();
  const err = (msg: string): RetryRegionResult => ({ regions, error: msg });

  for (const n of graph.nodes ?? []) {
    if (n.type !== "retry") continue;

    const outs = outFrom(n.id);
    if (outs.length !== 1) {
      return err(`retry '${n.id}' must have exactly one outgoing edge`);
    }
    if ((outEdges.get(n.id) ?? []).some((e) => e.condition !== undefined)) {
      return err(
        `retry '${n.id}' has a conditional outgoing edge — the region's own edges must be ` +
          `unconditional, or an attempt could skip the very nodes it is meant to repeat`,
      );
    }

    const regionNodeIds: string[] = [];
    const seen = new Set<string>();
    let cur: string | undefined = outs[0];
    let endId: string | undefined;

    while (true) {
      if (cur === undefined) {
        return err(`retry '${n.id}' has no matching retryEnd on its path`);
      }
      if (seen.has(cur)) {
        return err(`retry '${n.id}' region loops back on itself at '${cur}'`);
      }
      seen.add(cur);

      const node = nodeById.get(cur);
      if (!node) {
        return err(`retry '${n.id}' path reaches unknown node '${cur}'`);
      }
      if (node.type === "retryEnd") {
        endId = cur;
        break;
      }
      if (node.type === "retry") {
        return err(
          `nested retry '${cur}' inside the region of '${n.id}' (not supported)`,
        );
      }
      // A path that runs into a TERMINAL node was never closed. Reporting "end can't be repeated"
      // here would be true and useless: the author's mistake is the missing bracket, not the node
      // they happened to reach. (Caught by the unclosed-region test, which asserted the message.)
      if (node.type === "end" || node.type === "stopAndError") {
        return err(
          `retry '${n.id}' has no matching retryEnd on its path — it reaches '${cur}' instead`,
        );
      }
      const unsafe = unsafeNodeReason(node);
      if (unsafe) return err(unsafe);

      regionNodeIds.push(cur);

      const nexts = outFrom(cur);
      if (nexts.length !== 1) {
        return err(
          `retry region node '${cur}' must have exactly one outgoing edge (branching inside a ` +
            `retry region is not supported)`,
        );
      }
      cur = nexts[0];
    }

    if (claimedEnds.has(endId)) {
      return err(`retryEnd '${endId}' is claimed by more than one retry`);
    }
    claimedEnds.add(endId);
    regions.push({
      retryId: n.id,
      retryEndId: endId,
      regionNodeIds,
      policy: resolvePolicy(n),
    });
  }

  // A `retryEnd` with no `retry` reaching it would silently do nothing at run time.
  for (const n of graph.nodes ?? []) {
    if (n.type === "retryEnd" && !claimedEnds.has(n.id)) {
      return err(`retryEnd '${n.id}' has no matching retry`);
    }
  }

  return { regions };
}
