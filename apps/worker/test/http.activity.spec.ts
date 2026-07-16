import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BlockedEgressError,
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
const secretMock = vi.fn();
let store: MemoryObjectStore;

beforeEach(() => {
  fetchMock.mockReset();
  authMock.mockReset();
  authMock.mockResolvedValue({});
  secretMock.mockReset();
  // Default: no secret configured (tests that need one set their own resolution).
  secretMock.mockResolvedValue(null);
  __httpDeps.fetch = fetchMock as never;
  __httpDeps.resolveAuthHeader = authMock as never;
  __httpDeps.getSecret = secretMock as never;
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

describe("callHttpRequest pagination", () => {
  it("cursor mode: follows the cursor, accumulates items, stops when it's absent", async () => {
    fetchMock
      .mockResolvedValueOnce(res(200, { data: [1, 2], next_cursor: "c1" }))
      .mockResolvedValueOnce(res(200, { data: [3, 4], next_cursor: "c2" }))
      .mockResolvedValueOnce(res(200, { data: [5], next_cursor: null }));

    const result = await callHttpRequest(
      {
        ...CFG,
        pagination: {
          mode: "cursor",
          itemsPath: "data",
          cursorPath: "next_cursor",
          cursorParam: "cursor",
        },
      },
      {},
      META,
    );

    expect(result.body).toEqual([1, 2, 3, 4, 5]);
    expect(result.pages).toBe(3);
    // page 1 carries no cursor; pages 2 & 3 carry the prior response's cursor.
    expect(fetchMock.mock.calls[0][0].toString()).not.toContain("cursor=");
    expect(fetchMock.mock.calls[1][0].toString()).toContain("cursor=c1");
    expect(fetchMock.mock.calls[2][0].toString()).toContain("cursor=c2");
  });

  it("page mode: increments the page param and stops on the first empty page", async () => {
    fetchMock
      .mockResolvedValueOnce(res(200, { rows: [1] }))
      .mockResolvedValueOnce(res(200, { rows: [2] }))
      .mockResolvedValueOnce(res(200, { rows: [] }));

    const result = await callHttpRequest(
      {
        ...CFG,
        pagination: { mode: "page", itemsPath: "rows", pageParam: "page" },
      },
      {},
      META,
    );

    expect(result.body).toEqual([1, 2]);
    expect(result.pages).toBe(3);
    expect(fetchMock.mock.calls[0][0].toString()).toContain("page=1");
    expect(fetchMock.mock.calls[1][0].toString()).toContain("page=2");
    expect(fetchMock.mock.calls[2][0].toString()).toContain("page=3");
  });

  it("url mode: follows an absolute next URL and re-runs egress on every page", async () => {
    const guard = vi.fn(async (u: string) => new URL(u));
    __httpDeps.assertEgressAllowed = guard as never;
    fetchMock
      .mockResolvedValueOnce(
        res(200, {
          items: [1],
          links: { next: "https://api.example.com/v1/things?page=2" },
        }),
      )
      .mockResolvedValueOnce(res(200, { items: [2], links: { next: null } }));

    const result = await callHttpRequest(
      {
        ...CFG,
        pagination: {
          mode: "url",
          itemsPath: "items",
          nextUrlPath: "links.next",
        },
      },
      {},
      META,
    );

    expect(result.body).toEqual([1, 2]);
    expect(result.pages).toBe(2);
    // second request goes to the response-supplied next URL, egress-checked again.
    expect(fetchMock.mock.calls[1][0].toString()).toContain("page=2");
    expect(guard).toHaveBeenCalledTimes(2);
  });

  it("url mode: keeps the auth header on a SAME-origin next page", async () => {
    authMock.mockResolvedValue({ Authorization: "Bearer tok" });
    fetchMock
      .mockResolvedValueOnce(
        res(200, {
          items: [1],
          links: { next: "https://api.example.com/v1/things?page=2" },
        }),
      )
      .mockResolvedValueOnce(res(200, { items: [2], links: { next: null } }));

    await callHttpRequest(
      {
        ...CFG,
        connectionId: "conn-1",
        pagination: {
          mode: "url",
          itemsPath: "items",
          nextUrlPath: "links.next",
        },
      },
      {},
      META,
    );

    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer tok");
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe("Bearer tok");
  });

  it("url mode: STRIPS the auth header on a CROSS-origin next page (no token leak)", async () => {
    authMock.mockResolvedValue({ Authorization: "Bearer tok" });
    fetchMock
      .mockResolvedValueOnce(
        res(200, {
          items: [1],
          links: { next: "https://evil.example.net/steal" },
        }),
      )
      .mockResolvedValueOnce(res(200, { items: [2], links: { next: null } }));

    await callHttpRequest(
      {
        ...CFG,
        connectionId: "conn-1",
        pagination: {
          mode: "url",
          itemsPath: "items",
          nextUrlPath: "links.next",
        },
      },
      {},
      META,
    );

    // Page 1 (same host) carries the token; page 2 (evil.example.net) must NOT.
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer tok");
    expect(fetchMock.mock.calls[1][0].toString()).toContain("evil.example.net");
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBeUndefined();
  });

  it("fails the whole paginated flow on a bad status when failOnErrorStatus", async () => {
    fetchMock
      .mockResolvedValueOnce(res(200, { data: [1], next_cursor: "c1" }))
      .mockResolvedValueOnce(res(500, "boom", "text/plain"));

    await expect(
      callHttpRequest(
        {
          ...CFG,
          failOnErrorStatus: true,
          pagination: {
            mode: "cursor",
            itemsPath: "data",
            cursorPath: "next_cursor",
          },
        },
        {},
        META,
      ),
    ).rejects.toMatchObject({ nonRetryable: true, type: "HTTP_ERROR_STATUS" });
  });

  it("url mode: a next URL to a blocked host is rejected by the egress guard", async () => {
    // Guard allows the first host but blocks the metadata IP — proving EVERY page URL
    // (including a response-supplied `next`) is re-checked, hermetically (no DNS).
    __httpDeps.assertEgressAllowed = (async (u: string) => {
      const url = new URL(u);
      if (url.hostname === "169.254.169.254")
        throw new BlockedEgressError(`link-local ${url.hostname}`);
      return url;
    }) as never;
    fetchMock.mockResolvedValueOnce(
      res(200, { items: [1], links: { next: "http://169.254.169.254/" } }),
    );

    await expect(
      callHttpRequest(
        {
          ...CFG,
          pagination: {
            mode: "url",
            itemsPath: "items",
            nextUrlPath: "links.next",
            stopOnEmpty: false,
          },
        },
        {},
        META,
      ),
    ).rejects.toMatchObject({ nonRetryable: true, type: "BLOCKED_EGRESS" });
  });

  it("caps at maxPages when the stream never ends, and meters cost per page", async () => {
    fetchMock.mockResolvedValue(res(200, { data: [1], next_cursor: "more" }));

    const result = await callHttpRequest(
      {
        ...CFG,
        costUsd: 0.01,
        pagination: {
          mode: "cursor",
          itemsPath: "data",
          cursorPath: "next_cursor",
          maxPages: 3,
        },
      },
      {},
      META,
    );

    expect(result.pages).toBe(3);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.costUsd).toBeCloseTo(0.03);
    expect(result.body).toEqual([1, 1, 1]);
  });

  it("treats the whole body as the items array when itemsPath is omitted", async () => {
    fetchMock
      .mockResolvedValueOnce(res(200, [1, 2]))
      .mockResolvedValueOnce(res(200, []));

    const result = await callHttpRequest(
      { ...CFG, pagination: { mode: "page", pageParam: "page" } },
      {},
      META,
    );

    expect(result.body).toEqual([1, 2]);
    expect(result.pages).toBe(2);
  });
});

describe("callHttpRequest — $secrets (in-activity resolution, Tier-1 §4)", () => {
  const SECRET = "ghp_supersecrettoken";

  it("resolves {{ $secrets.NAME }} into the outgoing header, and the value appears NOWHERE in the result", async () => {
    secretMock.mockResolvedValue(SECRET);
    fetchMock.mockResolvedValue(res(200, { ok: true }));

    const result = await callHttpRequest(
      {
        ...CFG,
        headers: { Authorization: "Bearer {{ $secrets.GH_TOKEN }}" },
      },
      {},
      { ...META, environmentId: "env-prod" },
    );

    // The secret was fetched by NAME for the run's env, and injected into the SENT request header…
    expect(secretMock).toHaveBeenCalledWith("t1", "env-prod", "GH_TOKEN");
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe(
      `Bearer ${SECRET}`,
    );
    // …but the plaintext must not leak into the returned result (which rides Temporal history).
    expect(JSON.stringify(result)).not.toContain(SECRET);
    // The literal token must also NOT survive into the result (belt-and-suspenders).
    expect(JSON.stringify(result)).not.toContain("$secrets");
  });

  it("STRIPS a $secrets header on a CROSS-origin next page (no secret leak to attacker host)", async () => {
    secretMock.mockResolvedValue(SECRET);
    fetchMock
      .mockResolvedValueOnce(
        res(200, { items: [1], links: { next: "https://evil.example.net/x" } }),
      )
      .mockResolvedValueOnce(res(200, { items: [2], links: { next: null } }));

    await callHttpRequest(
      {
        ...CFG,
        headers: { "X-Api-Key": "{{ $secrets.API_KEY }}" },
        pagination: {
          mode: "url",
          itemsPath: "items",
          nextUrlPath: "links.next",
          maxPages: 2,
        },
      },
      {},
      { ...META, environmentId: "env-prod" },
    );

    // page 1 (same origin) carries the resolved secret; page 2 (cross origin) must NOT.
    expect(fetchMock.mock.calls[0][1].headers["X-Api-Key"]).toBe(SECRET);
    expect(fetchMock.mock.calls[1][0].toString()).toContain("evil.example.net");
    expect(fetchMock.mock.calls[1][1].headers["X-Api-Key"]).toBeUndefined();
  });

  it("a missing secret is a NON-RETRYABLE failure naming the NAME, not a value", async () => {
    secretMock.mockResolvedValue(null); // not configured
    fetchMock.mockResolvedValue(res(200, { ok: true }));

    await expect(
      callHttpRequest(
        { ...CFG, headers: { Authorization: "Bearer {{ $secrets.NOPE }}" } },
        {},
        { ...META, environmentId: "env-prod" },
      ),
    ).rejects.toMatchObject({
      nonRetryable: true,
      message: expect.stringContaining("NOPE"),
    });
    // The network call never happens when a referenced secret is missing.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("resolves a $secrets token nested in the JSON BODY, and the value appears NOWHERE in the result", async () => {
    secretMock.mockResolvedValue(SECRET);
    fetchMock.mockResolvedValue(res(200, { ok: true }));

    const result = await callHttpRequest(
      {
        method: "POST",
        url: "https://api.example.com/v1/things",
        body: { auth: { token: "{{ $secrets.API_KEY }}" }, keep: "plain" },
      },
      {},
      { ...META, environmentId: "env-prod" },
    );

    expect(secretMock).toHaveBeenCalledWith("t1", "env-prod", "API_KEY");
    // The secret is inlined into the SENT body…
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      auth: { token: SECRET },
      keep: "plain",
    });
    // …but never rides back in the result (which enters Temporal history).
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(JSON.stringify(result)).not.toContain("$secrets");
  });

  it("DROPS a secret-bearing body on a CROSS-origin next page (no body leak off-host)", async () => {
    secretMock.mockResolvedValue(SECRET);
    fetchMock
      .mockResolvedValueOnce(
        res(200, { items: [1], links: { next: "https://evil.example.net/x" } }),
      )
      .mockResolvedValueOnce(res(200, { items: [2], links: { next: null } }));

    await callHttpRequest(
      {
        method: "POST",
        url: "https://api.example.com/v1/things",
        body: { token: "{{ $secrets.API_KEY }}" },
        pagination: {
          mode: "url",
          itemsPath: "items",
          nextUrlPath: "links.next",
          maxPages: 2,
        },
      },
      {},
      { ...META, environmentId: "env-prod" },
    );

    // page 1 (same origin) carries the resolved secret body…
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      token: SECRET,
    });
    // …page 2 (cross origin) sends NO body — the secret never reaches the attacker host.
    expect(fetchMock.mock.calls[1][0].toString()).toContain("evil.example.net");
    expect(fetchMock.mock.calls[1][1].body ?? null).toBeNull();
  });
});
