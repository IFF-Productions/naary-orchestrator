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

  it("lifts a custom name from config-space (__name) to NodeDef.name, out of config", () => {
    const nodes: CanvasNode[] = [
      { id: "s", type: "start", position: at(0) },
      {
        id: "a",
        type: "agent",
        position: at(1),
        config: { systemPrompt: "triage", __name: "  Classify ticket  " },
      },
      // Blank/whitespace name ⇒ no name field (falls back to the derived label).
      { id: "e", type: "end", position: at(2), config: { __name: "   " } },
    ];
    const { graph } = compileGraph(nodes, [
      { id: "e1", source: "s", target: "a" },
      { id: "e2", source: "a", target: "e" },
    ]);
    const a = graph?.nodes.find((n) => n.id === "a");
    expect(a?.name).toBe("Classify ticket"); // trimmed, lifted to the top level
    expect(a?.config).toEqual({ systemPrompt: "triage" }); // __name never rides in DSL config
    const e = graph?.nodes.find((n) => n.id === "e");
    expect(e?.name).toBeUndefined(); // blank name omitted
    expect(e?.config).toBeUndefined(); // and the config (only __name) drops to empty
  });

  it("treats formTrigger as an entry node (its config carries through)", () => {
    const nodes: CanvasNode[] = [
      {
        id: "form",
        type: "formTrigger",
        position: at(0),
        config: {
          title: "Contact",
          fields: [{ key: "email", label: "Email", type: "email" }],
        },
      },
      { id: "end", type: "end", position: at(1) },
    ];
    const edges: CanvasEdge[] = [{ id: "e1", source: "form", target: "end" }];
    const { graph, error } = compileGraph(nodes, edges);
    expect(error).toBeUndefined();
    expect(graph?.startNodeId).toBe("form");
    expect(graph?.nodes.find((n) => n.id === "form")?.config).toEqual({
      title: "Contact",
      fields: [{ key: "email", label: "Email", type: "email" }],
    });
  });

  it("treats chatTrigger as an entry node (its config carries through)", () => {
    const nodes: CanvasNode[] = [
      {
        id: "chat",
        type: "chatTrigger",
        position: at(0),
        config: { title: "Support", greeting: "Hi!" },
      },
      { id: "end", type: "end", position: at(1) },
    ];
    const edges: CanvasEdge[] = [{ id: "e1", source: "chat", target: "end" }];
    const { graph, error } = compileGraph(nodes, edges);
    expect(error).toBeUndefined();
    expect(graph?.startNodeId).toBe("chat");
    expect(graph?.nodes.find((n) => n.id === "chat")?.config).toEqual({
      title: "Support",
      greeting: "Hi!",
    });
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

  it.each(["pollTrigger", "errorTrigger", "scheduleTrigger"] as const)(
    "accepts %s as the single entry node",
    (type) => {
      const nodes: CanvasNode[] = [
        { id: "trig", type, position: at(0) },
        { id: "end", type: "end", position: at(1) },
      ];
      const edges: CanvasEdge[] = [{ id: "e", source: "trig", target: "end" }];
      const { graph, error } = compileGraph(nodes, edges);
      expect(error).toBeUndefined();
      expect(graph?.startNodeId).toBe("trig");
    },
  );

  it("accepts a scheduleTrigger as the single entry node (→ startNodeId)", () => {
    const nodes: CanvasNode[] = [
      {
        id: "cron",
        type: "scheduleTrigger",
        position: at(0),
        config: { cron: "0 9 * * 1-5" },
      },
      { id: "end", type: "end", position: at(1) },
    ];
    const edges: CanvasEdge[] = [{ id: "e", source: "cron", target: "end" }];
    const { graph, error } = compileGraph(nodes, edges);
    expect(error).toBeUndefined();
    expect(graph?.startNodeId).toBe("cron");
    expect(graph?.nodes.find((n) => n.id === "cron")?.config).toEqual({
      cron: "0 9 * * 1-5",
    });
  });

  describe("onError (per-node error policy)", () => {
    const base: CanvasNode[] = [
      { id: "s", type: "start", position: at(0) },
      { id: "h", type: "httpRequest", position: at(1) },
    ];
    const wire: CanvasEdge[] = [{ id: "e", source: "s", target: "h" }];

    it("lifts config.onError:'continue' to the NodeDef field and strips it from config", () => {
      const nodes = base.map((n) =>
        n.id === "h"
          ? { ...n, config: { url: "https://x.test", onError: "continue" } }
          : n,
      );
      const { graph } = compileGraph(nodes, wire);
      const h = graph?.nodes.find((n) => n.id === "h");
      expect(h?.onError).toBe("continue");
      // stripped from config; the type-specific config survives
      expect(h?.config).toEqual({ url: "https://x.test" });
      expect((h?.config as Record<string, unknown>)?.onError).toBeUndefined();
    });

    it("omits onError when 'stop' (the default) and drops an onError-only config", () => {
      const nodes = base.map((n) =>
        n.id === "h" ? { ...n, config: { onError: "stop" } } : n,
      );
      const h = compileGraph(nodes, wire).graph?.nodes.find(
        (n) => n.id === "h",
      );
      expect(h?.onError).toBeUndefined();
      expect(h?.config).toBeUndefined(); // config had only the default → omitted
    });

    it("lifts config.retry to the NodeDef field and strips it from config", () => {
      const nodes = base.map((n) =>
        n.id === "h"
          ? {
              ...n,
              config: {
                url: "https://x.test",
                retry: { maxAttempts: 5, initialIntervalSeconds: 2 },
              },
            }
          : n,
      );
      const h = compileGraph(nodes, wire).graph?.nodes.find(
        (n) => n.id === "h",
      );
      expect(h?.retry).toEqual({ maxAttempts: 5, initialIntervalSeconds: 2 });
      expect(h?.config).toEqual({ url: "https://x.test" });
      expect((h?.config as Record<string, unknown>)?.retry).toBeUndefined();
    });

    it("drops an empty/all-undefined retry object", () => {
      const nodes = base.map((n) =>
        n.id === "h"
          ? { ...n, config: { url: "https://x.test", retry: {} } }
          : n,
      );
      const h = compileGraph(nodes, wire).graph?.nodes.find(
        (n) => n.id === "h",
      );
      expect(h?.retry).toBeUndefined();
      expect(h?.config).toEqual({ url: "https://x.test" });
    });
  });
});
