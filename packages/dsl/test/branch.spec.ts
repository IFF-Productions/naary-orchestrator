import { describe, expect, it } from "vitest";
import { evaluateCondition, nextNodes, validateGraph } from "../src/branch";
import type { GraphDef } from "../src/types";

const ctx = {
  agent: { output: { category: "billing", urgency: 3 } },
  trigger: { number: 42 },
};

describe("evaluateCondition", () => {
  it("eq / neq", () => {
    expect(
      evaluateCondition(
        { path: "agent.output.category", op: "eq", value: "billing" },
        ctx,
      ),
    ).toBe(true);
    expect(
      evaluateCondition(
        { path: "agent.output.category", op: "eq", value: "other" },
        ctx,
      ),
    ).toBe(false);
    expect(
      evaluateCondition(
        { path: "agent.output.category", op: "neq", value: "other" },
        ctx,
      ),
    ).toBe(true);
  });
  it("exists (missing path is false)", () => {
    expect(
      evaluateCondition({ path: "agent.output.urgency", op: "exists" }, ctx),
    ).toBe(true);
    expect(
      evaluateCondition({ path: "agent.output.missing", op: "exists" }, ctx),
    ).toBe(false);
  });
  it("in / gt / lt", () => {
    expect(
      evaluateCondition(
        {
          path: "agent.output.category",
          op: "in",
          value: ["billing", "sales"],
        },
        ctx,
      ),
    ).toBe(true);
    expect(
      evaluateCondition(
        { path: "agent.output.urgency", op: "gt", value: 2 },
        ctx,
      ),
    ).toBe(true);
    expect(
      evaluateCondition(
        { path: "agent.output.urgency", op: "lt", value: 2 },
        ctx,
      ),
    ).toBe(false);
    // gt/lt are false for non-numbers (no coercion)
    expect(
      evaluateCondition(
        { path: "agent.output.category", op: "gt", value: 2 },
        ctx,
      ),
    ).toBe(false);
  });
});

const graph: GraphDef = {
  startNodeId: "agent",
  nodes: [
    { id: "agent", type: "agent" },
    { id: "billing", type: "end" },
    { id: "other", type: "end" },
    { id: "always", type: "end" },
  ],
  edges: [
    {
      from: "agent",
      to: "billing",
      condition: { path: "agent.output.category", op: "eq", value: "billing" },
    },
    {
      from: "agent",
      to: "other",
      condition: { path: "agent.output.category", op: "eq", value: "other" },
    },
    { from: "agent", to: "always" }, // unconditional
  ],
};

describe("nextNodes", () => {
  it("returns only passing edges, in declared order (unconditional always passes)", () => {
    expect(nextNodes(graph, "agent", ctx)).toEqual(["billing", "always"]);
  });
  it("returns [] when no edges leave the node", () => {
    expect(nextNodes(graph, "billing", ctx)).toEqual([]);
  });
});

describe("validateGraph", () => {
  it("accepts a well-formed graph (cycles allowed)", () => {
    const looped: GraphDef = {
      startNodeId: "a",
      nodes: [{ id: "a", type: "start" }],
      edges: [{ from: "a", to: "a" }],
    };
    expect(validateGraph(looped).valid).toBe(true);
  });
  it("rejects a dangling edge and a missing start", () => {
    expect(
      validateGraph({
        startNodeId: "a",
        nodes: [{ id: "a", type: "start" }],
        edges: [{ from: "a", to: "ghost" }],
      }).valid,
    ).toBe(false);
    expect(
      validateGraph({
        startNodeId: "missing",
        nodes: [{ id: "a", type: "start" }],
        edges: [],
      }).valid,
    ).toBe(false);
  });

  it("accepts unconditional fan-in into a merge node", () => {
    const diamond: GraphDef = {
      startNodeId: "s",
      nodes: [
        { id: "s", type: "start" },
        { id: "a", type: "set" },
        { id: "b", type: "set" },
        { id: "m", type: "merge" },
      ],
      edges: [
        { from: "s", to: "a" },
        { from: "s", to: "b" },
        { from: "a", to: "m" },
        { from: "b", to: "m" },
      ],
    };
    expect(validateGraph(diamond).valid).toBe(true);
  });

  it("rejects a conditional edge into a merge node (v1 fan-in must be unconditional)", () => {
    const bad: GraphDef = {
      startNodeId: "s",
      nodes: [
        { id: "s", type: "start" },
        { id: "a", type: "set" },
        { id: "m", type: "merge" },
      ],
      edges: [
        { from: "s", to: "a" },
        { from: "a", to: "m", condition: { path: "a.ok", op: "exists" } },
      ],
    };
    const res = validateGraph(bad);
    expect(res.valid).toBe(false);
    expect(res.error).toMatch(/merge/);
  });
});
