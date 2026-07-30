// The self-healing dedupe key.
//
// This decides how often a tenant is billed for a proposal. A workflow failing on a 5-minute
// schedule produces 288 failed runs a day; the signature is the only thing between that and 288
// model calls. It is equally the only thing stopping two genuinely different failures from
// collapsing into one, where the second would never be proposed and never explained.
//
// So the tests come in pairs: what must MERGE, and what must stay APART.
import { describe, expect, it } from "vitest";
import {
  healFailureSignature,
  normalizeFailureMessage,
} from "../src/temporal/workflow/heal-signature";

const sig = (
  message: string,
  failedNodeId = "pagerduty",
  failureKind = "error",
) => healFailureSignature({ failedNodeId, failureKind, message });

describe("healFailureSignature — the same failure recurring", () => {
  it("merges runs that differ only by a run id", () => {
    expect(sig("run 3f2a1b4c-1111-2222-3333-444455556666 failed")).toBe(
      sig("run 99999999-aaaa-bbbb-cccc-dddddddddddd failed"),
    );
  });

  it("merges runs that differ only by a timestamp", () => {
    expect(sig("expired at 2026-07-30T14:33:02.511Z")).toBe(
      sig("expired at 2026-07-31T09:01:44.002Z"),
    );
  });

  it("merges retry attempts", () => {
    // "attempt 1 of 3" would otherwise mint a fresh signature for every attempt.
    expect(sig("attempt 1 of 3 failed")).toBe(sig("attempt 3 of 3 failed"));
  });

  it("merges a long request id", () => {
    expect(sig("x-request-id 9f8e7d6c5b4a3f2e1d0c")).toBe(
      sig("x-request-id 0123456789abcdef0123"),
    );
  });

  it("ignores case and whitespace differences", () => {
    expect(sig("Missing   required header")).toBe(
      sig("missing required header"),
    );
  });
});

describe("healFailureSignature — genuinely different failures", () => {
  it("keeps two different missing headers apart", () => {
    // The case that would be lost by normalizing quoted strings — these are different problems
    // with different fixes.
    expect(sig("Missing required header 'From'")).not.toBe(
      sig("Missing required header 'Authorization'"),
    );
  });

  it("keeps different NODES apart even with an identical message", () => {
    expect(sig("boom", "pagerduty")).not.toBe(sig("boom", "github"));
  });

  it("keeps different failure KINDS apart", () => {
    expect(sig("boom", "pagerduty", "timeout")).not.toBe(
      sig("boom", "pagerduty", "rate_limit"),
    );
  });

  it("cannot collide across the field separator", () => {
    // This FAILED when first written. Relying on "a node id may only contain [\w$-]" meant
    // {"a|b","c"} and {"a","b|c"} both produced `a|b|c|` — two unrelated failures merged into one
    // signature, so the second would never be proposed and never explained. The parts are escaped
    // now, which removes the assumption instead of restating it.
    expect(
      healFailureSignature({
        failedNodeId: "a|b",
        failureKind: "c",
        message: "",
      }),
    ).not.toBe(
      healFailureSignature({
        failedNodeId: "a",
        failureKind: "b|c",
        message: "",
      }),
    );
  });

  it("cannot collide via the escape character either", () => {
    // Escaping "|" as "%7C" opens a second collision unless "%" is escaped FIRST.
    expect(
      healFailureSignature({
        failedNodeId: "a%7Cb",
        failureKind: "c",
        message: "",
      }),
    ).not.toBe(
      healFailureSignature({
        failedNodeId: "a|b",
        failureKind: "c",
        message: "",
      }),
    );
  });
});

describe("healFailureSignature — bounds and edge cases", () => {
  it("is bounded, so it stays indexable", () => {
    expect(sig("x".repeat(5_000)).length).toBeLessThanOrEqual(300);
  });

  it("handles a missing message", () => {
    expect(
      healFailureSignature({ failedNodeId: "n", failureKind: "error" }),
    ).toBe("n|error|");
    expect(
      healFailureSignature({
        failedNodeId: "n",
        failureKind: "error",
        message: null,
      }),
    ).toBe("n|error|");
  });

  it("is stable — the same input twice gives the same key", () => {
    expect(sig("Missing required header 'From'")).toBe(
      sig("Missing required header 'From'"),
    );
  });
});

describe("normalizeFailureMessage", () => {
  it("leaves ordinary words containing hex letters alone", () => {
    // "deadbeef" is 8 chars; the rule needs 12+ so real words are not mangled into <id>.
    expect(normalizeFailureMessage("decade faced")).toBe("decade faced");
  });
});
