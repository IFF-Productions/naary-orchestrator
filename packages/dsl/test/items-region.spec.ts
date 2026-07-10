import { describe, expect, it } from "vitest";
import { computeItemsRegions } from "../src/items-region";
import { validateGraph } from "../src/branch";
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
    expect(computeItemsRegions(graph).error).toMatch(
      /conditional outgoing edge/,
    );
    expect(validateGraph(graph).valid).toBe(false);
  });

  // HIGH-2: fan-out after loopEnd (≥2 out-edges) would silently drop all but the first.
  it("rejects a loopEnd with two outgoing edges (fan-out after the loop)", () => {
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
    expect(computeItemsRegions(graph).error).toMatch(
      /at most one outgoing edge/,
    );
    expect(validateGraph(graph).valid).toBe(false);
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
      match: /branch/,
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
      match: /join/,
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
      match: /exactly one outgoing edge/,
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
