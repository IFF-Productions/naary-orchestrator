/**
 * A `304 Not Modified` must never wedge a screen (#1038).
 *
 * Production returned 304 for `GET /executions` (the API set no `Cache-Control` and left
 * Express's ETag on, so the response was conditionally cacheable). `Response.ok` is true only
 * for 200–299, so every non-2xx branch in the API client treated that 304 as a failure: it has
 * no body, `res.json()` rejected, the `.catch(() => null)` swallowed it, and the caller got an
 * `HttpError(304)` carrying no reason at all — a dead end on a screen that asked for data.
 *
 * The fix is two-layered, and both layers are asserted here:
 *   1. PREVENT — requests go out with `cache: "no-store"`, so the browser never issues the
 *      conditional revalidation that can come back 304.
 *   2. COPE — if a 304 arrives anyway (a proxy/CDN can produce one we never asked for), a safe
 *      (GET/HEAD) request is re-issued once with `cache: "reload"` to force a full response.
 *      Only if THAT is 304 too does the caller get an error — and then a stated one, so the
 *      screen leaves its loading state with something a human can act on.
 *
 * Both client paths are covered because `GET /executions` goes through the TYPED client
 * (`client.GET` + `unwrap`, see lib/api/runs.ts), while most of the app still calls `http()`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/firebase-lazy", () => ({
  getBearerToken: async () => "test-token",
}));

import { client, notModifiedRetry, unwrap } from "../src/lib/api/client";
import { HttpError, http } from "../src/lib/api/http";

/** A real 304: status set, body null (the spec forbids a body on 304), so `.json()` rejects. */
const notModified = (): Response => new Response(null, { status: 304 });
const okJson = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

/** Stub global fetch with a queue of responses; returns the mock so calls can be inspected. */
function stubFetch(...responses: Response[]) {
  const mock = vi.fn();
  for (const r of responses) mock.mockResolvedValueOnce(r);
  mock.mockResolvedValue(responses[responses.length - 1]);
  vi.stubGlobal("fetch", mock);
  return mock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("http() and a 304", () => {
  it("asks the browser not to use its cache, so no conditional request is made", async () => {
    const fetchMock = stubFetch(okJson({ items: [] }));
    await http("/executions");
    expect(fetchMock.mock.calls[0][1].cache).toBe("no-store");
  });

  it("re-fetches past the cache and resolves with the body — it does NOT throw", async () => {
    const fetchMock = stubFetch(
      notModified(),
      okJson({ items: [{ id: "r1" }] }),
    );
    // The load must SETTLE with data. Before the fix this rejected with a message-less HttpError.
    await expect(http("/executions")).resolves.toEqual({
      items: [{ id: "r1" }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][1].cache).toBe("reload");
  });

  it("rejects with a STATED reason when the retry is 304 as well (never pending)", async () => {
    stubFetch(notModified(), notModified());
    const e = (await http("/executions").catch((x) => x)) as HttpError;
    expect(e).toBeInstanceOf(HttpError);
    expect(e.status).toBe(304);
    // The old failure mode was a bare "GET /executions → 304" with no explanation.
    expect(e.message).toMatch(/304 Not Modified/i);
    expect(e.message).toContain("GET /executions");
  });

  it("does not re-issue a non-idempotent request", async () => {
    const fetchMock = stubFetch(notModified());
    await expect(
      http("/executions", { method: "POST" }),
    ).rejects.toBeInstanceOf(HttpError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("typed client (the path GET /executions actually takes) and a 304", () => {
  it("sends cache: no-store on a real client request", async () => {
    const fetchMock = stubFetch(okJson({ items: [], nextCursor: null }));
    // Two per-request overrides so the REAL client instance (and its options) can run in node:
    //  - `baseUrl`: the client's own is the relative "/api", which node's Request rejects;
    //  - `fetch`: openapi-fetch captured `globalThis.fetch` at createClient() time, i.e. before
    //    vi.stubGlobal could reach it.
    await client.GET("/executions", {
      baseUrl: "http://localhost",
      fetch: fetchMock,
    });
    const request = fetchMock.mock.calls[0][0] as Request;
    expect(request.cache).toBe("no-store");
  });

  it("retries a 304 past the cache and yields the body", async () => {
    const fetchMock = stubFetch(
      notModified(),
      okJson({ items: [{ id: "r1" }], nextCursor: null }),
    );
    const result = await client.GET("/executions", {
      baseUrl: "http://localhost",
      fetch: fetchMock,
    });
    expect(unwrap(result)).toEqual({ items: [{ id: "r1" }], nextCursor: null });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((fetchMock.mock.calls[1][0] as Request).cache).toBe("reload");
  });

  it("the retry middleware leaves a non-GET 304 alone", async () => {
    const fetchMock = stubFetch(okJson({}));
    const request = new Request("http://localhost/executions", {
      method: "POST",
    });
    const out = await notModifiedRetry.onResponse!({
      request,
      response: notModified(),
    } as never);
    expect(out).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("unwrap() explains a 304 that survived the retry instead of throwing a bare status", () => {
    const e = (() => {
      try {
        unwrap({ response: notModified() });
      } catch (x) {
        return x as HttpError;
      }
    })();
    expect(e).toBeInstanceOf(HttpError);
    expect(e!.status).toBe(304);
    expect(e!.message).toMatch(/304 Not Modified/i);
  });
});
