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

/**
 * #1020 — the diff used to say only "config", which is the one word that covers every edit a user
 * actually makes. These cover the per-path detail that replaced that, and its bounds.
 */
describe("diffGraphs — field-level detail", () => {
  /** Edit one config value; the path is named, with both sides. */
  it("names the changed path inside config, with before → after", () => {
    const to = structuredClone(base);
    const classify = to.nodes.find((n) => n.id === "classify");
    if (classify) classify.config = { model: "claude-opus-4-8" };
    const [c] = diffGraphs(base, to).nodesChanged;
    expect(c.fields).toEqual(["config"]); // kept alongside — it still has consumers
    expect(c.details).toEqual([
      {
        path: "config.model",
        kind: "changed",
        before: '"claude-sonnet-5"',
        after: '"claude-opus-4-8"',
      },
    ]);
    expect(c.detailsOmitted).toBe(0);
  });

  it("uses dotted paths for nested values, and reports each leaf once", () => {
    const from: GraphDef = {
      ...base,
      nodes: [
        { id: "start", type: "webhookTrigger" },
        {
          id: "pagerduty",
          type: "integration",
          config: {
            action: "incident.create",
            body: { title: "Ticket {{ start.body.id }}", urgency: "low" },
          },
        },
        { id: "end", type: "end" },
      ],
    };
    const to = structuredClone(from);
    const pd = to.nodes.find((n) => n.id === "pagerduty");
    if (pd) {
      pd.config = {
        action: "incident.create",
        body: { title: "🚨 Ticket {{ start.body.id }}", urgency: "high" },
      };
    }
    const [c] = diffGraphs(from, to).nodesChanged;
    expect(c.details.map((d) => d.path)).toEqual([
      "config.body.title",
      "config.body.urgency",
    ]);
    expect(c.details[1]).toMatchObject({ before: '"low"', after: '"high"' });
  });

  it("descends into a config that did not exist before (not one opaque `config added`)", () => {
    const to = structuredClone(base);
    const end = to.nodes.find((n) => n.id === "end");
    if (end) end.config = { note: "done" };
    const [c] = diffGraphs(base, to).nodesChanged;
    expect(c.details).toEqual([
      { path: "config.note", kind: "added", after: '"done"' },
    ]);
  });

  it("details a rename and a retry policy too, not just config", () => {
    const to = structuredClone(base);
    const classify = to.nodes.find((n) => n.id === "classify");
    if (classify) {
      classify.name = "Triage the ticket";
      classify.retry = { maxAttempts: 3 };
    }
    const [c] = diffGraphs(base, to).nodesChanged;
    expect(c.details).toEqual([
      { path: "name", kind: "added", after: '"Triage the ticket"' },
      { path: "retry.maxAttempts", kind: "added", after: "3" },
    ]);
  });

  // A systemPrompt or an outputSchema is unbounded; a review row is not. The clipped string has to
  // SAY it was clipped — a silently shortened prompt reads as a prompt that was shortened.
  it("truncates a huge value and announces the truncation in the text", () => {
    const to = structuredClone(base);
    const classify = to.nodes.find((n) => n.id === "classify");
    const long = "x".repeat(5_000);
    if (classify)
      classify.config = { model: "claude-sonnet-5", systemPrompt: long };
    const [c] = diffGraphs(base, to).nodesChanged;
    const d = c.details[0];
    expect(d.path).toBe("config.systemPrompt");
    expect(d.truncated).toBe(true);
    expect(d.after).toContain("… [truncated, 5002 chars total]");
    expect(d.after!.length).toBeLessThan(300);
  });

  it("caps how many details one node reports and COUNTS the rest", () => {
    const from = structuredClone(base);
    const to = structuredClone(base);
    const fromNode = from.nodes.find((n) => n.id === "classify");
    const toNode = to.nodes.find((n) => n.id === "classify");
    const many = (v: number) =>
      Object.fromEntries(
        Array.from({ length: 30 }, (_, i) => [
          `k${String(i).padStart(2, "0")}`,
          v,
        ]),
      );
    if (fromNode) fromNode.config = many(1);
    if (toNode) toNode.config = many(2);
    const [c] = diffGraphs(from, to).nodesChanged;
    expect(c.details).toHaveLength(20);
    expect(c.detailsOmitted).toBe(10); // stated, never silently dropped
  });
});

describe("diffGraphs — arrays", () => {
  const withFields = (fields: unknown[]): GraphDef => ({
    ...base,
    nodes: [
      { id: "start", type: "formTrigger", config: { fields } },
      { id: "classify", type: "agent", config: { model: "claude-sonnet-5" } },
      { id: "end", type: "end" },
    ],
  });

  // Index paths describe an insertion at the front as "every item changed" — precise-looking and
  // wrong. When the items carry an identity the match is real, so a prepend touches nothing else.
  it("matches array items by their identity key, so a PREPEND churns nothing", () => {
    const from = withFields([
      { key: "email", label: "Email" },
      { key: "note", label: "Note" },
    ]);
    const to = withFields([
      { key: "name", label: "Name" },
      { key: "email", label: "Email" },
      { key: "note", label: "Note" },
    ]);
    const [c] = diffGraphs(from, to).nodesChanged;
    expect(c.details).toEqual([
      {
        path: "config.fields[key=name]",
        kind: "added",
        after: '{"key":"name","label":"Name"}',
      },
    ]);
  });

  it("addresses a changed item by identity, not position", () => {
    const from = withFields([
      { key: "email", label: "Email" },
      { key: "note", label: "Note" },
    ]);
    const to = withFields([
      { key: "email", label: "Work email" },
      { key: "note", label: "Note" },
    ]);
    const [c] = diffGraphs(from, to).nodesChanged;
    expect(c.details).toEqual([
      {
        path: "config.fields[key=email].label",
        kind: "changed",
        before: '"Email"',
        after: '"Work email"',
      },
    ]);
  });

  it("reports a removed item by identity", () => {
    const from = withFields([{ key: "email" }, { key: "note" }]);
    const to = withFields([{ key: "email" }]);
    const [c] = diffGraphs(from, to).nodesChanged;
    expect(c.details.map((d) => [d.path, d.kind])).toEqual([
      ["config.fields[key=note]", "removed"],
    ]);
  });

  // No identity to match on ⇒ compare the list as ONE value rather than inventing a positional
  // correspondence the data doesn't carry. Coarse and true beats precise and wrong.
  it("compares an identity-less array whole, and states both item counts", () => {
    const to = structuredClone(base);
    const classify = to.nodes.find((n) => n.id === "classify");
    if (classify) {
      classify.config = {
        model: "claude-sonnet-5",
        allowedTools: ["read", "grep"],
      };
    }
    const from = structuredClone(base);
    const fromClassify = from.nodes.find((n) => n.id === "classify");
    if (fromClassify) {
      fromClassify.config = {
        model: "claude-sonnet-5",
        allowedTools: ["read"],
      };
    }
    const [c] = diffGraphs(from, to).nodesChanged;
    expect(c.details).toEqual([
      {
        path: "config.allowedTools",
        kind: "changed",
        before: '["read"]',
        after: '["read","grep"]',
        note: "1 items → 2 items",
      },
    ]);
  });

  it("falls back to a whole-list compare when an identity key is not unique", () => {
    const from = withFields([
      { key: "dup", label: "a" },
      { key: "dup", label: "b" },
    ]);
    const to = withFields([
      { key: "dup", label: "a" },
      { key: "dup", label: "c" },
    ]);
    const [c] = diffGraphs(from, to).nodesChanged;
    expect(c.details).toHaveLength(1);
    expect(c.details[0].path).toBe("config.fields");
    expect(c.details[0].note).toBe("2 items → 2 items");
  });
});

/**
 * Configs carry `{{ $secrets.NAME }}` REFERENCES, never values — the resolver refuses to resolve
 * them outside an activity — and `diffGraphs` takes two graphs and no ctx, so there is no
 * resolution path into it at all. The assertion below is the POSITIVE form of that invariant (the
 * reference round-trips verbatim), because a "the diff doesn't contain <sentinel>" check would be
 * unfalsifiable when nothing can put the sentinel there in the first place.
 */
describe("diffGraphs — secret references", () => {
  const withAuth = (url: string): GraphDef => ({
    ...base,
    nodes: [
      { id: "start", type: "webhookTrigger" },
      {
        id: "classify",
        type: "httpRequest",
        config: {
          url,
          headers: { Authorization: "Bearer {{ $secrets.PAGERDUTY_TOKEN }}" },
        },
      },
      { id: "end", type: "end" },
    ],
  });

  it("carries a secret REFERENCE through verbatim — never a resolved value", () => {
    const from = withAuth("https://api.example.com/v1/incidents");
    const to = structuredClone(from);
    const node = to.nodes.find((n) => n.id === "classify");
    if (node) {
      node.config = {
        url: "https://api.example.com/v2/incidents",
        // Renaming the secret still names the secret, not its value.
        headers: {
          Authorization: "Bearer {{ $secrets.PAGERDUTY_ROUTING_KEY }}",
        },
      };
    }
    const [c] = diffGraphs(from, to).nodesChanged;
    const auth = c.details.find(
      (d) => d.path === "config.headers.Authorization",
    );
    expect(auth?.before).toBe('"Bearer {{ $secrets.PAGERDUTY_TOKEN }}"');
    expect(auth?.after).toBe('"Bearer {{ $secrets.PAGERDUTY_ROUTING_KEY }}"');

    // Whole-diff sweep: the only `$secrets` text anywhere is the reference syntax itself.
    const serialized = JSON.stringify(diffGraphs(from, to));
    for (const m of serialized.match(/\$secrets[^"\\]*/g) ?? []) {
      expect(m).toMatch(/^\$secrets\.[A-Z_]+ \}\}$/);
    }
  });

  it("does not mention an untouched secret path when a sibling field is edited", () => {
    const from = withAuth("https://api.example.com/v1/incidents");
    const to = withAuth("https://api.example.com/v2/incidents");
    const [c] = diffGraphs(from, to).nodesChanged;
    expect(c.details.map((d) => d.path)).toEqual(["config.url"]);
    expect(JSON.stringify(c.details)).not.toContain("$secrets");
  });
});

/**
 * #1020's second defect. `edgeKey` used to include the condition, so editing a threshold reported
 * one edge REMOVED and one ADDED — routing torn out and rebuilt, for an edit that moved nothing.
 * Edge ORDER stays significant throughout (the interpreter takes the first matching outgoing edge).
 */
describe("diffGraphs — edges", () => {
  const branchy = (a: number, b: number): GraphDef => ({
    startNodeId: "start",
    nodes: [
      { id: "start", type: "webhookTrigger" },
      { id: "page", type: "end" },
      { id: "ignore", type: "end" },
    ],
    edges: [
      {
        from: "start",
        to: "page",
        condition: { path: "start.body.count", op: "gt", value: a },
      },
      {
        from: "start",
        to: "ignore",
        condition: { path: "start.body.count", op: "lte", value: b },
      },
    ],
  });

  it("reports an edited condition as ONE change, not a removal plus an addition", () => {
    const d = diffGraphs(branchy(5, 5), branchy(10, 5));
    expect(d.edgesAdded).toEqual([]);
    expect(d.edgesRemoved).toEqual([]);
    expect(d.edgesReordered).toBe(false);
    expect(d.edgesChanged).toEqual([
      {
        from: "start",
        to: "page",
        before: { path: "start.body.count", op: "gt", value: 5 },
        after: { path: "start.body.count", op: "gt", value: 10 },
      },
    ]);
    expect(graphsEqual(branchy(5, 5), branchy(10, 5))).toBe(false);
  });

  it("reports an edge that LOST its condition (now unconditional)", () => {
    const from = branchy(5, 5);
    const to = structuredClone(from);
    delete to.edges[0].condition;
    const d = diffGraphs(from, to);
    expect(d.edgesChanged).toEqual([
      {
        from: "start",
        to: "page",
        before: { path: "start.body.count", op: "gt", value: 5 },
      },
    ]);
  });

  it("still reports a genuinely new route as an addition", () => {
    const from = branchy(5, 5);
    const to: GraphDef = {
      ...structuredClone(from),
      edges: [...structuredClone(from).edges, { from: "page", to: "ignore" }],
    };
    const d = diffGraphs(from, to);
    expect(d.edgesAdded).toEqual([{ from: "page", to: "ignore" }]);
    expect(d.edgesChanged).toEqual([]);
  });

  // Two edges sharing a from → to pair (a switch fanning conditions at one target): swapping them
  // changes branch PRECEDENCE and must read as a reorder, not as two condition edits.
  it("treats a swap of two same-pair edges as a reorder, not two condition changes", () => {
    const from: GraphDef = {
      startNodeId: "start",
      nodes: [
        { id: "start", type: "webhookTrigger" },
        { id: "end", type: "end" },
      ],
      edges: [
        {
          from: "start",
          to: "end",
          condition: { path: "a", op: "eq", value: 1 },
        },
        {
          from: "start",
          to: "end",
          condition: { path: "a", op: "eq", value: 2 },
        },
      ],
    };
    const to: GraphDef = { ...from, edges: [...from.edges].reverse() };
    const d = diffGraphs(from, to);
    expect(d.edgesChanged).toEqual([]);
    expect(d.edgesAdded).toEqual([]);
    expect(d.edgesRemoved).toEqual([]);
    expect(d.edgesReordered).toBe(true);
    expect(graphsEqual(from, to)).toBe(false);
  });
});
