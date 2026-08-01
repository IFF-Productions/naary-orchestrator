/**
 * What a builder turn puts on the wire (#1003).
 *
 * The canvas panel is a conversation now, and every one of its turns has to carry the LIVE canvas
 * as the graph to change. The session's own `currentGraph` is seeded from the saved workflow row
 * and would be stale the moment the user drags a node between turns — the model would then edit a
 * graph nobody is looking at and hand back a "change" with their hand-edits removed.
 *
 * That whole guarantee reduces, on this side, to one field in one request body. It is invisible to
 * `tsc` (an optional argument that is simply never forwarded still typechecks) and invisible to the
 * canvas (the turn succeeds — it just edits the wrong thing), so it is asserted against the request
 * itself rather than against anything downstream of it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

// Replace the lazy-Firebase accessor with a tiny stub — sendBuilderTurn only needs a bearer token
// from it. (http.ts is import-safe in node: it guards `typeof localStorage`.)
vi.mock("../src/lib/firebase-lazy", () => ({
  getBearerToken: async () => "test-token",
}));

import { builderApi } from "../src/lib/api/builder";

const GRAPH = {
  startNodeId: "start",
  nodes: [
    { id: "start", type: "start" },
    { id: "notify", type: "httpRequest" },
    { id: "end", type: "end" },
  ],
  edges: [
    { from: "start", to: "notify" },
    { from: "notify", to: "end" },
  ],
} as never;

/** A fetch() Response that streams one terminal `result` frame. */
function resultResponse(graph: unknown) {
  const sse = `event: result\ndata: ${JSON.stringify({ name: "Flow", graph })}\n\n`;
  const bytes = new TextEncoder().encode(sse);
  return {
    status: 200,
    ok: true,
    headers: {
      get: (h: string) => (h === "content-type" ? "text/event-stream" : null),
    },
    body: new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes);
        c.close();
      },
    }),
    json: async () => ({}),
  } as unknown as Response;
}

/** The JSON body of the single fetch the call made. */
function sentBody(
  fetchMock: ReturnType<typeof vi.fn>,
): Record<string, unknown> {
  const init = fetchMock.mock.calls[0][1] as { body: string };
  return JSON.parse(init.body) as Record<string, unknown>;
}

afterEach(() => vi.restoreAllMocks());

describe("builderApi.sendBuilderTurn", () => {
  it("sends the caller's graph, so a turn edits what's on the canvas", async () => {
    const fetchMock = vi.fn().mockResolvedValue(resultResponse(GRAPH));
    vi.stubGlobal("fetch", fetchMock);

    await builderApi.sendBuilderTurn(
      "s-1",
      "Add a Slack step",
      "anthropic",
      undefined,
      GRAPH,
    );

    const body = sentBody(fetchMock);
    expect(body.message).toBe("Add a Slack step");
    expect(body.provider).toBe("anthropic");
    // The whole point: the graph reaches the server. Compared in full — a truncated or
    // differently-shaped graph is exactly as wrong as none at all.
    expect(body.graph).toEqual(GRAPH);
  });

  it("omits `graph` when the caller has none, leaving the session's own draft in charge", async () => {
    const fetchMock = vi.fn().mockResolvedValue(resultResponse(GRAPH));
    vi.stubGlobal("fetch", fetchMock);

    await builderApi.sendBuilderTurn("s-1", "Build me an onboarding flow");

    const body = sentBody(fetchMock);
    expect(body.message).toBe("Build me an onboarding flow");
    // ABSENT, not null/undefined-valued: the server treats "no graph" as "use yours", and a
    // present-but-empty field is a different instruction (see apps/api/src/builder/turn-input.ts).
    expect("graph" in body).toBe(false);
    expect("provider" in body).toBe(false);
  });
});
