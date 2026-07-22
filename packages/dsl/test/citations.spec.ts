import { describe, expect, it } from "vitest";
import { collectCitations } from "../src/citations";
import type { GraphDef } from "../src/types";

// A minimal RAG chat graph: query → vectorQuery → agent → respond.
const RAG_GRAPH: GraphDef = {
  startNodeId: "q",
  nodes: [
    { id: "q", type: "chatTrigger", config: {} },
    {
      id: "rag",
      type: "vectorQuery",
      config: { collection: "docs", from: "q" },
    },
    { id: "agent", type: "agent", config: {} },
    { id: "respond", type: "respondToWebhook", config: {} },
  ],
  edges: [
    { from: "q", to: "rag" },
    { from: "rag", to: "agent" },
    { from: "agent", to: "respond" },
  ],
};

describe("collectCitations (issue #482)", () => {
  it("derives citations from a vectorQuery node's matches in ctx", () => {
    // Exactly the shape handleVectorQuery writes: ctx[id] = { matches: [{ chunkText, score }] }.
    const ctx = {
      rag: {
        matches: [
          {
            chunkText: "Refunds are processed within 5 business days.",
            score: 0.91,
          },
          { chunkText: "Contact support@acme.test for help.", score: 0.77 },
        ],
      },
    };
    expect(collectCitations(RAG_GRAPH, ctx)).toEqual([
      {
        source: "docs",
        snippet: "Refunds are processed within 5 business days.",
        score: 0.91,
      },
      {
        source: "docs",
        snippet: "Contact support@acme.test for help.",
        score: 0.77,
      },
    ]);
  });

  it("returns [] when the graph has no vectorQuery (no RAG step)", () => {
    const graph: GraphDef = {
      startNodeId: "q",
      nodes: [
        { id: "q", type: "chatTrigger", config: {} },
        { id: "respond", type: "respondToWebhook", config: {} },
      ],
      edges: [{ from: "q", to: "respond" }],
    };
    expect(collectCitations(graph, { q: {} })).toEqual([]);
  });

  it("returns [] when a vectorQuery node exists but produced no matches", () => {
    expect(collectCitations(RAG_GRAPH, { rag: { matches: [] } })).toEqual([]);
    // vectorQuery in the graph but it never ran (not in ctx) → still safe-empty.
    expect(collectCitations(RAG_GRAPH, {})).toEqual([]);
  });

  it("truncates a long chunk to a bounded snippet", () => {
    const long = "x".repeat(1200);
    const [c] = collectCitations(RAG_GRAPH, {
      rag: { matches: [{ chunkText: long, score: 0.5 }] },
    });
    expect(c.snippet.length).toBeLessThan(long.length);
    expect(c.snippet.endsWith("…")).toBe(true);
  });

  it("omits score/source gracefully when absent", () => {
    const graph: GraphDef = {
      startNodeId: "q",
      nodes: [
        { id: "q", type: "chatTrigger", config: {} },
        // no collection on the config
        { id: "rag", type: "vectorQuery", config: { from: "q" } as never },
      ],
      edges: [{ from: "q", to: "rag" }],
    };
    expect(
      collectCitations(graph, { rag: { matches: [{ chunkText: "hi" }] } }),
    ).toEqual([{ snippet: "hi" }]);
  });
});
