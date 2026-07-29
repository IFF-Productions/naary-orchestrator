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

  it("counts a display RENAME as a change (nothing executes off `name`, but a save keeps it)", () => {
    const to = structuredClone(base);
    const classify = to.nodes.find((n) => n.id === "classify");
    if (classify) classify.name = "Triage the ticket";
    const d = diffGraphs(base, to);
    expect(d.nodesChanged.map((c) => c.id)).toEqual(["classify"]);
    expect(d.nodesChanged[0].fields).toEqual(["name"]);
    expect(graphsEqual(base, to)).toBe(false);
  });

  it("is NODE-order independent (nodes are matched by id)", () => {
    const reordered: GraphDef = { ...base, nodes: [...base.nodes].reverse() };
    expect(graphsEqual(base, reordered)).toBe(true);
  });

  it("treats EDGE order as significant (traversal precedence) → flags a reorder", () => {
    // Same edge SET, different order — a real behaviour-affecting change (first-match wins).
    const branchy: GraphDef = {
      startNodeId: "start",
      nodes: [
        { id: "start", type: "webhookTrigger" },
        { id: "a", type: "end" },
        { id: "b", type: "end" },
      ],
      edges: [
        { from: "start", to: "a" },
        { from: "start", to: "b" },
      ],
    };
    const swapped: GraphDef = {
      ...branchy,
      edges: [...branchy.edges].reverse(),
    };
    const d = diffGraphs(branchy, swapped);
    expect(d.edgesAdded).toEqual([]);
    expect(d.edgesRemoved).toEqual([]);
    expect(d.edgesReordered).toBe(true);
    expect(graphsEqual(branchy, swapped)).toBe(false);
  });

  it("flags a changed start node", () => {
    const to = { ...structuredClone(base), startNodeId: "classify" };
    expect(diffGraphs(base, to).startNodeChanged).toBe(true);
  });
});
