import { describe, expect, it } from "vitest";
import { compileGraph } from "../src/lib/compile-graph";
import type { CanvasEdge, CanvasNode } from "../src/lib/graph-model";

const at = (x: number) => ({ x, y: 0 });

/** The credential-free demo graph: start → humanApproval → end (no BYOK key). */
const DEMO_NODES: CanvasNode[] = [
  { id: "start", type: "start", position: at(0) },
  { id: "approval", type: "humanApproval", position: at(1) },
  { id: "end", type: "end", position: at(2) },
];
const DEMO_EDGES: CanvasEdge[] = [
  { id: "e1", source: "start", target: "approval" },
  { id: "e2", source: "approval", target: "end" },
];

describe("compileGraph", () => {
  it("compiles a valid start → approval → end graph", () => {
    const { graph, error } = compileGraph(DEMO_NODES, DEMO_EDGES);
    expect(error).toBeUndefined();
    expect(graph).toBeDefined();
    expect(graph?.startNodeId).toBe("start");
    expect(graph?.nodes).toHaveLength(3);
    expect(graph?.edges).toEqual([
      { from: "start", to: "approval" },
      { from: "approval", to: "end" },
    ]);
  });

  it("carries per-node config through, omitting empty config", () => {
    const nodes: CanvasNode[] = [
      { id: "s", type: "start", position: at(0) },
      {
        id: "a",
        type: "agent",
        position: at(1),
        config: { systemPrompt: "triage" },
      },
      { id: "e", type: "end", position: at(2), config: {} },
    ];
    const { graph } = compileGraph(nodes, [
      { id: "e1", source: "s", target: "a" },
      { id: "e2", source: "a", target: "e" },
    ]);
    expect(graph?.nodes.find((n) => n.id === "a")?.config).toEqual({
      systemPrompt: "triage",
    });
    // empty config object is dropped, not emitted as `config: {}`
    expect(graph?.nodes.find((n) => n.id === "e")?.config).toBeUndefined();
  });

  it("errors on an empty canvas", () => {
    expect(compileGraph([], []).error).toMatch(/empty canvas/i);
  });

  it("errors when there is no entry node", () => {
    const nodes: CanvasNode[] = [
      { id: "a", type: "agent", position: at(0) },
      { id: "e", type: "end", position: at(1) },
    ];
    expect(compileGraph(nodes, []).error).toMatch(/no entry node/i);
  });

  it("errors when there are multiple entry nodes", () => {
    const nodes: CanvasNode[] = [
      { id: "s1", type: "start", position: at(0) },
      { id: "s2", type: "webhookTrigger", position: at(1) },
    ];
    expect(compileGraph(nodes, []).error).toMatch(/multiple entry/i);
  });

  it("rejects a dangling edge (target is not a node) — matches validateGraph", () => {
    const { error } = compileGraph(DEMO_NODES, [
      { id: "e1", source: "start", target: "ghost" },
    ]);
    expect(error).toMatch(/'ghost' is not a node/);
  });

  it("rejects duplicate node ids — matches validateGraph", () => {
    const nodes: CanvasNode[] = [
      { id: "start", type: "start", position: at(0) },
      { id: "start", type: "end", position: at(1) },
    ];
    expect(compileGraph(nodes, []).error).toMatch(/duplicate node id/);
  });

  describe("edge conditions", () => {
    const nodes: CanvasNode[] = [
      { id: "start", type: "start", position: at(0) },
      { id: "a", type: "agent", position: at(1) },
      { id: "end", type: "end", position: at(2) },
    ];
    const edge = (condition?: CanvasEdge["condition"]): CanvasEdge[] => [
      { id: "e1", source: "start", target: "a" },
      { id: "e2", source: "a", target: "end", condition },
    ];
    const condOf = (edges: CanvasEdge[]) =>
      compileGraph(nodes, edges).graph?.edges.find((x) => x.to === "end")
        ?.condition;

    it("omits the condition for a blank path (unconditional edge)", () => {
      expect(
        condOf(edge({ path: "  ", op: "eq", value: "x" })),
      ).toBeUndefined();
      expect(condOf(edge(undefined))).toBeUndefined();
    });

    it("coerces a numeric value for gt/lt", () => {
      expect(
        condOf(edge({ path: "agent.urgency", op: "gt", value: "5" })),
      ).toEqual({ path: "agent.urgency", op: "gt", value: 5 });
    });

    it("keeps a non-numeric eq value as a string", () => {
      expect(
        condOf(edge({ path: "agent.category", op: "eq", value: "billing" })),
      ).toEqual({ path: "agent.category", op: "eq", value: "billing" });
    });

    it("coerces booleans", () => {
      expect(
        condOf(edge({ path: "agent.ok", op: "eq", value: "true" }))?.value,
      ).toBe(true);
    });

    it("splits + coerces an `in` list into an array", () => {
      expect(
        condOf(
          edge({
            path: "agent.category",
            op: "in",
            value: "billing, 7, refunds",
          }),
        ),
      ).toEqual({
        path: "agent.category",
        op: "in",
        value: ["billing", 7, "refunds"],
      });
    });

    it("emits no value for `exists`", () => {
      expect(
        condOf(edge({ path: "agent.output", op: "exists", value: "" })),
      ).toEqual({
        path: "agent.output",
        op: "exists",
      });
    });
  });
});
