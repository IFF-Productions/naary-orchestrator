import { describe, expect, it } from "vitest";
import type { GraphDef } from "../src/types";
import { evaluateResume } from "../src/resume-eligibility";

/**
 * docs/design/RESUME-FROM-FAILED-NODE.md §3. Every refusal here is a case where resuming at a single
 * node id would produce a plausible-looking WRONG run rather than an error — which is exactly why
 * they are unit tests and not a comment. The permissive cases are just as load-bearing: refusing a
 * resume that IS safe pushes the user back to "rerun", which re-sends the email this feature exists
 * to avoid.
 */

const linear = (): GraphDef => ({
  startNodeId: "a",
  nodes: [
    { id: "a", type: "sendEmail" },
    { id: "b", type: "httpRequest" },
    { id: "c", type: "set" },
    { id: "end", type: "end" },
  ],
  edges: [
    { from: "a", to: "b" },
    { from: "b", to: "c" },
    { from: "c", to: "end" },
  ],
});

const ok = {
  status: "failed",
  hasSnapshot: true,
  executedNodeIds: ["a"] as string[],
};

describe("evaluateResume — the safe case", () => {
  /** The motivating scenario: a non-idempotent node succeeded, the next node failed on a blip. */
  it("resumes a plain sequential node after a non-idempotent node succeeded", () => {
    const r = evaluateResume({ ...ok, failedNodeId: "b", graph: linear() });
    expect(r).toEqual({
      resumable: true,
      warnings: [],
      failedNodeId: "b",
    });
  });

  /**
   * The failed node being at-most-once does NOT refuse — only the caller knows whether the effect
   * landed. But it must be surfaced, because "failed" is not the same as "had no effect".
   */
  it("warns, but allows, when the FAILED node may already have taken effect", () => {
    const r = evaluateResume({
      ...ok,
      failedNodeId: "a",
      graph: linear(),
      executedNodeIds: [],
    });
    expect(r.resumable).toBe(true);
    expect(r.warnings).toEqual(["at_most_once_node"]);
  });
});

describe("evaluateResume — refusals", () => {
  it("refuses anything that isn't a failed run", () => {
    for (const status of ["completed", "running", "cancelled", "rejected"]) {
      const r = evaluateResume({
        ...ok,
        status,
        failedNodeId: "b",
        graph: linear(),
      });
      expect(r.resumable).toBe(false);
      expect(r.reason).toBe("not_a_failure");
      expect(r.detail).toContain(status);
    }
  });

  /** Pairing a recovered ctx with a NEWER graph targets renamed/deleted ids — a hard stop. */
  it("refuses when the exact graph snapshot could not be recovered", () => {
    const r = evaluateResume({ ...ok, failedNodeId: "b", graph: null });
    expect(r.reason).toBe("graph_unavailable");
  });

  /** NULL for rejected / budget_exceeded / circuit_open / invalid_graph, and onError:"continue". */
  it("refuses when no failing node was recorded", () => {
    expect(
      evaluateResume({ ...ok, failedNodeId: null, graph: linear() }).reason,
    ).toBe("no_failed_node");
    expect(
      evaluateResume({ ...ok, failedNodeId: undefined, graph: linear() })
        .reason,
    ).toBe("no_failed_node");
  });

  it("refuses a failing node that isn't in the recovered graph", () => {
    const r = evaluateResume({ ...ok, failedNodeId: "ghost", graph: linear() });
    expect(r.reason).toBe("unknown_node");
    expect(r.failedNodeId).toBe("ghost");
  });

  /** Without ctx, downstream `{{ … }}` resolves to undefined rather than erroring. */
  it("refuses with no snapshot, and passes the specific reason through", () => {
    const r = evaluateResume({
      ...ok,
      hasSnapshot: false,
      snapshotDetail: "Snapshots are turned off (RESUME_SNAPSHOTS=off).",
      failedNodeId: "b",
      graph: linear(),
    });
    expect(r.reason).toBe("snapshot_missing");
    expect(r.detail).toContain("RESUME_SNAPSHOTS=off");
  });

  /**
   * Per-item regions. Only the LAST item survives in ctx[splitOutId] and the iteration index is a
   * workflow local, so this is the one refusal whose absence would yield a *successful* wrong run.
   */
  it("refuses inside a per-item region, and at its brackets", () => {
    const graph: GraphDef = {
      startNodeId: "s",
      nodes: [
        { id: "s", type: "set" },
        { id: "split", type: "splitOut" },
        { id: "work", type: "httpRequest" },
        { id: "loopEnd", type: "loopEnd" },
        { id: "end", type: "end" },
      ],
      edges: [
        { from: "s", to: "split" },
        { from: "split", to: "work" },
        { from: "work", to: "loopEnd" },
        { from: "loopEnd", to: "end" },
      ],
    };
    // NB this region is deliberately mis-configured (the loopEnd has no `collectFrom`), so
    // computeItemsRegions reports an error and NO regions — the exact state in which a
    // regions-only check would wave a region member through. The structural walk must still catch it.
    for (const id of ["work", "split", "loopEnd"]) {
      const r = evaluateResume({ ...ok, failedNodeId: id, graph });
      expect(r.reason, `expected a refusal for "${id}"`).toBe(
        "inside_item_region",
      );
    }
  });

  it("refuses loop / child-run nodes whose per-iteration progress isn't recorded", () => {
    for (const type of ["forEach", "executeSubWorkflow"] as const) {
      const graph: GraphDef = {
        startNodeId: "a",
        nodes: [
          { id: "a", type: "set" },
          { id: "loop", type },
          { id: "end", type: "end" },
        ],
        edges: [
          { from: "a", to: "loop" },
          { from: "loop", to: "end" },
        ],
      };
      const r = evaluateResume({ ...ok, failedNodeId: "loop", graph });
      expect(r.reason).toBe("loop_or_child_node");
      expect(r.detail).toContain(type);
    }
  });

  /** The walk must STOP at loopEnd — otherwise every node after a region looks like a member. */
  it("does NOT treat nodes downstream of the region as inside it", () => {
    const graph: GraphDef = {
      startNodeId: "s",
      nodes: [
        { id: "s", type: "set" },
        { id: "split", type: "splitOut" },
        { id: "work", type: "set" },
        { id: "loopEnd", type: "loopEnd" },
        { id: "after", type: "httpRequest" },
        { id: "end", type: "end" },
      ],
      edges: [
        { from: "s", to: "split" },
        { from: "split", to: "work" },
        { from: "work", to: "loopEnd" },
        { from: "loopEnd", to: "after" },
        { from: "after", to: "end" },
      ],
    };
    const r = evaluateResume({
      ...ok,
      failedNodeId: "after",
      graph,
      executedNodeIds: ["s", "split", "work", "loopEnd"],
    });
    expect(r.resumable).toBe(true);
  });
});

describe("evaluateResume — parallel fan-out", () => {
  const forked = (): GraphDef => ({
    startNodeId: "a",
    nodes: [
      { id: "a", type: "set" },
      { id: "b", type: "httpRequest" },
      { id: "c", type: "httpRequest" },
      { id: "m", type: "merge" },
      { id: "end", type: "end" },
    ],
    edges: [
      { from: "a", to: "b" },
      { from: "a", to: "c" },
      { from: "b", to: "m" },
      { from: "c", to: "m" },
      { from: "m", to: "end" },
    ],
  });

  /** Both successors produced output ⇒ the interpreter really did run them concurrently. */
  it("refuses when a fan-out actually happened", () => {
    const r = evaluateResume({
      status: "failed",
      hasSnapshot: true,
      failedNodeId: "m",
      graph: forked(),
      executedNodeIds: ["a", "b", "c"],
    });
    expect(r.reason).toBe("parallel_fanout");
    expect(r.detail).toContain('"a"');
  });

  /** The failed node counts as a taken branch even though it produced no output. */
  it("counts the failed node itself as one of the branches", () => {
    const r = evaluateResume({
      status: "failed",
      hasSnapshot: true,
      failedNodeId: "c",
      graph: forked(),
      executedNodeIds: ["a", "b"],
    });
    expect(r.reason).toBe("parallel_fanout");
  });

  /**
   * The reason this is data-driven rather than static: a graph CONTAINING a branch point is fine as
   * long as this run only took one edge. A static "2 out-edges ⇒ refuse" rule would refuse every
   * graph with a switch, pushing users back to a full rerun for no reason.
   */
  it("allows a branchy graph when this run only took ONE branch", () => {
    const graph: GraphDef = {
      startNodeId: "a",
      nodes: [
        { id: "a", type: "switch" },
        { id: "b", type: "httpRequest" },
        { id: "c", type: "httpRequest" },
        { id: "end", type: "end" },
      ],
      edges: [
        {
          from: "a",
          to: "b",
          condition: { path: "a.matched", op: "eq", value: "x" },
        },
        {
          from: "a",
          to: "c",
          condition: { path: "a.matched", op: "eq", value: "y" },
        },
        { from: "b", to: "end" },
        { from: "c", to: "end" },
      ],
    };
    const r = evaluateResume({
      status: "failed",
      hasSnapshot: true,
      failedNodeId: "b",
      graph,
      executedNodeIds: ["a"],
    });
    expect(r.resumable).toBe(true);
  });
});
