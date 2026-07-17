import { describe, expect, it } from "vitest";
import {
  captureActivityFailure,
  isExpectedActivityFailure,
} from "../src/index";

/**
 * Activity-failure capture: unexpected failures become Sentry issues; EXPECTED user-fixable
 * failures (bad/exhausted credential, unconfigured integration, connection re-auth) must NOT
 * — they'd flood the issue tracker with noise no operator can act on. The filter duck-types
 * ApplicationFailure's `type` so this package needs no @temporalio import.
 */

/** Shaped like @temporalio ApplicationFailure without importing it. */
function appFailure(type: string): Error & { type: string } {
  const e = new Error(`failure of type ${type}`) as Error & { type: string };
  e.name = "ApplicationFailure";
  e.type = type;
  return e;
}

describe("isExpectedActivityFailure", () => {
  it.each(["AUTH", "QUOTA", "AUTH_NOT_CONFIGURED", "CONNECTION_REAUTH"])(
    "treats %s as expected (user-fixable — no Sentry issue)",
    (type) => {
      expect(isExpectedActivityFailure(appFailure(type))).toBe(true);
    },
  );

  it.each([
    "CODE_AGENT_TRANSIENT",
    "CODE_AGENT_FAILED",
    "AGENT_TRANSIENT",
    "EGRESS_BLOCKED",
  ])("treats %s as unexpected (operator-relevant)", (type) => {
    expect(isExpectedActivityFailure(appFailure(type))).toBe(false);
  });

  it("treats a plain Error / non-error as unexpected", () => {
    expect(isExpectedActivityFailure(new TypeError("boom"))).toBe(false);
    expect(isExpectedActivityFailure("string error")).toBe(false);
    expect(isExpectedActivityFailure(null)).toBe(false);
    expect(isExpectedActivityFailure(undefined)).toBe(false);
  });

  it("ignores a non-string `type` field (no accidental match)", () => {
    const weird = new Error("x") as Error & { type: unknown };
    weird.type = 42;
    expect(isExpectedActivityFailure(weird)).toBe(false);
  });
});

describe("captureActivityFailure", () => {
  it("is a safe no-op when Sentry is not initialized (no DSN)", () => {
    // initSentry was never called in this process — must not throw, must not send.
    expect(() =>
      captureActivityFailure(
        "callCodeAgent",
        { tenantId: "t1", nodeId: "n1" },
        appFailure("CODE_AGENT_TRANSIENT"),
      ),
    ).not.toThrow();
  });
});
