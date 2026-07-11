import { describe, expect, it } from "vitest";
import { redactSecrets } from "../src/lib/sentry-scrub";

describe("redactSecrets (browser Sentry scrubber)", () => {
  it("redacts token-shaped strings (Bearer / nry_ / sk- / gh*_)", () => {
    expect(redactSecrets("Bearer abc.def-123")).toBe("[redacted]");
    expect(redactSecrets("token is nry_AbC123xyz here")).toBe(
      "token is [redacted] here",
    );
    expect(redactSecrets("sk-proj-ABC123")).toBe("[redacted]");
    expect(redactSecrets("ghp_0123456789abcdef")).toBe("[redacted]");
  });

  it("drops the VALUE of any secret-named field (whole-field redaction)", () => {
    expect(
      redactSecrets({
        authorization: "Bearer secret-value",
        token: "anything",
        apiKey: "k",
        api_key: "k",
        password: "hunter2",
        cookie: "session=…",
        safe: "keep me",
      }),
    ).toEqual({
      authorization: "[redacted]",
      token: "[redacted]",
      apiKey: "[redacted]",
      api_key: "[redacted]",
      password: "[redacted]",
      cookie: "[redacted]",
      safe: "keep me",
    });
  });

  it("redacts secrets embedded in URL query strings (the field-name pass misses these)", () => {
    expect(redactSecrets("https://api/x?token=deadbeef&page=2")).toBe(
      "https://api/x?token=[redacted]&page=2",
    );
    expect(redactSecrets("https://h/cb?access_token=abc123&state=ok")).toBe(
      "https://h/cb?access_token=[redacted]&state=ok",
    );
    // non-secret params are untouched
    expect(redactSecrets("https://api/x?page=2&sort=asc")).toBe(
      "https://api/x?page=2&sort=asc",
    );
  });

  it("recurses through a Sentry-shaped event: request headers/query, breadcrumbs, contexts, extra", () => {
    const event = {
      request: {
        url: "https://app/cb?token=leak",
        headers: {
          Authorization: "Bearer xyz",
          "content-type": "application/json",
        },
        query_string: "api_key=leak&q=hi",
      },
      breadcrumbs: [
        { category: "fetch", data: { token: "nry_leak", url: "/ok" } },
        { message: "used Bearer aaa.bbb" },
      ],
      contexts: { auth: { secret: "s" } },
      extra: { note: "sk-live-XYZ inside" },
      message: "plain, no secrets",
    };
    expect(redactSecrets(event)).toEqual({
      request: {
        url: "https://app/cb?token=[redacted]",
        headers: {
          Authorization: "[redacted]",
          "content-type": "application/json",
        },
        query_string: "api_key=[redacted]&q=hi",
      },
      breadcrumbs: [
        { category: "fetch", data: { token: "[redacted]", url: "/ok" } },
        { message: "used [redacted]" },
      ],
      contexts: { auth: { secret: "[redacted]" } },
      extra: { note: "[redacted] inside" },
      message: "plain, no secrets",
    });
  });

  it("does not mutate the input and passes primitives through", () => {
    const input = { n: 1, b: true, z: null, arr: ["Bearer keep-orig"] };
    const out = redactSecrets(input) as typeof input;
    expect(input.arr[0]).toBe("Bearer keep-orig"); // original untouched
    expect(out.arr[0]).toBe("[redacted]");
    expect(out.n).toBe(1);
    expect(out.b).toBe(true);
    expect(out.z).toBe(null);
  });
});
