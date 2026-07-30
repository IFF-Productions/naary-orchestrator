/**
 * What `POST /builder/sessions` actually receives.
 *
 * The seeding path (`workflowKey` ⇒ the server copies that workflow's latest saved graph into the
 * session's working draft) existed from Slice 1 and was never reachable, because the screen called
 * `openBuilderSession()` with no arguments. A pure-logic test of "which args should we pass" can
 * pass while the wire body stays empty, so this asserts the BODY — the same guarantee #874 put on
 * `previous` for the generate routes.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

// generateGraphStream's precedent: http() only needs a bearer token from this module.
vi.mock("../src/lib/firebase-lazy", () => ({
  getBearerToken: async () => "test-token",
}));

import { builderApi } from "../src/lib/api/builder";

function jsonOk(body: unknown) {
  return {
    status: 200,
    ok: true,
    headers: { get: () => "application/json" },
    json: async () => body,
  } as unknown as Response;
}

/** The body of the single fetch() call, parsed. */
function sentBody(fetchMock: ReturnType<typeof vi.fn>): unknown {
  const init = fetchMock.mock.calls[0][1] as RequestInit;
  return JSON.parse(String(init.body));
}

afterEach(() => vi.restoreAllMocks());

describe("builderApi.openBuilderSession", () => {
  it("puts the workflowKey in the body, so the server seeds the draft from that workflow", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonOk({ id: "bs-1" }));
    vi.stubGlobal("fetch", fetchMock);

    await builderApi.openBuilderSession({
      workflowKey: "nightly-report",
      title: "Nightly report",
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/builder/sessions");
    expect(init.method).toBe("POST");
    expect(sentBody(fetchMock)).toEqual({
      workflowKey: "nightly-report",
      title: "Nightly report",
    });
  });

  it("sends an EMPTY body with no argument — a from-scratch build is byte-identical to before", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonOk({ id: "bs-2" }));
    vi.stubGlobal("fetch", fetchMock);

    await builderApi.openBuilderSession();

    expect(sentBody(fetchMock)).toEqual({});
  });

  it("also sends an empty body for an explicit undefined (what openArgsFor(null) returns)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonOk({ id: "bs-3" }));
    vi.stubGlobal("fetch", fetchMock);

    await builderApi.openBuilderSession(undefined);

    expect(sentBody(fetchMock)).toEqual({});
  });
});
