import { describe, expect, it } from "vitest";
import {
  createGraphStreamExtractor,
  scanGraphElements,
} from "../src/graphs/graph-stream-extractor";

// A realistic free-form draft the model streams (with a filled config object + a
// conditional edge, so nesting is exercised).
const GRAPH = {
  name: "New-lead alert",
  startNodeId: "hook",
  nodes: [
    { id: "hook", type: "webhookTrigger", config: {} },
    {
      id: "classify",
      type: "agent",
      config: {
        provider: "anthropic",
        model: "claude-opus-4-8",
        systemPrompt:
          'Summarize {{ hook.body }} and set priority to "high" or "low".',
      },
    },
    {
      id: "gate",
      type: "if",
      config: { path: "classify.output", op: "eq", value: true },
    },
    { id: "done", type: "end" },
  ],
  edges: [
    { from: "hook", to: "classify" },
    { from: "classify", to: "gate" },
    {
      from: "gate",
      to: "done",
      condition: { path: "gate.result", op: "eq", value: true },
    },
  ],
};
const FULL = JSON.stringify(GRAPH, null, 2);

describe("scanGraphElements (pure)", () => {
  it("extracts every node + edge + the name from a complete graph", () => {
    const { name, nodes, edges } = scanGraphElements(FULL);
    expect(name).toBe("New-lead alert");
    expect(nodes).toEqual(GRAPH.nodes);
    expect(edges).toEqual(GRAPH.edges);
  });

  it("emits a node only once its closing brace has arrived — never a half-object", () => {
    // Cut the buffer in the MIDDLE of the second node's config (before its `}`).
    const cut = FULL.indexOf('"claude-opus-4-8"');
    const partial = FULL.slice(0, cut + 5);
    const { nodes } = scanGraphElements(partial);
    // Only the first (fully-closed) node is present; the half-written one is withheld.
    expect(nodes).toEqual([GRAPH.nodes[0]]);
  });

  it("does NOT mistake a `name` inside a node config for the workflow name", () => {
    const g = JSON.stringify({
      startNodeId: "a",
      nodes: [
        { id: "a", type: "agent", config: { name: "inner-not-the-workflow" } },
      ],
      edges: [],
      name: "Real Workflow Name",
    });
    expect(scanGraphElements(g).name).toBe("Real Workflow Name");
  });

  it("tolerates a ```json fence + prose around the object", () => {
    const wrapped =
      "Here is your workflow:\n```json\n" + FULL + "\n```\nEnjoy!";
    const { nodes, edges, name } = scanGraphElements(wrapped);
    expect(name).toBe("New-lead alert");
    expect(nodes).toHaveLength(4);
    expect(edges).toHaveLength(3);
  });

  it("handles braces/brackets inside string values", () => {
    const g = JSON.stringify({
      startNodeId: "a",
      nodes: [
        {
          id: "a",
          type: "httpRequest",
          config: { body: "{ not: [a, real, brace] }" },
        },
      ],
      edges: [],
    });
    expect(scanGraphElements(g).nodes).toEqual([
      {
        id: "a",
        type: "httpRequest",
        config: { body: "{ not: [a, real, brace] }" },
      },
    ]);
  });
});

/** Split `s` into chunks of size `n` to simulate token deltas. */
function chunks(s: string, n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n));
  return out;
}

describe("createGraphStreamExtractor (stateful, growing prefixes)", () => {
  it("emits each node/edge exactly once, in order, as the buffer grows", () => {
    const ex = createGraphStreamExtractor();
    const seenNodes: unknown[] = [];
    const seenEdges: unknown[] = [];
    let seenName: string | undefined;
    let nameEmissions = 0;

    let acc = "";
    for (const delta of chunks(FULL, 7)) {
      acc += delta; // the streaming loop accumulates, then pushes the CUMULATIVE text
      const got = ex.push(acc);
      if (got.name !== undefined) {
        seenName = got.name;
        nameEmissions++;
      }
      seenNodes.push(...got.nodes);
      seenEdges.push(...got.edges);
    }

    expect(seenName).toBe("New-lead alert");
    expect(nameEmissions).toBe(1); // never repeats
    expect(seenNodes).toEqual(GRAPH.nodes); // exactly once each, in order
    expect(seenEdges).toEqual(GRAPH.edges);
  });

  it("emits nothing new when pushed the same prefix twice (idempotent by count)", () => {
    const ex = createGraphStreamExtractor();
    const half = FULL.slice(0, FULL.indexOf('"edges"'));
    const first = ex.push(half);
    expect(first.nodes.length).toBeGreaterThan(0);
    const again = ex.push(half);
    expect(again).toEqual({ nodes: [], edges: [] });
  });

  it("degrades gracefully on a stream that never closes (partial tail withheld)", () => {
    const ex = createGraphStreamExtractor();
    // Everything up to just after the 3rd node closes, then the buffer ends mid-4th.
    const upTo = FULL.indexOf('{ "id": "done"'.replace(/ /g, "")); // formatting-agnostic
    const cut = upTo === -1 ? FULL.indexOf('"done"') : upTo;
    const got = ex.push(FULL.slice(0, cut));
    // No throw; only fully-closed nodes surfaced.
    expect(
      got.nodes.every((n) => typeof (n as { id: string }).id === "string"),
    ).toBe(true);
  });
});
