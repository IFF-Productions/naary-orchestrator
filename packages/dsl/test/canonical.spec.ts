import { describe, expect, it } from "vitest";
import { canonicalize } from "../src/canonical";
import type { GraphDef } from "../src/types";

const base: GraphDef = {
  startNodeId: "start",
  nodes: [
    { id: "start", type: "start" },
    { id: "agent", type: "agent", config: { model: "claude-opus-4-8" } },
    { id: "end", type: "end" },
  ],
  edges: [
    { from: "start", to: "agent" },
    { from: "agent", to: "end" },
  ],
};

describe("canonicalize", () => {
  it("is insensitive to object KEY order (cosmetic reordering hashes equal)", () => {
    const reordered: GraphDef = {
      edges: base.edges,
      nodes: base.nodes.map((n) => ({
        type: n.type,
        id: n.id,
        config: n.config,
      })),
      startNodeId: base.startNodeId,
    };
    expect(canonicalize(reordered)).toBe(canonicalize(base));
  });

  it("IS sensitive to edge-array order (edge order is semantic — first declared edge)", () => {
    const swapped: GraphDef = { ...base, edges: [...base.edges].reverse() };
    expect(canonicalize(swapped)).not.toBe(canonicalize(base));
  });

  it("changes when a node id/type/config changes", () => {
    const changedType: GraphDef = {
      ...base,
      nodes: base.nodes.map((n) =>
        n.id === "agent" ? { ...n, type: "mcpTool" } : n,
      ),
    };
    expect(canonicalize(changedType)).not.toBe(canonicalize(base));

    const changedConfig: GraphDef = {
      ...base,
      nodes: base.nodes.map((n) =>
        n.id === "agent" ? { ...n, config: { model: "claude-haiku-4-5" } } : n,
      ),
    };
    expect(canonicalize(changedConfig)).not.toBe(canonicalize(base));
  });
});
