import { describe, expect, it } from "vitest";
import {
  captureBody,
  captureHttpFailure,
  MAX_BODY_BYTES,
  redactHeaders,
} from "../src/temporal/activities/http-failure-capture";

/**
 * These are security tests, not formatting tests. The capture puts a third party's response and
 * OUR request into Temporal history, where anyone with run access can read them — so the property
 * that matters is the negative one: a credential must never come out the other side, whatever
 * shape it went in as.
 *
 * The header cases are written against an ALLOWLIST: a test that only checks "Authorization is
 * gone" would still pass under a denylist that misses `X-Auth-Token`, so several cases assert that
 * an UNKNOWN header loses its value by default.
 */

/** Every spelling of the one header that must never survive. */
const AUTH_CASINGS = [
  "Authorization",
  "authorization",
  "AUTHORIZATION",
  "AuThOrIzAtIoN",
];

describe("redactHeaders — allowlist, not denylist", () => {
  it.each(AUTH_CASINGS)("never stores an Authorization value (%s)", (name) => {
    const out = redactHeaders({ [name]: "Bearer sk-ant-supersecrettoken123" });
    expect(out.authorization).toBe("[REDACTED]");
    expect(JSON.stringify(out)).not.toContain("supersecrettoken");
    expect(JSON.stringify(out)).not.toContain("Bearer");
  });

  it.each([
    ["From", "oncall@acme.com"], // PII, and the header PagerDuty writes need
    ["Cookie", "session=abc123deadbeef"],
    ["Set-Cookie", "sid=abc123deadbeef; HttpOnly"],
    ["Proxy-Authorization", "Basic dXNlcjpwYXNz"],
    ["X-Api-Key", "abc123deadbeef"],
    ["X-Auth-Token", "abc123deadbeef"], // NOT on any denylist we wrote — the allowlist covers it
    ["Private-Token", "glpat-abc123deadbeef"],
    ["Www-Authenticate", 'Bearer realm="x", error="invalid_token"'],
    ["Location", "https://app/cb?code=abc123deadbeef"], // an OAuth code is a credential
    ["X-Totally-New-Header", "abc123deadbeef"],
  ])("keeps the NAME but drops the value of %s", (name, value) => {
    const out = redactHeaders({ [name]: value });
    expect(Object.keys(out)).toEqual([name.toLowerCase()]);
    expect(out[name.toLowerCase()]).toBe("[REDACTED]");
    expect(JSON.stringify(out)).not.toContain("deadbeef");
  });

  it("keeps the values that are provably not credentials", () => {
    expect(
      redactHeaders({
        "Content-Type": "application/json",
        Accept: "application/vnd.github+json",
        "Retry-After": "60",
        "X-RateLimit-Remaining": "0",
        "x-ratelimit-reset": "1753700000",
        "X-Request-Id": "req_abc",
      }),
    ).toEqual({
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "retry-after": "60",
      "x-ratelimit-remaining": "0",
      "x-ratelimit-reset": "1753700000",
      "x-request-id": "req_abc",
    });
  });

  it("still shape-scrubs an ALLOWLISTED value — the allowlist is a human judgement", () => {
    const out = redactHeaders({
      "Content-Type": "text/x; k=ghp_0123456789abcdefghij",
    });
    expect(out["content-type"]).not.toContain("ghp_0123456789abcdefghij");
  });

  it("reads a Headers-like object (what fetch hands back), not just a record", () => {
    const headers = {
      entries: () =>
        [
          ["content-type", "application/json"],
          ["authorization", "Bearer nope"],
        ] as [string, string][],
    };
    expect(redactHeaders(headers)).toEqual({
      "content-type": "application/json",
      authorization: "[REDACTED]",
    });
  });

  it("is total — undefined, null and a hostile Headers-like all yield {}", () => {
    expect(redactHeaders(undefined)).toEqual({});
    expect(redactHeaders(null)).toEqual({});
    expect(
      redactHeaders({
        entries: () => {
          throw new Error("boom");
        },
      }),
    ).toEqual({});
  });

  it("does not mutate the caller's headers — they are still on the live request", () => {
    const live = {
      Authorization: "Bearer keepme",
      "Content-Type": "text/plain",
    };
    redactHeaders(live);
    expect(live.Authorization).toBe("Bearer keepme");
  });

  it("caps how many headers it stores", () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < 200; i++) many[`x-h-${i}`] = "v";
    expect(Object.keys(redactHeaders(many)).length).toBeLessThanOrEqual(40);
  });
});

describe("captureBody — an Authorization value never survives", () => {
  it.each(AUTH_CASINGS)("drops a NESTED %s inside a JSON body", (name) => {
    const body = JSON.stringify({
      request: { retry: { headers: { [name]: "Bearer supersecrettoken123" } } },
      note: "echoed back by the provider",
    });
    const out = captureBody(body);
    expect(out?.text).not.toContain("supersecrettoken123");
    expect(out?.text).toContain("REDACTED");
    // The surrounding, non-secret content is still there — this is a diagnostic tool.
    expect(out?.text).toContain("echoed back by the provider");
  });

  it("drops an Authorization echoed in a NON-JSON body (an HTML error page)", () => {
    const out = captureBody(
      "<html><body>Request rejected.\nAuthorization: Bearer AbCdEf123456789\n</body></html>",
    );
    expect(out?.text).not.toContain("AbCdEf123456789");
  });

  it("kills the WHOLE credential value, not just up to the first space", () => {
    // redactString's generic key=value rule stops at whitespace, so `Bearer <token>` used to
    // survive from the space onward. This is the case that regression exists for.
    const out = captureBody(
      "authorization=Bearer zzzz-not-a-known-token-shape",
    );
    expect(out?.text).not.toContain("zzzz-not-a-known-token-shape");
  });

  it("drops other credential-ish keys at depth (token / password / api_key)", () => {
    const out = captureBody(
      JSON.stringify({ a: { b: { token: "t0ps3cret", password: "hunter2" } } }),
    );
    expect(out?.text).not.toContain("t0ps3cret");
    expect(out?.text).not.toContain("hunter2");
  });

  it("redacts secret SHAPES no key name would have flagged", () => {
    const out = captureBody(
      JSON.stringify({ note: "leaked ghp_0123456789abcdefghij in the log" }),
    );
    expect(out?.text).not.toContain("ghp_0123456789abcdefghij");
  });

  it("keeps a plain provider error intact — the whole point of capturing it", () => {
    const out = captureBody(
      JSON.stringify({ message: "Validation Failed", field: "title" }),
    );
    expect(out).toEqual({
      text: '{"message":"Validation Failed","field":"title"}',
      truncated: false,
      bytes: 47,
    });
  });

  it("truncates with an in-band marker and reports the ORIGINAL size", () => {
    const raw = "x".repeat(5000);
    const out = captureBody(raw);
    expect(out?.truncated).toBe(true);
    expect(out?.bytes).toBe(5000);
    expect(out?.text).toContain("truncated to 2048 chars");
    expect(out?.text).toContain("the original body was 5000 bytes");
    // Marker aside, we stored the cap and not a byte more.
    expect(out?.text.split("\n…[")[0].length).toBe(MAX_BODY_BYTES);
  });

  it("does not mutate a parsed body handed in as an object", () => {
    const live = { headers: { Authorization: "Bearer keepme" } };
    const out = captureBody(live);
    expect(out?.text).not.toContain("keepme");
    expect(live.headers.Authorization).toBe("Bearer keepme");
  });

  it("is total — empty, null and unserializable inputs yield undefined or a string", () => {
    expect(captureBody(undefined)).toBeUndefined();
    expect(captureBody(null)).toBeUndefined();
    expect(captureBody("")).toBeUndefined();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => captureBody(cyclic)).not.toThrow();
  });
});

describe("captureHttpFailure", () => {
  const base = {
    method: "post",
    url: "https://api.github.com/repos/acme/app/issues",
    requestHeaders: {
      Authorization: "Bearer ghp_0123456789abcdefghij",
      "Content-Type": "application/json",
    },
    requestBody: JSON.stringify({ title: "It broke" }),
  };

  it("captures the full call with the credential removed", () => {
    const out = captureHttpFailure({
      ...base,
      status: 404,
      statusText: "Not Found",
      responseHeaders: {
        "content-type": "application/json",
        "x-ratelimit-remaining": "4999",
        "set-cookie": "sid=abc",
      },
      responseBody: JSON.stringify({ message: "Not Found" }),
    });

    expect(out.request.method).toBe("POST");
    expect(out.request.url).toBe(base.url);
    expect(out.request.headers).toEqual({
      authorization: "[REDACTED]",
      "content-type": "application/json",
    });
    expect(out.request.body?.text).toBe('{"title":"It broke"}');
    expect(out.response).toMatchObject({
      status: 404,
      statusText: "Not Found",
    });
    expect(out.response?.headers).toEqual({
      "content-type": "application/json",
      "x-ratelimit-remaining": "4999",
      "set-cookie": "[REDACTED]",
    });
    expect(out.response?.body?.text).toBe('{"message":"Not Found"}');
    expect(JSON.stringify(out)).not.toContain("ghp_0123456789abcdefghij");
  });

  it("redacts a credential carried in the URL's query string", () => {
    const out = captureHttpFailure({
      ...base,
      url: "https://api.acme.com/v1/things?api_key=sk-abcdefghijkl&page=2",
      status: 401,
    });
    // redactString kills to the end of the query value, taking `&page=2` with it — over-
    // redacting a URL is free, under-redacting one is not.
    expect(out.request.url).not.toContain("sk-abcdefghijkl");
    expect(out.request.url).toBe(
      "https://api.acme.com/v1/things?api_key=[REDACTED]",
    );
  });

  it("omits `response` entirely when no response arrived (DNS / timeout)", () => {
    const out = captureHttpFailure(base);
    // A status 0 would read as a real HTTP status to whoever sees it.
    expect(out.response).toBeUndefined();
  });

  it("withholds the request body — and says so — when a $secret was resolved into it", () => {
    const out = captureHttpFailure({
      ...base,
      requestBody: JSON.stringify({ apiToken: "the-real-secret-value" }),
      requestBodyWithheld:
        "withheld — this request body carried a resolved $secret",
      status: 400,
    });
    expect(out.request.body).toBeUndefined();
    expect(out.request.bodyWithheld).toContain("resolved $secret");
    expect(JSON.stringify(out)).not.toContain("the-real-secret-value");
  });

  it("stays small AND fast on a huge body — a failure path must not hang", () => {
    // Regression: the scrubber's URL pattern backtracks quadratically, so scrubbing BEFORE
    // truncating wedged this call for over a minute on a 500KB body. Truncate first.
    const startedAt = Date.now();
    const out = captureHttpFailure({
      ...base,
      requestBody: "a".repeat(500_000),
      status: 500,
      responseHeaders: Object.fromEntries(
        Array.from({ length: 500 }, (_, i) => [`x-h-${i}`, "v".repeat(500)]),
      ),
      responseBody: "b".repeat(500_000),
    });
    expect(JSON.stringify(out).length).toBeLessThan(32_000);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });
});
