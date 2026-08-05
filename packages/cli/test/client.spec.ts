import { describe, expect, it } from "vitest";
import {
  ApiClient,
  ApiError,
  AuthError,
  buildHeaders,
  buildUrl,
  type FetchLike,
} from "../src/client";
import type { ResolvedConfig } from "../src/config";

// A bare web origin — the only shape `apiUrl` may take, since the client appends the `/api/v1`
// proxy path itself (see the API_PREFIX comment in client.ts). Fixtures here used to say
// `http://localhost:3000`, the API's own port, which pinned a composed URL nothing serves.
const cfg = (over: Partial<ResolvedConfig> = {}): ResolvedConfig => ({
  apiUrl: "https://naary.example",
  token: "nry_test",
  ...over,
});

function fakeFetch(
  res: Partial<{
    ok: boolean;
    status: number;
    statusText: string;
    body: string;
  }>,
): { fetch: FetchLike; calls: Array<{ url: string; init: any }> } {
  const calls: Array<{ url: string; init: any }> = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: res.ok ?? true,
      status: res.status ?? 200,
      statusText: res.statusText,
      text: async () => res.body ?? "",
    };
  };
  return { fetch, calls };
}

describe("buildUrl", () => {
  it("prefixes /api/v1 and normalizes slashes", () => {
    expect(buildUrl("https://naary.example", "/runs")).toBe(
      "https://naary.example/api/v1/runs",
    );
    expect(buildUrl("https://naary.example/", "runs")).toBe(
      "https://naary.example/api/v1/runs",
    );
  });
  it("appends query params, skipping undefined/empty", () => {
    expect(buildUrl("http://x", "/runs", { limit: 5, q: undefined })).toBe(
      "http://x/api/v1/runs?limit=5",
    );
  });
});

describe("buildHeaders", () => {
  it("sets Authorization: Bearer when a token is present", () => {
    expect(buildHeaders(cfg(), false).Authorization).toBe("Bearer nry_test");
  });
  it("sets X-Environment-Id only when env is set", () => {
    expect(buildHeaders(cfg(), false)["X-Environment-Id"]).toBeUndefined();
    expect(buildHeaders(cfg({ env: "prod" }), false)["X-Environment-Id"]).toBe(
      "prod",
    );
  });
  it("sets Content-Type only when there is a body", () => {
    expect(buildHeaders(cfg(), false)["Content-Type"]).toBeUndefined();
    expect(buildHeaders(cfg(), true)["Content-Type"]).toBe("application/json");
  });
});

describe("ApiClient.request", () => {
  it("GETs the right URL with auth + env headers, parses JSON", async () => {
    const { fetch, calls } = fakeFetch({
      body: JSON.stringify({ runId: "r1" }),
    });
    const client = new ApiClient(cfg({ env: "sandbox" }), fetch);
    const out = await client.request<{ runId: string }>("/runs", {
      query: { limit: 3 },
    });
    expect(out).toEqual({ runId: "r1" });
    expect(calls[0].url).toBe("https://naary.example/api/v1/runs?limit=3");
    expect(calls[0].init.headers.Authorization).toBe("Bearer nry_test");
    expect(calls[0].init.headers["X-Environment-Id"]).toBe("sandbox");
  });

  it("serializes a POST body and sets method", async () => {
    const { fetch, calls } = fakeFetch({ body: "{}" });
    const client = new ApiClient(cfg(), fetch);
    await client.request("/runs", {
      method: "POST",
      body: { workflowKey: "wf" },
    });
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.body).toBe(JSON.stringify({ workflowKey: "wf" }));
  });

  it("throws AuthError (no network) when auth required but no token", async () => {
    const { fetch, calls } = fakeFetch({});
    const client = new ApiClient(cfg({ token: undefined }), fetch);
    await expect(client.request("/runs")).rejects.toBeInstanceOf(AuthError);
    expect(calls.length).toBe(0);
  });

  it("skips the auth check when requireAuth is false", async () => {
    const { fetch } = fakeFetch({ body: "{}" });
    const client = new ApiClient(cfg({ token: undefined }), fetch);
    await expect(
      client.request("/health", { requireAuth: false }),
    ).resolves.toBeDefined();
  });

  it("maps a non-2xx JSON error body to a friendly ApiError", async () => {
    const { fetch } = fakeFetch({
      ok: false,
      status: 422,
      statusText: "Unprocessable Entity",
      body: JSON.stringify({ message: "workflowKey is required" }),
    });
    const client = new ApiClient(cfg(), fetch);
    const err = await client
      .request("/runs", { method: "POST" })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(422);
    expect(err.message).toContain("workflowKey is required");
  });

  it("adds a hint for 401", async () => {
    const { fetch } = fakeFetch({ ok: false, status: 401, body: "" });
    const client = new ApiClient(cfg(), fetch);
    const err = await client.request("/runs").catch((e) => e);
    expect(err.message).toContain("naary auth status");
  });
});
