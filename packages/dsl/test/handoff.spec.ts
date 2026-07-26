import {
  type AgentHandoff,
  HANDOFF_TARGET_FIELD,
  handoffConditionPath,
  handoffEdges,
  handoffOutputSchema,
  handoffTargetName,
  supervisorHandoffGraph,
  validateGraph,
} from "../src";
import { nodeConfigSchema } from "../src/registry";
import { describe, expect, it } from "vitest";
import type { GraphDef } from "../src/types";

/**
 * Agent handoff (#580 Phase 1). The whole capability is: a derived structured-output
 * schema + ordinary conditional edges. These tests pin both halves and, crucially, the
 * save-gate rules — because every rule there exists to turn a silently-broken RUN into a
 * rejected save.
 */

const HANDOFF: AgentHandoff = {
  targets: [
    { to: "billing", name: "billing_specialist", description: "money things" },
    { to: "tech", description: "everything technical" }, // no name ⇒ name is the node id
  ],
};

function supervisorGraph(over?: Partial<GraphDef>): GraphDef {
  return {
    startNodeId: "sup",
    nodes: [
      { id: "sup", type: "agent", config: { handoff: HANDOFF } },
      { id: "billing", type: "agent" },
      { id: "tech", type: "agent" },
      { id: "end", type: "end" },
    ],
    edges: [
      ...handoffEdges("sup", HANDOFF),
      { from: "billing", to: "end" },
      { from: "tech", to: "end" },
    ],
    ...over,
  };
}

describe("handoff — derived output schema", () => {
  it("names default to the node id, and an explicit name wins", () => {
    expect(handoffTargetName(HANDOFF.targets[0])).toBe("billing_specialist");
    expect(handoffTargetName(HANDOFF.targets[1])).toBe("tech");
  });

  it("constrains the model to an ENUM of the target names", () => {
    // This is what makes an invalid route unrepresentable: the provider cannot emit a
    // target the graph has no edge for, so there is no "model hallucinated a route" path.
    const schema = handoffOutputSchema(HANDOFF) as {
      properties: Record<string, { enum?: string[] }>;
      required: string[];
    };
    expect(schema.properties[HANDOFF_TARGET_FIELD].enum).toEqual([
      "billing_specialist",
      "tech",
    ]);
    expect(schema.required).toContain(HANDOFF_TARGET_FIELD);
  });

  it("asks for a reason by default, and drops it when explain is false", () => {
    const withReason = handoffOutputSchema(HANDOFF) as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(withReason.properties.reason).toBeTruthy();
    expect(withReason.required).toContain("reason");

    const without = handoffOutputSchema({ ...HANDOFF, explain: false }) as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(without.properties.reason).toBeUndefined();
    expect(without.required).not.toContain("reason");
  });

  it("carries the author's payload schema through verbatim", () => {
    const payloadSchema = {
      type: "object",
      properties: { question: { type: "string" } },
      required: ["question"],
    };
    const schema = handoffOutputSchema({ ...HANDOFF, payloadSchema }) as {
      properties: { payload: unknown };
    };
    expect(schema.properties.payload).toEqual(payloadSchema);
  });

  it("builds edges on the SAME path the save-gate demands", () => {
    const edges = handoffEdges("sup", HANDOFF);
    expect(edges).toEqual([
      {
        from: "sup",
        to: "billing",
        condition: {
          path: "sup.output.target",
          op: "eq",
          value: "billing_specialist",
        },
      },
      {
        from: "sup",
        to: "tech",
        condition: { path: "sup.output.target", op: "eq", value: "tech" },
      },
    ]);
    expect(handoffConditionPath("sup")).toBe(
      `sup.output.${HANDOFF_TARGET_FIELD}`,
    );
  });

  it("accepts the zod mirror in registry.ts (the two shapes agree)", () => {
    // handoff.ts owns the TS shape (it must stay zod-free for the workflow bundle) and
    // registry.ts mirrors it. Feeding a value typed as AgentHandoff through the zod schema
    // couples them: a field added to one and not the other fails here or fails tsc.
    const parsed = nodeConfigSchema("agent").safeParse({ handoff: HANDOFF });
    expect(parsed.success).toBe(true);
  });
});

describe("handoff — save gate", () => {
  it("accepts a correctly wired supervisor", () => {
    expect(validateGraph(supervisorGraph())).toEqual({ valid: true });
  });

  it("rejects a target that is not a node", () => {
    const g = supervisorGraph();
    g.nodes = g.nodes.filter((n) => n.id !== "tech");
    g.edges = g.edges.filter((e) => e.to !== "tech" && e.from !== "tech");
    const r = validateGraph(g);
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/unknown node 'tech'/);
  });

  it("rejects a declared target with no edge to it", () => {
    const g = supervisorGraph();
    g.edges = g.edges.filter((e) => !(e.from === "sup" && e.to === "tech"));
    const r = validateGraph(g);
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/no edge to it/);
  });

  it("rejects an UNCONDITIONAL target edge (it would fire on every run)", () => {
    // The important one. `nextNodes` returns EVERY passing edge, so an unconditioned
    // handoff edge silently runs that specialist on every single run no matter what the
    // supervisor chose — a wrong-but-plausible graph that costs money on each run.
    const g = supervisorGraph();
    g.edges = g.edges.map((e) =>
      e.from === "sup" && e.to === "tech" ? { from: "sup", to: "tech" } : e,
    );
    const r = validateGraph(g);
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/unconditional/);
  });

  it("rejects an edge routing on the wrong path or value", () => {
    const wrongPath = supervisorGraph();
    wrongPath.edges = wrongPath.edges.map((e) =>
      e.from === "sup" && e.to === "tech"
        ? {
            from: "sup",
            to: "tech",
            condition: {
              path: "sup.output.route",
              op: "eq" as const,
              value: "tech",
            },
          }
        : e,
    );
    expect(validateGraph(wrongPath).error).toMatch(
      /must route on sup.output.target/,
    );

    const wrongValue = supervisorGraph();
    wrongValue.edges = wrongValue.edges.map((e) =>
      e.from === "sup" && e.to === "tech"
        ? {
            from: "sup",
            to: "tech",
            condition: {
              path: "sup.output.target",
              op: "eq" as const,
              value: "techincal",
            },
          }
        : e,
    );
    expect(validateGraph(wrongValue).error).toMatch(
      /must be sup.output.target eq 'tech'/,
    );
  });

  it("rejects duplicate target names (ambiguous routing)", () => {
    const dup: AgentHandoff = {
      targets: [
        { to: "billing", name: "same" },
        { to: "tech", name: "same" },
      ],
    };
    const g: GraphDef = {
      startNodeId: "sup",
      nodes: [
        { id: "sup", type: "agent", config: { handoff: dup } },
        { id: "billing", type: "agent" },
        { id: "tech", type: "agent" },
      ],
      edges: handoffEdges("sup", dup),
    };
    expect(validateGraph(g).error).toMatch(/duplicate handoff target name/);
  });

  it("rejects handoff together with an explicit outputSchema", () => {
    const g = supervisorGraph();
    (g.nodes[0].config as Record<string, unknown>).outputSchema = {
      type: "object",
    };
    expect(validateGraph(g).error).toMatch(/both 'handoff' and 'outputSchema'/);
  });

  it("rejects a handoff on a node that is not an agent", () => {
    const g = supervisorGraph();
    g.nodes[0] = { id: "sup", type: "set", config: { handoff: HANDOFF } };
    expect(validateGraph(g).error).toMatch(/handoff is an agent capability/);
  });

  it("leaves handoff-free graphs completely untouched", () => {
    // The gate must be additive: nothing already saved can newly fail.
    const plain: GraphDef = {
      startNodeId: "a",
      nodes: [
        { id: "a", type: "agent" },
        { id: "b", type: "end" },
      ],
      edges: [{ from: "a", to: "b" }],
    };
    expect(validateGraph(plain)).toEqual({ valid: true });
  });
});

describe("the shipped supervisor template", () => {
  it("is wired exactly as handoffEdges would build it", () => {
    // The gallery template is hand-written for readability; this proves it matches the
    // helper byte-for-byte, so the template can't drift from the canonical shape.
    const sup = supervisorHandoffGraph.nodes.find((n) => n.id === "supervisor");
    const handoff = (sup?.config as { handoff: AgentHandoff }).handoff;
    const expected = handoffEdges("supervisor", handoff);
    for (const e of expected) {
      expect(supervisorHandoffGraph.edges).toContainEqual(e);
    }
    expect(validateGraph(supervisorHandoffGraph)).toEqual({ valid: true });
  });

  it("does NOT join the specialists on a merge node", () => {
    // A merge waits for every inbound branch; a handoff produces exactly one, so a merge
    // join would never complete and the run would end without reaching the reply.
    expect(supervisorHandoffGraph.nodes.some((n) => n.type === "merge")).toBe(
      false,
    );
  });
});
