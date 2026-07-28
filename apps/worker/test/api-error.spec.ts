import { describe, expect, it } from "vitest";
import {
  describeApiError,
  hasFromHeader,
} from "../src/temporal/activities/api-error";

/**
 * The case this module was written for: acknowledging a PagerDuty incident failed with
 * `400 Bad Request` — the HTTP reason phrase — while PagerDuty's body said exactly which
 * header was missing. The old extractor read a TOP-LEVEL `message` only, so every provider
 * that nests its error had the one useful sentence discarded.
 */
describe("describeApiError", () => {
  it("reads PagerDuty's nested error.message — the reported failure", () => {
    expect(
      describeApiError(
        { error: { message: "Caller must supply a From header", code: 2001 } },
        "Bad Request",
      ),
    ).toBe("Caller must supply a From header");
  });

  it("appends error.errors[] — often the half that names the field", () => {
    // PagerDuty's `error.message` is regularly the generic one; the array carries the specifics.
    expect(
      describeApiError(
        {
          error: {
            message: "Invalid Input Provided",
            errors: ["Requester User Not Found"],
          },
        },
        "Bad Request",
      ),
    ).toBe("Invalid Input Provided — Requester User Not Found");
  });

  it("still reads a top-level message (GitHub, Slack) — the old behaviour is intact", () => {
    expect(describeApiError({ message: "Not Found" }, "Not Found")).toBe(
      "Not Found",
    );
  });

  it.each([
    [{ error: "invalid_grant" }, "invalid_grant"],
    [
      { error_description: "The refresh token is expired" },
      "The refresh token is expired",
    ],
    [{ detail: "field required" }, "field required"],
    [
      { errors: [{ message: "Field 'x' doesn't exist" }] },
      "Field 'x' doesn't exist",
    ],
    [{ errorMessages: ["Issue does not exist"] }, "Issue does not exist"],
  ])("handles %o", (body, expected) => {
    expect(describeApiError(body, "Bad Request")).toBe(expected);
  });

  it("joins several messages rather than picking one arbitrarily", () => {
    expect(
      describeApiError({ errors: [{ message: "a" }, { message: "b" }] }, "x"),
    ).toBe("a; b");
  });

  it("hands back a non-JSON body (an HTML error page, plain text)", () => {
    expect(describeApiError("upstream timeout", "Gateway Timeout")).toBe(
      "upstream timeout",
    );
  });

  it("truncates — a vendor can return a whole HTML document", () => {
    expect(describeApiError("x".repeat(500), "Bad Request")).toHaveLength(300);
  });

  it("falls back to the reason phrase only when the body genuinely says nothing", () => {
    for (const body of [
      null,
      undefined,
      {},
      [],
      42,
      { error: {} },
      { message: "  " },
    ]) {
      expect(describeApiError(body, "Bad Request")).toBe("Bad Request");
    }
  });

  it("never throws, whatever the body is — a failure path must not fail", () => {
    const nasty = {
      error: { message: 5, errors: [null, 7, {}] },
      errors: "no",
    };
    expect(() => describeApiError(nasty, "Bad Request")).not.toThrow();
    expect(describeApiError(nasty, "Bad Request")).toBe("Bad Request");
  });
});

describe("hasFromHeader", () => {
  it("is case-insensitive and ignores a blank value", () => {
    expect(hasFromHeader({ From: "me@example.com" })).toBe(true);
    expect(hasFromHeader({ from: "me@example.com" })).toBe(true);
    expect(hasFromHeader({ From: "   " })).toBe(false);
    expect(hasFromHeader({ Authorization: "Token token=x" })).toBe(false);
    expect(hasFromHeader(undefined)).toBe(false);
  });
});
