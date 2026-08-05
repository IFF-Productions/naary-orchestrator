import { describe, expect, it } from "vitest";
import { renameNode } from "../src/rename-node";
import type { GraphDef } from "../src/types";

/**
 * RENAME (#833). The rewrite is mechanical; ALL the risk is in the enumeration, so there is a
 * test per reference kind. A missed reference is silent breakage discovered on a run — the exact
 * failure class the rename exists to reduce.
 */

const graph = (over: Partial<GraphDef> = {}): GraphDef => ({
  startNodeId: "start",
  nodes: [
    { id: "start", type: "start" },
    { id: "agent-1a2b", type: "agent", config: { prompt: "hi" } },
    { id: "end", type: "end" },
  ],
  edges: [{ from: "start", to: "agent-1a2b" }],
  // Spread the Partial as-is. The old `over as GraphDef` widened every key to "always
  // present", which made TS flag the three defaults above as dead (TS2783).
  ...over,
});

const ok = (r: ReturnType<typeof renameNode>) => {
  if (!r.ok) throw new Error(`expected success, got: ${r.error}`);
  return r;
};

describe("renameNode — every reference moves", () => {
  it("renames the node itself and both ends of every edge", () => {
    const { graph: g } = ok(renameNode(graph(), "agent-1a2b", "triage"));

    expect(g.nodes.map((n) => n.id)).toEqual(["start", "triage", "end"]);
    expect(g.edges[0].to).toBe("triage");
  });

  it("follows startNodeId", () => {
    const { graph: g } = ok(
      renameNode(graph({ startNodeId: "agent-1a2b" }), "agent-1a2b", "triage"),
    );

    expect(g.startNodeId).toBe("triage");
  });

  it("rewrites {{ }} expressions, however deeply nested in config", () => {
    const g0 = graph({
      nodes: [
        { id: "start", type: "start" },
        { id: "agent-1a2b", type: "agent", config: {} },
        {
          id: "notify",
          type: "sendEmail",
          config: {
            subject: "Re: {{ agent-1a2b.output.title }}",
            blocks: [
              { text: "owner is {{agent-1a2b.output.owner.login}}" },
              { nested: { deep: ["{{ agent-1a2b.output.body }}"] } },
            ],
          },
        },
      ],
      edges: [],
    });

    const { graph: g } = ok(renameNode(g0, "agent-1a2b", "triage"));
    const cfg = g.nodes[2].config as Record<string, unknown>;

    expect(cfg.subject).toBe("Re: {{ triage.output.title }}");
    expect(JSON.stringify(cfg)).not.toContain("agent-1a2b");
    expect(JSON.stringify(cfg)).toContain("triage.output.owner.login");
  });

  it("preserves the author's spacing inside a token", () => {
    const g0 = graph({
      nodes: [
        { id: "agent-1a2b", type: "agent", config: {} },
        {
          id: "n",
          type: "text",
          config: { a: "{{agent-1a2b.x}}", b: "{{   agent-1a2b.x   }}" },
        },
      ],
      edges: [],
    });

    const cfg = ok(renameNode(g0, "agent-1a2b", "t")).graph.nodes[1]
      .config as Record<string, unknown>;

    expect(cfg.a).toBe("{{t.x}}");
    expect(cfg.b).toBe("{{   t.x   }}");
  });

  it("rewrites ArgBinding.from wherever it appears", () => {
    const g0 = graph({
      nodes: [
        { id: "agent-1a2b", type: "agent", config: {} },
        {
          id: "notify",
          type: "sendEmail",
          config: {
            connectionId: "c1",
            fieldBindings: {
              subject: { from: "agent-1a2b", path: "output.title" },
            },
          },
        },
        {
          id: "call",
          type: "mcpTool",
          config: { argumentBindings: { arg: { from: "agent-1a2b" } } },
        },
      ],
      edges: [],
    });

    const { graph: g } = ok(renameNode(g0, "agent-1a2b", "triage"));

    expect(
      (
        g.nodes[1].config as {
          fieldBindings: Record<string, { from: string; path: string }>;
        }
      ).fieldBindings.subject,
    ).toEqual({ from: "triage", path: "output.title" });
    expect(
      (
        g.nodes[2].config as {
          argumentBindings: Record<string, { from: string }>;
        }
      ).argumentBindings.arg.from,
    ).toBe("triage");
  });

  it("rewrites an edge condition's path", () => {
    const g0 = graph({
      edges: [
        {
          from: "agent-1a2b",
          to: "end",
          condition: {
            path: "agent-1a2b.output.category",
            op: "eq",
            value: "bug",
          },
        },
      ],
    });

    const { graph: g } = ok(renameNode(g0, "agent-1a2b", "triage"));

    expect(g.edges[0].condition?.path).toBe("triage.output.category");
    expect(g.edges[0].condition?.value).toBe("bug"); // an unrelated value is left alone
  });
});

describe("renameNode — the traps", () => {
  /**
   * A handoff target's MODEL-FACING name defaults to its `to`. Rename the target node and the
   * name moves with it, so an edge still comparing against the old name is a branch the model
   * can never satisfy — a dead route that only surfaces when that branch is chosen.
   */
  it("moves a handoff target AND the edge that routes on its implicit name", () => {
    const g0 = graph({
      nodes: [
        {
          id: "super",
          type: "agent",
          config: {
            handoff: { targets: [{ to: "refunds" }, { to: "sales" }] },
          },
        },
        { id: "refunds", type: "agent", config: {} },
        { id: "sales", type: "agent", config: {} },
      ],
      edges: [
        {
          from: "super",
          to: "refunds",
          condition: {
            path: "super.output.target",
            op: "eq",
            value: "refunds",
          },
        },
        {
          from: "super",
          to: "sales",
          condition: { path: "super.output.target", op: "eq", value: "sales" },
        },
      ],
    });

    const { graph: g } = ok(renameNode(g0, "refunds", "refund_specialist"));

    expect(
      (g.nodes[0].config as { handoff: { targets: { to: string }[] } }).handoff
        .targets[0].to,
    ).toBe("refund_specialist");
    expect(g.edges[0].condition?.value).toBe("refund_specialist");
    // The sibling route is untouched.
    expect(g.edges[1].condition?.value).toBe("sales");
  });

  it("leaves an EXPLICIT handoff name alone — that's the author's choice, not the id", () => {
    const g0 = graph({
      nodes: [
        {
          id: "super",
          type: "agent",
          config: {
            handoff: { targets: [{ to: "refunds", name: "money_back" }] },
          },
        },
        { id: "refunds", type: "agent", config: {} },
      ],
      edges: [
        {
          from: "super",
          to: "refunds",
          condition: {
            path: "super.output.target",
            op: "eq",
            value: "money_back",
          },
        },
      ],
    });

    const { graph: g } = ok(renameNode(g0, "refunds", "refund_specialist"));

    expect(g.edges[0].condition?.value).toBe("money_back");
  });

  it("never touches an escaped \\{{ literal", () => {
    const g0 = graph({
      nodes: [
        { id: "agent-1a2b", type: "agent", config: {} },
        {
          id: "n",
          type: "text",
          config: {
            doc: "literal \\{{ agent-1a2b.x }} and {{ agent-1a2b.y }}",
          },
        },
      ],
      edges: [],
    });

    const cfg = ok(renameNode(g0, "agent-1a2b", "t")).graph.nodes[1]
      .config as Record<string, unknown>;

    expect(cfg.doc).toBe("literal \\{{ agent-1a2b.x }} and {{ t.y }}");
  });

  /** `SendEmailNodeConfig` has a `from` string of its own. It must not be mistaken for a binding. */
  it("does not rewrite a sendEmail 'from' address that happens to match", () => {
    const g0 = graph({
      nodes: [
        { id: "noreply", type: "agent", config: {} },
        {
          id: "notify",
          type: "sendEmail",
          config: { connectionId: "c1", from: "noreply", to: "a@b.c" },
        },
      ],
      edges: [],
    });

    const { graph: g } = ok(renameNode(g0, "noreply", "notifier"));

    expect((g.nodes[1].config as { from: string }).from).toBe("noreply");
  });

  /** A prefix match is not a reference: renaming `agent` must not touch `agent-2`. */
  it("matches whole ids only", () => {
    const g0 = graph({
      nodes: [
        { id: "agent", type: "agent", config: {} },
        {
          id: "agent-2",
          type: "agent",
          config: { p: "{{ agent-2.output.x }} {{ agent.output.y }}" },
        },
      ],
      edges: [],
    });

    const cfg = ok(renameNode(g0, "agent", "first")).graph.nodes[1]
      .config as Record<string, unknown>;

    expect(cfg.p).toBe("{{ agent-2.output.x }} {{ first.output.y }}");
  });
});

describe("renameNode — refuses before it changes anything", () => {
  it("refuses a duplicate id", () => {
    const r = renameNode(graph(), "agent-1a2b", "end");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/already called/);
  });

  it.each([
    ["a space", "my node"],
    ["a dot", "my.node"],
    ["a brace", "node{1}"],
    ["empty", "   "],
  ])("refuses %s", (_label, bad) => {
    expect(renameNode(graph(), "agent-1a2b", bad).ok).toBe(false);
  });

  it("refuses to rename a node that isn't there", () => {
    const r = renameNode(graph(), "nope", "fine");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/No node called/);
  });

  it("is a no-op when the id is unchanged", () => {
    const r = ok(renameNode(graph(), "agent-1a2b", "agent-1a2b"));
    expect(r.rewritten).toBe(0);
  });

  it("does not mutate the graph it was given", () => {
    const g0 = graph({
      edges: [
        {
          from: "start",
          to: "agent-1a2b",
          condition: { path: "agent-1a2b.output.x", op: "exists" },
        },
      ],
    });
    const before = JSON.stringify(g0);

    ok(renameNode(g0, "agent-1a2b", "triage"));

    expect(JSON.stringify(g0)).toBe(before);
  });

  /**
   * The canvas maps the result back onto its React Flow nodes BY INDEX, because those carry the
   * positions and recompiling would round-trip them away. That makes order preservation a
   * contract, not an implementation detail — if it ever breaks, every node teleports.
   */
  it("preserves node and edge ORDER — the canvas maps back by index", () => {
    const g0 = graph({
      nodes: [
        { id: "z", type: "text", config: {} },
        { id: "agent-1a2b", type: "agent", config: {} },
        { id: "a", type: "text", config: {} },
      ],
      edges: [
        { from: "z", to: "agent-1a2b" },
        { from: "agent-1a2b", to: "a" },
      ],
    });

    const { graph: g } = ok(renameNode(g0, "agent-1a2b", "triage"));

    expect(g.nodes).toHaveLength(3);
    expect(g.nodes.map((n) => n.id)).toEqual(["z", "triage", "a"]);
    expect(g.edges.map((e) => `${e.from}->${e.to}`)).toEqual([
      "z->triage",
      "triage->a",
    ]);
  });

  it("reports how many references moved", () => {
    const g0 = graph({
      startNodeId: "agent-1a2b",
      nodes: [
        { id: "agent-1a2b", type: "agent", config: {} },
        { id: "n", type: "text", config: { a: "{{ agent-1a2b.x }}" } },
      ],
      edges: [{ from: "agent-1a2b", to: "n" }],
    });

    // the node itself + the template + the edge.from + startNodeId
    expect(ok(renameNode(g0, "agent-1a2b", "t")).rewritten).toBe(4);
  });
});
