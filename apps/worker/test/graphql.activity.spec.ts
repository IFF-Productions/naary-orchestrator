import { beforeEach, describe, expect, it, vi } from "vitest";
import { assertEgressAllowed } from "@naary/connections";
import {
  __setObjectStore,
  MemoryObjectStore,
  isClaimCheck,
  resolveClaimChecks,
} from "@naary/storage";
import {
  __httpDeps,
  callGraphQL,
  type ResolvedGraphQL,
} from "../src/temporal/activities";

const META = { tenantId: "t1", executionId: "exec-1", nodeId: "gql" };
const CFG: ResolvedGraphQL = {
  url: "https://api.example.com/graphql",
  query: "query($id:ID!){ user(id:$id){ name } }",
  variables: { id: "42" },
  headers: {},
};

/** Minimal Response-like stub (status/headers/text) — what the activity reads. */
function res(status: number, body: unknown): Response {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    status,
    headers: {
      get: (k: string) =>
        k.toLowerCase() === "content-type" ? "application/json" : null,
      entries: () => Object.entries({ "content-type": "application/json" }),
    },
    text: async () => text,
  } as unknown as Response;
}

const fetchMock = vi.fn();
const secretMock = vi.fn();
let store: MemoryObjectStore;

beforeEach(() => {
  fetchMock.mockReset();
  secretMock.mockReset().mockResolvedValue(null);
  __httpDeps.fetch = fetchMock as never;
  __httpDeps.getSecret = secretMock as never;
  __httpDeps.assertEgressAllowed = (async (u: string) => new URL(u)) as never;
  store = new MemoryObjectStore();
  __setObjectStore(store);
});

describe("callGraphQL activity", () => {
  it("POSTs { query, variables } and returns { data, errors:null, httpStatus }", async () => {
    fetchMock.mockResolvedValue(res(200, { data: { user: { name: "Ada" } } }));

    const result = await callGraphQL(CFG, {}, META);

    expect(result).toEqual({
      status: "ok",
      httpStatus: 200,
      data: { user: { name: "Ada" } },
      errors: null,
      costUsd: 0,
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url.toString()).toBe("https://api.example.com/graphql");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      query: CFG.query,
      variables: { id: "42" },
    });
    expect(init.headers["content-type"]).toBe("application/json");
  });

  it("returns a 200-with-errors payload for the graph to branch on (does NOT throw)", async () => {
    fetchMock.mockResolvedValue(
      res(200, { data: null, errors: [{ message: "not found" }] }),
    );

    const result = await callGraphQL(CFG, {}, META);

    expect(result.httpStatus).toBe(200);
    expect(result.data).toBeNull();
    expect(result.errors).toEqual([{ message: "not found" }]);
  });

  it("failOnErrors → non-retryable when the errors array is non-empty", async () => {
    fetchMock.mockResolvedValue(res(200, { errors: [{ message: "boom" }] }));

    await expect(
      callGraphQL({ ...CFG, failOnErrors: true }, {}, META),
    ).rejects.toMatchObject({ nonRetryable: true, type: "GRAPHQL_ERROR" });
  });

  it("resolves $secrets in an auth HEADER; the value is in the request, not the result", async () => {
    const SECRET = "gql-token";
    secretMock.mockResolvedValue(SECRET);
    fetchMock.mockResolvedValue(res(200, { data: { ok: true } }));

    const result = await callGraphQL(
      { ...CFG, headers: { Authorization: "Bearer {{ $secrets.API }}" } },
      {},
      { ...META, environmentId: "env-prod" },
    );

    expect(secretMock).toHaveBeenCalledWith("t1", "env-prod", "API");
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe(
      `Bearer ${SECRET}`,
    );
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("resolves $secrets nested in VARIABLES (inlined into the sent body, not the result)", async () => {
    const SECRET = "var-secret";
    secretMock.mockResolvedValue(SECRET);
    fetchMock.mockResolvedValue(res(200, { data: {} }));

    const result = await callGraphQL(
      { ...CFG, variables: { token: "{{ $secrets.TOK }}", id: "1" } },
      {},
      { ...META, environmentId: "env-prod" },
    );

    expect(JSON.parse(fetchMock.mock.calls[0][1].body).variables).toEqual({
      token: SECRET,
      id: "1",
    });
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("a missing secret is a non-retryable failure naming the NAME (no request)", async () => {
    secretMock.mockResolvedValue(null);

    await expect(
      callGraphQL(
        { ...CFG, headers: { Authorization: "Bearer {{ $secrets.NOPE }}" } },
        {},
        { ...META, environmentId: "env-prod" },
      ),
    ).rejects.toMatchObject({
      nonRetryable: true,
      message: expect.stringContaining("NOPE"),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("claim-checks a large `data` payload to object storage", async () => {
    fetchMock.mockResolvedValue(
      res(200, { data: { blob: "z".repeat(1_100_000) } }),
    );

    const result = await callGraphQL(CFG, {}, META);

    expect(isClaimCheck(result.data)).toBe(true);
    expect(await resolveClaimChecks(result.data, store)).toEqual({
      blob: "z".repeat(1_100_000),
    });
  });

  it("maps a blocked egress target to a non-retryable failure (SSRF guard)", async () => {
    __httpDeps.assertEgressAllowed = assertEgressAllowed;

    await expect(
      callGraphQL({ ...CFG, url: "http://169.254.169.254/graphql" }, {}, META),
    ).rejects.toMatchObject({ nonRetryable: true, type: "BLOCKED_EGRESS" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rethrows a transient network error as retryable", async () => {
    fetchMock.mockRejectedValue(new Error("fetch failed"));

    await expect(callGraphQL(CFG, {}, META)).rejects.toMatchObject({
      nonRetryable: false,
      type: "GRAPHQL_TRANSIENT",
    });
  });

  it("a non-JSON response is non-retryable (misconfiguration, not a blip)", async () => {
    fetchMock.mockResolvedValue(res(200, "<html>proxy error</html>"));

    await expect(callGraphQL(CFG, {}, META)).rejects.toMatchObject({
      nonRetryable: true,
      type: "GRAPHQL_BAD_RESPONSE",
    });
  });
});
