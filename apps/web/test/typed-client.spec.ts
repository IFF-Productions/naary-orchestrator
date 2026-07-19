/**
 * Behaviour-parity tests for the openapi-fetch typed client (src/lib/api/client.ts).
 *
 * openapi-fetch returns `{ data, error }` and does NOT throw on non-2xx, so the risk is that
 * migrated methods (runs.ts) stop behaving like the old `http()` (which threw + returned the
 * unwrapped body). These assert the two things that guarantee parity:
 *   1. the auth middleware injects the same bearer/workspace/env headers as http();
 *   2. `unwrap()` reproduces http()'s throws (401 → UnauthorizedError, 403 access_not_allowed →
 *      AccessNotAllowedError, other non-2xx → HttpError) and returns the body on 2xx.
 *
 * The middleware is tested in isolation (not through a live client call) because the client's
 * baseUrl is the relative "/api" — the browser resolves that against the origin, but node's
 * Request constructor rejects a relative URL, so a full fetch round-trip can't run under vitest.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The middleware pulls a fresh bearer token from ../firebase; stub it (no real Firebase in node).
const getBearerToken = vi.fn(async (): Promise<string | null> => "test-token");
vi.mock("../src/lib/firebase", () => ({
  getBearerToken: () => getBearerToken(),
}));

import { authMiddleware, unwrap } from "../src/lib/api/client";
import {
  AccessNotAllowedError,
  HttpError,
  setActiveEnvironment,
  setActiveWorkspace,
  UnauthorizedError,
} from "../src/lib/api/http";

/** Run the auth middleware's onRequest against a fresh Request and return the mutated headers. */
async function runMiddleware(): Promise<Headers> {
  const request = new Request("http://localhost/api/executions");
  // openapi-fetch passes more fields, but onRequest only uses `request`.
  const result = await authMiddleware.onRequest!({ request } as never);
  return (result instanceof Request ? result : request).headers;
}

beforeEach(() => {
  setActiveWorkspace(null);
  setActiveEnvironment(null);
  getBearerToken.mockResolvedValue("test-token");
});
afterEach(() => {
  vi.clearAllMocks();
});

describe("auth middleware header injection (http() parity)", () => {
  it("injects bearer + workspace + environment headers when all are set", async () => {
    setActiveWorkspace("ws-123");
    setActiveEnvironment("env-abc");
    const headers = await runMiddleware();
    expect(headers.get("authorization")).toBe("Bearer test-token");
    expect(headers.get("x-workspace-id")).toBe("ws-123");
    expect(headers.get("x-environment-id")).toBe("env-abc");
  });

  it("omits workspace/environment headers when unset", async () => {
    const headers = await runMiddleware();
    expect(headers.get("authorization")).toBe("Bearer test-token");
    expect(headers.get("x-workspace-id")).toBeNull();
    expect(headers.get("x-environment-id")).toBeNull();
  });

  it("omits the authorization header when there is no token", async () => {
    getBearerToken.mockResolvedValue(null);
    const headers = await runMiddleware();
    expect(headers.get("authorization")).toBeNull();
  });
});

/** Build the `{ data, error, response }` shape openapi-fetch hands back. */
function result<T>(body: T | undefined, status: number) {
  const ok = status >= 200 && status < 300;
  return {
    data: ok ? body : undefined,
    error: ok ? undefined : body,
    response: new Response(
      status === 204 ? null : JSON.stringify(body ?? null),
      {
        status,
      },
    ),
  };
}

describe("unwrap error mapping (http() parity)", () => {
  it("returns the parsed body on 2xx", () => {
    const rows = [{ workflowId: "run-1" }];
    expect(unwrap(result(rows, 200))).toEqual(rows);
  });

  it("returns undefined for a 204 void response (e.g. deleteSchedule)", () => {
    expect(unwrap(result(undefined, 204))).toBeUndefined();
  });

  it("throws UnauthorizedError on 401", () => {
    expect(() => unwrap(result({ message: "nope" }, 401))).toThrow(
      UnauthorizedError,
    );
  });

  it("throws AccessNotAllowedError on a 403 access_not_allowed", () => {
    expect(() =>
      unwrap(result({ code: "access_not_allowed", message: "not yet" }, 403)),
    ).toThrow(AccessNotAllowedError);
  });

  it("throws a plain 403 (no marker) as HttpError with status + serverMessage", () => {
    try {
      unwrap(result({ message: "forbidden" }, 403));
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(HttpError);
      expect((e as HttpError).status).toBe(403);
      expect((e as HttpError).serverMessage).toBe("forbidden");
    }
  });

  it("takes the first message when the server sends a class-validator string[]", () => {
    try {
      unwrap(result({ message: ["first bad field", "second"] }, 400));
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as HttpError).serverMessage).toBe("first bad field");
    }
  });
});
