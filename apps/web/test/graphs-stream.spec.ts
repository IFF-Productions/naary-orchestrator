import { afterEach, describe, expect, it, vi } from "vitest";

// Replace the lazy-Firebase accessor with a tiny stub — generateGraphStream only needs a
// bearer token from it. (http.ts is import-safe in node: it guards `typeof localStorage`.)
vi.mock("../src/lib/firebase-lazy", () => ({
  getBearerToken: async () => "test-token",
}));

import { graphsApi } from "../src/lib/api/graphs";

/** A fetch() Response whose body streams `sse` as one or more UTF-8 chunks. */
function sseResponse(sse: string, chunkSize = 9) {
  const bytes = new TextEncoder().encode(sse);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += chunkSize) {
        controller.enqueue(bytes.slice(i, i + chunkSize));
      }
      controller.close();
    },
  });
  return {
    status: 200,
    ok: true,
    headers: {
      get: (h: string) => (h === "content-type" ? "text/event-stream" : null),
    },
    body: stream,
    json: async () => ({}),
  } as unknown as Response;
}

afterEach(() => vi.restoreAllMocks());

describe("graphsApi.generateGraphStream (live frames)", () => {
  it("invokes onMeta/onNode/onEdge as frames arrive, then resolves to the result graph", async () => {
    const resultGraph = {
      startNodeId: "start",
      nodes: [
        { id: "start", type: "start" },
        { id: "end", type: "end" },
      ],
      edges: [{ from: "start", to: "end" }],
    };
    const sse =
      ": connected\n\n" +
      `event: meta\ndata: ${JSON.stringify({ name: "My Flow" })}\n\n` +
      `event: node\ndata: ${JSON.stringify({ id: "start", type: "start" })}\n\n` +
      ": ping\n\n" +
      `event: node\ndata: ${JSON.stringify({ id: "end", type: "end" })}\n\n` +
      `event: edge\ndata: ${JSON.stringify({ from: "start", to: "end" })}\n\n` +
      `event: result\ndata: ${JSON.stringify({ name: "My Flow", graph: resultGraph })}\n\n`;

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sseResponse(sse)));

    const metas: string[] = [];
    const nodes: unknown[] = [];
    const edges: unknown[] = [];
    const out = await graphsApi.generateGraphStream(
      "build me a flow",
      undefined,
      {
        onMeta: (n) => metas.push(n),
        onNode: (n) => nodes.push(n),
        onEdge: (e) => edges.push(e),
      },
    );

    expect(metas).toEqual(["My Flow"]);
    expect(nodes).toEqual([
      { id: "start", type: "start" },
      { id: "end", type: "end" },
    ]);
    expect(edges).toEqual([{ from: "start", to: "end" }]);
    expect(out.name).toBe("My Flow");
    expect(out.graph.nodes).toHaveLength(2);
  });

  it("surfaces an error frame as a thrown Error (hooks never fire)", async () => {
    const sse =
      ": connected\n\n" +
      `event: error\ndata: ${JSON.stringify({ status: 422, message: "Try rephrasing." })}\n\n`;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sseResponse(sse)));

    const onNode = vi.fn();
    await expect(
      graphsApi.generateGraphStream("x", undefined, { onNode }),
    ).rejects.toThrow("Try rephrasing.");
    expect(onNode).not.toHaveBeenCalled();
  });

  it("an old-API result-only stream (no node/edge frames) still resolves — backward compatible", async () => {
    const graph = {
      startNodeId: "s",
      nodes: [{ id: "s", type: "start" }],
      edges: [],
    };
    const sse =
      ": connected\n\n" +
      `event: result\ndata: ${JSON.stringify({ name: "Legacy", graph })}\n\n`;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sseResponse(sse)));

    const onNode = vi.fn();
    const out = await graphsApi.generateGraphStream("x", undefined, { onNode });
    expect(out.name).toBe("Legacy");
    expect(onNode).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// `previous` — the flag that turns generation into an EDIT. Its absence is the
// whole bug: the canvas asked for a change, sent only the description, and got
// a replacement workflow back.
// ---------------------------------------------------------------------------
describe("graphsApi.generateGraphStream (`previous` ⇒ edit)", () => {
  const GRAPH = {
    startNodeId: "s",
    nodes: [{ id: "s", type: "start" }],
    edges: [],
  };
  const RESULT =
    ": connected\n\n" +
    `event: result\ndata: ${JSON.stringify({ name: "Flow", graph: GRAPH })}\n\n`;

  function bodyOf(fetchMock: ReturnType<typeof vi.fn>) {
    return JSON.parse(fetchMock.mock.calls[0][1].body as string) as Record<
      string,
      unknown
    >;
  }

  it("puts the graph in the request body when given one", async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse(RESULT));
    vi.stubGlobal("fetch", fetchMock);

    await graphsApi.generateGraphStream(
      "no open incidents ⇒ end",
      "anthropic",
      undefined,
      GRAPH,
    );

    expect(bodyOf(fetchMock)).toEqual({
      prompt: "no open incidents ⇒ end",
      provider: "anthropic",
      previous: GRAPH,
    });
  });

  it("omits `previous` entirely when there's nothing to edit — a create must stay a create", async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse(RESULT));
    vi.stubGlobal("fetch", fetchMock);

    await graphsApi.generateGraphStream("build me a flow");

    const body = bodyOf(fetchMock);
    expect(body).toEqual({ prompt: "build me a flow" });
    expect("previous" in body).toBe(false);
  });

  it("carries `previous` onto the legacy JSON route when the API has no /stream", async () => {
    // Deploy skew must not silently downgrade an edit into a create — the exact failure.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        status: 404,
        ok: false,
        headers: { get: () => null },
        json: async () => ({}),
      } as unknown as Response)
      .mockResolvedValueOnce({
        status: 200,
        ok: true,
        headers: { get: () => "application/json" },
        json: async () => ({ name: "Flow", graph: GRAPH }),
      } as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);

    const out = await graphsApi.generateGraphStream(
      "add a branch",
      undefined,
      undefined,
      GRAPH,
    );

    expect(out.name).toBe("Flow");
    const fallback = JSON.parse(
      fetchMock.mock.calls[1][1].body as string,
    ) as Record<string, unknown>;
    expect(fallback).toEqual({ prompt: "add a branch", previous: GRAPH });
  });
});
