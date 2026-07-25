/**
 * #457 — the SPA's half of instance-wide MFA enforcement.
 *
 * The server answers a single-factor session with 403 + `code: "mfa_required"`. Both API paths
 * (`http()` and the typed client's `unwrap()`) must turn that ONE code into `MfaRequiredError`, and
 * only that code — an ordinary 403 (membership/tenant) has to stay a generic HttpError, or every
 * permission error would send users to an enrolment screen. RequireAuth renders <MfaRequired/> off
 * the resulting WorkspaceProvider state.
 *
 * No live Firebase MFA enrolment exists here (or anywhere in CI) — the enforcement decision is the
 * server's, and it's unit-tested at the verifier/guard seam in apps/api/test. This file only pins
 * the client-side mapping.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// http()/the middleware pull a fresh bearer token from ../firebase; stub it (no real Firebase).
vi.mock("../src/lib/firebase", () => ({
  getBearerToken: async () => "test-token",
}));

import { unwrap } from "../src/lib/api/client";
import {
  AccessNotAllowedError,
  HttpError,
  MfaRequiredError,
  http,
} from "../src/lib/api/http";

/** An openapi-fetch-shaped result, as unwrap() consumes it. */
function result(body: unknown, status: number) {
  return {
    error: body,
    response: new Response(null, { status }) as Response & { url: string },
  } as never;
}

/** Stub global fetch with one JSON response. */
function stubFetch(body: unknown, status: number) {
  globalThis.fetch = vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  ) as unknown as typeof fetch;
}

const realFetch = globalThis.fetch;
beforeEach(() => {
  globalThis.fetch = realFetch;
});

describe("unwrap() — MFA marker (#457)", () => {
  it("throws MfaRequiredError on a 403 mfa_required", () => {
    expect(() =>
      unwrap(result({ code: "mfa_required", message: "enrol first" }, 403)),
    ).toThrow(MfaRequiredError);
  });

  it("carries the server's wording", () => {
    try {
      unwrap(result({ code: "mfa_required", message: "enrol first" }, 403));
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as Error).message).toBe("enrol first");
    }
  });

  it("leaves a plain 403 as a generic HttpError (no false enrolment screen)", () => {
    expect(() =>
      unwrap(result({ message: "Not a workspace member" }, 403)),
    ).toThrow(HttpError);
  });

  it("does not confuse the access-allowlist marker with the MFA one", () => {
    expect(() => unwrap(result({ code: "access_not_allowed" }, 403))).toThrow(
      AccessNotAllowedError,
    );
  });
});

describe("http() — MFA marker (#457)", () => {
  it("throws MfaRequiredError on a 403 mfa_required", async () => {
    stubFetch({ code: "mfa_required", message: "enrol first" }, 403);
    await expect(http("/me/workspaces")).rejects.toBeInstanceOf(
      MfaRequiredError,
    );
  });

  it("still throws a generic HttpError for an unmarked 403", async () => {
    stubFetch({ message: "Not a workspace member" }, 403);
    await expect(http("/me/workspaces")).rejects.toBeInstanceOf(HttpError);
  });

  it("is inert on a success response (default-off changes nothing)", async () => {
    stubFetch([{ tenantId: "t-1" }], 200);
    await expect(http("/me/workspaces")).resolves.toEqual([
      { tenantId: "t-1" },
    ]);
  });
});
