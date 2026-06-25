import { describe, expect, it } from "vitest";
import { sampleGraph } from "../src/sample-graph";
import { walk } from "../src/walk";
import type { GraphDef } from "../src/types";

describe("walk — deterministic linear traversal", () => {
  it("returns the sample graph in start→agent→humanApproval→end order", () => {
    expect(walk(sampleGraph).map((n) => n.type)).toEqual([
      "start",
      "agent",
      "humanApproval",
      "end",
    ]);
  });

  it("produces identical output across repeated calls (deterministic)", () => {
    expect(walk(sampleGraph).map((n) => n.id)).toEqual(
      walk(sampleGraph).map((n) => n.id),
    );
  });

  it("throws on an edge to an unknown node", () => {
    const broken: GraphDef = {
      startNodeId: "a",
      nodes: [{ id: "a", type: "start" }],
      edges: [{ from: "a", to: "ghost" }],
    };
    expect(() => walk(broken)).toThrow(/unknown node/);
  });

  it("throws on a cycle rather than looping forever", () => {
    const cyclic: GraphDef = {
      startNodeId: "a",
      nodes: [
        { id: "a", type: "start" },
        { id: "b", type: "agent" },
      ],
      edges: [
        { from: "a", to: "b" },
        { from: "b", to: "a" },
      ],
    };
    expect(() => walk(cyclic)).toThrow(/cycle detected/);
  });
});
