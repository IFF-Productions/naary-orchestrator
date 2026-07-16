import { describe, expect, it } from "vitest";
import { diffGraphs, graphsEqual } from "../src/graph-diff";
import type { GraphDef } from "../src/types";

const base: GraphDef = {
  startNodeId: "start",
  nodes: [
    { id: "start", type: "webhookTrigger" },
    { id: "classify", type: "agent", config: { model: "claude-sonnet-5" } },
    { id: "end", type: "end" },
  ],
  edges: [
    { from: "start", to: "classify" },
    { from: "classify", to: "end" },
  ],
};

describe("diffGraphs", () => {
  it("reports no changes for an identical graph (and graphsEqual is true)", () => {
    const d = diffGraphs(base, structuredClone(base));
    expect(d.nodesAdded).toEqual([]);
    expect(d.nodesRemoved).toEqual([]);
    expect(d.nodesChanged).toEqual([]);
    expect(d.edgesAdded).toEqual([]);
    expect(d.edgesRemoved).toEqual([]);
    expect(graphsEqual(base, structuredClone(base))).toBe(true);
  });

  it("detects an added node + its edge", () => {
    const to: GraphDef = {
      startNodeId: "start",
      nodes: [...base.nodes, { id: "notify", type: "mcpTool" }],
      edges: [
        { from: "start", to: "classify" },
        { from: "classify", to: "notify" },
        { from: "notify", to: "end" },
      ],
    };
    const d = diffGraphs(base, to);
    expect(d.nodesAdded.map((n) => n.id)).toEqual(["notify"]);
    expect(d.edgesAdded).toContainEqual({ from: "classify", to: "notify" });
    expect(d.edgesAdded).toContainEqual({ from: "notify", to: "end" });
    // The old classify->end edge is gone.
    expect(d.edgesRemoved).toContainEqual({ from: "classify", to: "end" });
    expect(graphsEqual(base, to)).toBe(false);
  });

  it("detects a removed node", () => {
    const to: GraphDef = {
      startNodeId: "start",
      nodes: base.nodes.filter((n) => n.id !== "classify"),
      edges: [{ from: "start", to: "end" }],
    };
    const d = diffGraphs(base, to);
    expect(d.nodesRemoved.map((n) => n.id)).toEqual(["classify"]);
  });

  it("reports the changed fields of a reconfigured node", () => {
    const to = structuredClone(base);
    const classify = to.nodes.find((n) => n.id === "classify");
    if (classify) {
      classify.config = { model: "claude-opus-4-8" };
      classify.retry = { maxAttempts: 3 };
    }
    const d = diffGraphs(base, to);
    expect(d.nodesChanged).toHaveLength(1);
    expect(d.nodesChanged[0].id).toBe("classify");
    expect(d.nodesChanged[0].fields.sort()).toEqual(["config", "retry"]);
  });

  it("is order-independent for nodes and edges", () => {
    const reordered: GraphDef = {
      startNodeId: "start",
      nodes: [...base.nodes].reverse(),
      edges: [...base.edges].reverse(),
    };
    expect(graphsEqual(base, reordered)).toBe(true);
  });

  it("flags a changed start node", () => {
    const to = { ...structuredClone(base), startNodeId: "classify" };
    expect(diffGraphs(base, to).startNodeChanged).toBe(true);
  });
});
