import { describe, expect, it } from "vitest";
import { computeItemsRegions } from "../src/items-region";
import { validateGraph } from "../src/validate-graph";
import type { GraphDef, NodeDef } from "../src/types";

/** Build a graph from a node list + edge pairs. */
function g(nodes: NodeDef[], edges: [string, string][]): GraphDef {
  return {
    startNodeId: nodes[0].id,
    nodes,
    edges: edges.map(([from, to]) => ({ from, to })),
  };
}

const N = (id: string, type: NodeDef["type"], config?: object): NodeDef =>
  ({ id, type, ...(config ? { config } : {}) }) as NodeDef;

describe("computeItemsRegions — valid brackets", () => {
  it("computes a linear region: splitOut → set → loopEnd", () => {
    const graph = g(
      [
        N("s", "start"),
        N("sp", "splitOut", { from: "s", path: "items" }),
        N("set", "set", { fields: {} }),
        N("le", "loopEnd", { from: "set" }),
        N("e", "end"),
      ],
      [
        ["s", "sp"],
        ["sp", "set"],
        ["set", "le"],
        ["le", "e"],
      ],
    );
    const { regions, error } = computeItemsRegions(graph);
    expect(error).toBeNull();
    expect(regions).toEqual([
      {
        splitOutId: "sp",
        loopEndId: "le",
        regionNodeIds: ["set"],
        collectFrom: "set",
        kind: "linear",
      },
    ]);
    expect(validateGraph(graph).valid).toBe(true);
  });

  it("ALLOWS the batchable activities (agent/httpRequest/mcpTool) inside a region (A3)", () => {
    for (const type of ["agent", "httpRequest", "mcpTool"] as const) {
      const graph = g(
        [
          N("s", "start"),
          N("sp", "splitOut", { from: "s", path: "items" }),
          N("a", type),
          N("le", "loopEnd", { from: "a" }),
          N("e", "end"),
        ],
        [
          ["s", "sp"],
          ["sp", "a"],
          ["a", "le"],
          ["le", "e"],
        ],
      );
      const { regions, error } = computeItemsRegions(graph);
      expect(error, type).toBeNull();
      expect(regions[0].regionNodeIds).toEqual(["a"]);
    }
  });

  it("allows an EMPTY region collecting the splitOut itself", () => {
    const graph = g(
      [
        N("s", "start"),
        N("sp", "splitOut", { from: "s", path: "items" }),
        N("le", "loopEnd", { from: "sp" }),
        N("e", "end"),
      ],
      [
        ["s", "sp"],
        ["sp", "le"],
        ["le", "e"],
      ],
    );
    const { regions, error } = computeItemsRegions(graph);
    expect(error).toBeNull();
    expect(regions[0].regionNodeIds).toEqual([]);
    expect(regions[0].collectFrom).toBe("sp");
  });
});

describe("computeItemsRegions — fail closed (adversarial)", () => {
  // HIGH-1: a conditional edge INSIDE a region would be silently ignored (the body runs
  // unconditionally per item) — must be a save-time 400.
  it("rejects a conditional edge inside the region", () => {
    const graph: GraphDef = {
      startNodeId: "s",
      nodes: [
        N("s", "start"),
        N("sp", "splitOut", { from: "s" }),
        N("a", "set"),
        N("b", "set"),
        N("le", "loopEnd", { from: "b" }),
      ],
      edges: [
        { from: "s", to: "sp" },
        { from: "sp", to: "a" },
        {
          from: "a",
          to: "b",
          condition: { path: "a.x", op: "eq", value: 1 },
        },
        { from: "b", to: "le" },
      ],
    };
    // A `set` can't route items — a conditional out-edge in a region is only allowed on if/switch.
    expect(computeItemsRegions(graph).error).toMatch(/conditional out-edge/);
    expect(validateGraph(graph).valid).toBe(false);
  });

  // #477: fan-out AFTER loopEnd (≥2 out-edges) is now ALLOWED — the interpreter fans the
  // walk out over loopEnd's successors (each fed the collected array), gated by
  // wf.patched("loop-fanout-v1"). The region still brackets splitOut…loopEnd cleanly.
  it("accepts a loopEnd with two outgoing edges (fan-out after the loop, #477)", () => {
    const graph: GraphDef = {
      startNodeId: "s",
      nodes: [
        N("s", "start"),
        N("sp", "splitOut", { from: "s" }),
        N("r", "set"),
        N("le", "loopEnd", { from: "r" }),
        N("a", "end"),
        N("b", "end"),
      ],
      edges: [
        { from: "s", to: "sp" },
        { from: "sp", to: "r" },
        { from: "r", to: "le" },
        { from: "le", to: "a" },
        { from: "le", to: "b" },
      ],
    };
    const res = computeItemsRegions(graph);
    expect(res.error).toBeNull();
    // The region is still the linear splitOut…loopEnd bracket; loopEnd's two out-edges are outside it.
    expect(res.regions).toHaveLength(1);
    expect(res.regions[0]).toMatchObject({ splitOutId: "sp", loopEndId: "le" });
    expect(validateGraph(graph).valid).toBe(true);
  });

  const cases: { name: string; graph: GraphDef; match: RegExp }[] = [
    {
      name: "region runs into a non-region node (end) with no loopEnd",
      graph: g(
        [
          N("s", "start"),
          N("sp", "splitOut", { from: "s" }),
          N("set", "set"),
          N("e", "end"),
        ],
        [
          ["s", "sp"],
          ["sp", "set"],
          ["set", "e"],
        ],
      ),
      match: /not allowed inside a splitOut region/,
    },
    {
      name: "a non-batchable/other node (rssRead) inside region",
      graph: g(
        [
          N("s", "start"),
          N("sp", "splitOut", { from: "s" }),
          N("r", "rssRead", { url: "https://x" }),
          N("le", "loopEnd", { from: "r" }),
        ],
        [
          ["s", "sp"],
          ["sp", "r"],
          ["r", "le"],
        ],
      ),
      match: /not allowed inside a splitOut region/,
    },
    {
      name: "durable node (wait) inside region",
      graph: g(
        [
          N("s", "start"),
          N("sp", "splitOut", { from: "s" }),
          N("w", "wait"),
          N("le", "loopEnd", { from: "w" }),
        ],
        [
          ["s", "sp"],
          ["sp", "w"],
          ["w", "le"],
        ],
      ),
      match: /not allowed inside a splitOut region/,
    },
    {
      name: "branch inside region",
      graph: g(
        [
          N("s", "start"),
          N("sp", "splitOut", { from: "s" }),
          N("set", "set"),
          N("a", "set"),
          N("b", "set"),
          N("le", "loopEnd", { from: "set" }),
        ],
        [
          ["s", "sp"],
          ["sp", "set"],
          ["set", "a"],
          ["set", "b"],
          ["a", "le"],
        ],
      ),
      // `b` branches off but dead-ends (never reaches loopEnd) → SESE rejects it.
      match: /does not reach loopEnd/,
    },
    {
      name: "join (boundary-crossing edge into a region node)",
      graph: g(
        [
          N("s", "start"),
          N("out", "set"),
          N("sp", "splitOut", { from: "s" }),
          N("r", "set"),
          N("le", "loopEnd", { from: "r" }),
        ],
        // `out` (outside) also edges INTO region node `r` → r has 2 in-edges → join
        [
          ["s", "out"],
          ["out", "r"],
          ["s", "sp"],
          ["sp", "r"],
          ["r", "le"],
        ],
      ),
      // an outside node edging into region node `r` is a boundary crossing → single-entry violation.
      match: /single-entry violation/,
    },
    {
      name: "nested splitOut",
      graph: g(
        [
          N("s", "start"),
          N("sp", "splitOut", { from: "s" }),
          N("sp2", "splitOut", { from: "sp" }),
          N("le", "loopEnd", { from: "sp2" }),
        ],
        [
          ["s", "sp"],
          ["sp", "sp2"],
          ["sp2", "le"],
        ],
      ),
      match: /nested splitOut/,
    },
    {
      name: "loopEnd collects a node outside its region",
      graph: g(
        [
          N("s", "start"),
          N("sp", "splitOut", { from: "s" }),
          N("r", "set"),
          N("le", "loopEnd", { from: "s" }), // collects the start node, not a region node
        ],
        [
          ["s", "sp"],
          ["sp", "r"],
          ["r", "le"],
        ],
      ),
      match: /not in its splitOut region/,
    },
    {
      name: "stray loopEnd with no splitOut",
      graph: g(
        [N("s", "start"), N("le", "loopEnd", { from: "s" }), N("e", "end")],
        [
          ["s", "le"],
          ["le", "e"],
        ],
      ),
      match: /no matching splitOut/,
    },
    {
      name: "splitOut with two outgoing edges",
      graph: g(
        [
          N("s", "start"),
          N("sp", "splitOut", { from: "s" }),
          N("a", "set"),
          N("b", "set"),
        ],
        [
          ["s", "sp"],
          ["sp", "a"],
          ["sp", "b"],
        ],
      ),
      // splitOut fans out but neither branch reaches a loopEnd → no region closer.
      match: /no matching loopEnd/,
    },
  ];

  for (const c of cases) {
    it(`rejects: ${c.name}`, () => {
      expect(computeItemsRegions(c.graph).error).toMatch(c.match);
      // and validateGraph (the save-gate) surfaces it as invalid
      expect(validateGraph(c.graph).valid).toBe(false);
    });
  }
});

// Conditional edge helper (the plain `g()` only makes unconditional edges).
type CEdge = { from: string; to: string; condition?: object };
function gc(nodes: NodeDef[], edges: CEdge[]): GraphDef {
  return { startNodeId: nodes[0].id, nodes, edges };
}
const eq = (nodeId: string, field: string, value: unknown) => ({
  path: `${nodeId}.${field}`,
  op: "eq" as const,
  value,
});

/** The canonical A4 if/else region: sp → if → (true→A | false→B) → merge → loopEnd, collect the merge. */
function ifElseRegion(collectFrom = "m"): GraphDef {
  return gc(
    [
      N("s", "start"),
      N("sp", "splitOut", { from: "s", path: "items" }),
      N("if", "if", { conditions: [] }),
      N("A", "set", { fields: {} }),
      N("B", "set", { fields: {} }),
      N("m", "merge", { mode: "array" }),
      N("le", "loopEnd", { from: collectFrom }),
      N("e", "end"),
    ],
    [
      { from: "s", to: "sp" },
      { from: "sp", to: "if" },
      { from: "if", to: "A", condition: eq("if", "result", true) },
      { from: "if", to: "B", condition: eq("if", "result", false) },
      { from: "A", to: "m" },
      { from: "B", to: "m" },
      { from: "m", to: "le" },
      { from: "le", to: "e" },
    ],
  );
}

describe("computeItemsRegions — A4 non-linear regions (sub-DAG)", () => {
  it("accepts an exhaustive if/else region rejoining at a merge", () => {
    const { regions, error } = computeItemsRegions(ifElseRegion());
    expect(error).toBeNull();
    expect(regions).toHaveLength(1);
    expect(regions[0].kind).toBe("a4");
    expect(regions[0].collectFrom).toBe("m");
    // topological order: if before its branches, both branches before the merge
    const order = regions[0].regionNodeIds;
    expect(order[0]).toBe("if");
    expect(order.indexOf("A")).toBeLessThan(order.indexOf("m"));
    expect(order.indexOf("B")).toBeLessThan(order.indexOf("m"));
    expect(validateGraph(ifElseRegion()).valid).toBe(true);
  });

  it("accepts a switch region whose out-edges cover every rule + the fallback", () => {
    const graph = gc(
      [
        N("s", "start"),
        N("sp", "splitOut", { from: "s", path: "items" }),
        N("sw", "switch", {
          rules: [{ name: "a", condition: eq("sp", "k", 1) }],
          fallback: "other",
        }),
        N("A", "set", { fields: {} }),
        N("O", "set", { fields: {} }),
        N("m", "merge", { mode: "array" }),
        N("le", "loopEnd", { from: "m" }),
        N("e", "end"),
      ],
      [
        { from: "s", to: "sp" },
        { from: "sp", to: "sw" },
        { from: "sw", to: "A", condition: eq("sw", "matched", "a") },
        { from: "sw", to: "O", condition: eq("sw", "matched", "other") },
        { from: "A", to: "m" },
        { from: "O", to: "m" },
        { from: "m", to: "le" },
        { from: "le", to: "e" },
      ],
    );
    const { regions, error } = computeItemsRegions(graph);
    expect(error).toBeNull();
    expect(regions[0].kind).toBe("a4");
  });

  const a4Rejects: { name: string; graph: GraphDef; match: RegExp }[] = [
    {
      name: "non-exhaustive if (no false branch)",
      graph: gc(
        [
          N("s", "start"),
          N("sp", "splitOut", { from: "s", path: "items" }),
          N("if", "if", { conditions: [] }),
          N("A", "set", { fields: {} }),
          N("le", "loopEnd", { from: "A" }),
        ],
        [
          { from: "s", to: "sp" },
          { from: "sp", to: "if" },
          { from: "if", to: "A", condition: eq("if", "result", true) },
          { from: "A", to: "le" },
        ],
      ),
      match: /not exhaustive/,
    },
    {
      name: "switch missing a fallback edge",
      graph: gc(
        [
          N("s", "start"),
          N("sp", "splitOut", { from: "s", path: "items" }),
          N("sw", "switch", {
            rules: [{ name: "a", condition: eq("sp", "k", 1) }],
            fallback: "other",
          }),
          N("A", "set", { fields: {} }),
          N("le", "loopEnd", { from: "A" }),
        ],
        [
          { from: "s", to: "sp" },
          { from: "sp", to: "sw" },
          { from: "sw", to: "A", condition: eq("sw", "matched", "a") },
          { from: "A", to: "le" },
        ],
      ),
      match: /not exhaustive/,
    },
    {
      name: "collectFrom on one branch (doesn't post-dominate)",
      graph: ifElseRegion("A"), // collect the true-branch, not the merge
      match: /not on every per-item path/,
    },
    {
      name: "a durable node (wait) inside an A4 region",
      graph: gc(
        [
          N("s", "start"),
          N("sp", "splitOut", { from: "s", path: "items" }),
          N("if", "if", { conditions: [] }),
          N("A", "set", { fields: {} }),
          N("w", "wait"),
          N("m", "merge", { mode: "array" }),
          N("le", "loopEnd", { from: "m" }),
        ],
        [
          { from: "s", to: "sp" },
          { from: "sp", to: "if" },
          { from: "if", to: "A", condition: eq("if", "result", true) },
          { from: "if", to: "w", condition: eq("if", "result", false) },
          { from: "A", to: "m" },
          { from: "w", to: "m" },
          { from: "m", to: "le" },
        ],
      ),
      match: /not allowed inside a splitOut region/,
    },
  ];
  for (const c of a4Rejects) {
    it(`rejects: ${c.name}`, () => {
      expect(computeItemsRegions(c.graph).error).toMatch(c.match);
      expect(validateGraph(c.graph).valid).toBe(false);
    });
  }
});
