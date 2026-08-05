import { describe, expect, it } from "vitest";
import {
  DEFAULT_SCIM_PAGE,
  MAX_SCIM_PAGE,
  parsePaging,
  parseScimFilter,
} from "../src/scim/scim-filter";
import { ScimError } from "../src/scim/scim.errors";

describe("parseScimFilter", () => {
  it("accepts the one production we implement", () => {
    expect(parseScimFilter('userName eq "a@b.example"')).toEqual({
      userName: "a@b.example",
    });
  });

  it("lowercases the value so it matches the canonical email key", () => {
    expect(parseScimFilter('userName eq "Alice@B.Example"')).toEqual({
      userName: "alice@b.example",
    });
  });

  it("is case-insensitive on the attribute and tolerant of whitespace (RFC 7644 §3.4.2.2)", () => {
    expect(parseScimFilter('  USERNAME   eq   "a@b.example"  ')).toEqual({
      userName: "a@b.example",
    });
  });

  it("treats absent/empty as no filter, not as an error", () => {
    expect(parseScimFilter(undefined)).toBeNull();
    expect(parseScimFilter("   ")).toBeNull();
  });

  /** The security-relevant half: an unsupported filter must FAIL, never silently widen to
   *  "return everything" — that would be a filter bypass dressed up as leniency. */
  it.each([
    'userName co "b.example"',
    'userName ne "a@b.example"',
    'emails.value eq "a@b.example"',
    'userName eq "a@b.example" or userName eq "c@d.example"',
    "active eq true",
    "userName pr",
    "userName eq a@b.example", // unquoted
  ])("rejects %s with a SCIM invalidFilter rather than ignoring it", (f) => {
    expect(() => parseScimFilter(f)).toThrow(ScimError);
    try {
      parseScimFilter(f);
    } catch (e) {
      const body = (e as ScimError).getResponse() as Record<string, unknown>;
      expect(body.scimType).toBe("invalidFilter");
      expect((e as ScimError).getStatus()).toBe(400);
    }
  });

  it("bounds the value length and returns promptly on a long adversarial input (no catastrophic backtracking)", () => {
    const started = Date.now();
    expect(() =>
      parseScimFilter(`userName eq "${"a".repeat(50_000)}"`),
    ).toThrow(ScimError);
    expect(() =>
      parseScimFilter(`${" ".repeat(50_000)}userName eq "a@b.example`),
    ).toThrow(ScimError);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe("parsePaging", () => {
  it("defaults to the whole first page, 1-based", () => {
    expect(parsePaging(undefined, undefined)).toEqual({
      start: 1,
      count: DEFAULT_SCIM_PAGE,
    });
  });

  it("clamps count to MAX_SCIM_PAGE so one request cannot ask for the whole directory", () => {
    expect(parsePaging(1, 10_000).count).toBe(MAX_SCIM_PAGE);
  });

  it("clamps a garbage or out-of-range startIndex to 1 rather than erroring (RFC 7644 §3.4.2.4)", () => {
    expect(parsePaging("0", 10).start).toBe(1);
    expect(parsePaging("-5", 10).start).toBe(1);
    expect(parsePaging("abc", 10).start).toBe(1);
  });

  it("honours count=0 — a legal way to ask only for totalResults", () => {
    expect(parsePaging(1, 0).count).toBe(0);
  });
});
