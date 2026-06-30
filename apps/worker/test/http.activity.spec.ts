import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MissingConnectionTokenError,
  assertEgressAllowed,
} from "@naary/connections";
import {
  __setObjectStore,
  MemoryObjectStore,
  isClaimCheck,
  resolveClaimChecks,
} from "@naary/storage";
import {
  __httpDeps,
  type HttpRequestConfig,
  callHttpRequest,
} from "../src/temporal/activities";

const META = { tenantId: "t1", executionId: "exec-1", nodeId: "http" };
const CFG: HttpRequestConfig = {
  method: "GET",
  url: "https://api.example.com/v1/things",
};

/** Minimal Response-like stub: just what the activity reads (status/headers/text). */
function res(
  status: number,
  body: unknown,
  contentType = "application/json",
): Response {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    status,
    headers: {
      get: (k: string) =>
        k.toLowerCase() === "content-type" ? contentType : null,
      entries: () => Object.entries({ "content-type": contentType }),
    },
    text: async () => text,
  } as unknown as Response;
}

const fetchMock = vi.fn();
const authMock = vi.fn();
let store: MemoryObjectStore;

beforeEach(() => {
  fetchMock.mockReset();
  authMock.mockReset();
  authMock.mockResolvedValue({});
  __httpDeps.fetch = fetchMock as never;
  __httpDeps.resolveAuthHeader = authMock as never;
  // Default: skip the real DNS-backed egress check; specific tests opt back in.
  __httpDeps.assertEgressAllowed = (async (u: string) => new URL(u)) as never;
  store = new MemoryObjectStore();
  __setObjectStore(store);
});

describe("callHttpRequest activity", () => {
  it("performs the request and returns {httpStatus, headers, body}", async () => {
    fetchMock.mockResolvedValue(res(200, { ok: true, id: 7 }));

    const result = await callHttpRequest(CFG, {}, META);

    expect(result).toMatchObject({
      status: "ok",
      httpStatus: 200,
      body: { ok: true, id: 7 },
      costUsd: 0,
    });
    expect(fetchMock.mock.calls[0][0].toString()).toBe(
      "https://api.example.com/v1/things",
    );
    expect(fetchMock.mock.calls[0][1].method).toBe("GET");
  });

  it("returns a non-2xx response for the graph to branch on (does NOT throw)", async () => {
    fetchMock.mockResolvedValue(res(404, { error: "not found" }));

    const result = await callHttpRequest(CFG, {}, META);

    expect(result.httpStatus).toBe(404);
    expect(result.body).toEqual({ error: "not found" });
  });

  it("throws a non-retryable failure on status >= 400 when failOnErrorStatus", async () => {
    fetchMock.mockResolvedValue(res(500, "boom", "text/plain"));

    await expect(
      callHttpRequest({ ...CFG, failOnErrorStatus: true }, {}, META),
    ).rejects.toMatchObject({ nonRetryable: true, type: "HTTP_ERROR_STATUS" });
  });

  it("attaches the connection's auth header, resolved in-activity (never in config)", async () => {
    authMock.mockResolvedValue({ Authorization: "Bearer tok" });
    fetchMock.mockResolvedValue(res(200, {}));

    await callHttpRequest({ ...CFG, connectionId: "conn-1" }, {}, META);

    expect(authMock).toHaveBeenCalledWith("t1", "conn-1");
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer tok");
  });

  it("applies static query params, a JSON body, and a default content-type", async () => {
    fetchMock.mockResolvedValue(res(201, { created: true }));

    await callHttpRequest(
      {
        method: "POST",
        url: "https://api.example.com/v1/things",
        query: { q: "open" },
        body: { title: "hello" },
      },
      {},
      META,
    );

    const [url, init] = fetchMock.mock.calls[0];
    expect(url.toString()).toContain("q=open");
    expect(init.body).toBe(JSON.stringify({ title: "hello" }));
    expect(init.headers["Content-Type"]).toBe("application/json");
  });

  it("claim-checks a large response body to object storage (Arch§4.6)", async () => {
    fetchMock.mockResolvedValue(res(200, { blob: "z".repeat(1_100_000) }));

    const result = await callHttpRequest(CFG, {}, META);

    expect(isClaimCheck(result.body)).toBe(true);
    expect(JSON.stringify(result.body).length).toBeLessThan(500);
    expect(await resolveClaimChecks(result.body, store)).toEqual({
      blob: "z".repeat(1_100_000),
    });
  });

  it("maps a blocked egress target to a non-retryable failure (real SSRF guard)", async () => {
    __httpDeps.assertEgressAllowed = assertEgressAllowed; // exercise the real guard

    await expect(
      callHttpRequest({ ...CFG, url: "http://169.254.169.254/" }, {}, META),
    ).rejects.toMatchObject({ nonRetryable: true, type: "BLOCKED_EGRESS" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps a missing/needs-reauth connection to a non-retryable failure", async () => {
    authMock.mockRejectedValue(new MissingConnectionTokenError("conn-1"));

    await expect(
      callHttpRequest({ ...CFG, connectionId: "conn-1" }, {}, META),
    ).rejects.toMatchObject({ nonRetryable: true, type: "CONNECTION_REAUTH" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rethrows a transient network error as retryable (for Temporal to retry)", async () => {
    fetchMock.mockRejectedValue(new Error("fetch failed"));

    await expect(callHttpRequest(CFG, {}, META)).rejects.toMatchObject({
      nonRetryable: false,
      type: "HTTP_TRANSIENT",
    });
  });
});
