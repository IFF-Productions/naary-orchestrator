import type { GraphDef } from "@naary/dsl";
import { describe, expect, it } from "vitest";
import { compileGraph } from "../src/lib/compile-graph";
import { decompileGraph } from "../src/lib/decompile-graph";

const GRAPH: GraphDef = {
  startNodeId: "start",
  nodes: [
    { id: "start", type: "start" },
    { id: "agent", type: "agent", config: { systemPrompt: "triage" } },
    { id: "approval", type: "humanApproval" },
    { id: "end", type: "end" },
  ],
  edges: [
    { from: "start", to: "agent" },
    {
      from: "agent",
      to: "approval",
      condition: { path: "agent.urgency", op: "gt", value: 5 },
    },
    { from: "approval", to: "end" },
  ],
};

describe("decompileGraph", () => {
  it("recovers nodes (with config) and edges from a GraphDef", () => {
    const { nodes, edges } = decompileGraph(GRAPH);
    expect(nodes.map((n) => n.id).sort()).toEqual([
      "agent",
      "approval",
      "end",
      "start",
    ]);
    expect(nodes.find((n) => n.id === "agent")?.config).toEqual({
      systemPrompt: "triage",
    });
    expect(edges.map((e) => `${e.source}->${e.target}`)).toEqual([
      "start->agent",
      "agent->approval",
      "approval->end",
    ]);
  });

  it("surfaces a NodeDef.name back into config-space as __name (round-trips)", () => {
    const named: GraphDef = {
      startNodeId: "start",
      nodes: [
        { id: "start", type: "start" },
        {
          id: "agent",
          type: "agent",
          name: "Classify ticket",
          config: { systemPrompt: "x" },
        },
        { id: "end", type: "end" },
      ],
      edges: [
        { from: "start", to: "agent" },
        { from: "agent", to: "end" },
      ],
    };
    const { nodes } = decompileGraph(named);
    // The editor works in config-space, so name comes back as __name alongside real config.
    expect(nodes.find((n) => n.id === "agent")?.config).toEqual({
      systemPrompt: "x",
      __name: "Classify ticket",
    });
    // …and compiling again lifts it straight back to NodeDef.name.
    const { graph } = compileGraph(nodes, decompileGraph(named).edges);
    expect(graph?.nodes.find((n) => n.id === "agent")?.name).toBe(
      "Classify ticket",
    );
  });

  it("auto-layouts left→right by BFS depth from the start node", () => {
    const { nodes } = decompileGraph(GRAPH);
    const x = (id: string) => nodes.find((n) => n.id === id)?.position.x ?? -1;
    expect(x("start")).toBeLessThan(x("agent"));
    expect(x("agent")).toBeLessThan(x("approval"));
    expect(x("approval")).toBeLessThan(x("end"));
  });

  it("restores an edge condition as an editable draft", () => {
    const { edges } = decompileGraph(GRAPH);
    expect(edges.find((e) => e.target === "approval")?.condition).toEqual({
      path: "agent.urgency",
      op: "gt",
      value: "5",
    });
  });

  it("round-trips compile → decompile → compile to the same GraphDef", () => {
    const first = compileGraph(
      decompileGraph(GRAPH).nodes,
      decompileGraph(GRAPH).edges,
    );
    expect(first.error).toBeUndefined();
    expect(first.graph?.startNodeId).toBe("start");
    expect(first.graph?.nodes.map((n) => n.id).sort()).toEqual([
      "agent",
      "approval",
      "end",
      "start",
    ]);
    // the gt:5 condition survives the raw-string round-trip back to number 5
    expect(
      first.graph?.edges.find((e) => e.to === "approval")?.condition,
    ).toEqual({ path: "agent.urgency", op: "gt", value: 5 });
  });
});
