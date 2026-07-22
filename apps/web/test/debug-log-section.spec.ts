import { describe, expect, it } from "vitest";
import { safeFields } from "../src/screens/app/run-detail/DebugLogSection";

describe("DebugLogSection.safeFields — allowlist (never leak node output content)", () => {
  it("surfaces only allowlisted metadata from an agent output", () => {
    const out = safeFields({
      model: "claude-opus-4-8",
      totalTokens: 1234,
      costUsd: 0.0231,
      // content that must NEVER appear:
      output: { review: "the customer's SSN is 123-45-6789" },
      text: "secret completion text",
    });
    expect(out).toEqual([
      "model=claude-opus-4-8",
      "tokens=1,234",
      "cost=$0.0231",
    ]);
    expect(out.join(" ")).not.toContain("SSN");
    expect(out.join(" ")).not.toContain("completion");
  });

  it("surfaces http status/pages but not the response body/headers", () => {
    const out = safeFields({
      httpStatus: 200,
      pages: 3,
      headers: { authorization: "Bearer sk-secret" },
      body: { token: "ghp_leak" },
    });
    expect(out).toEqual(["status=200", "pages=3"]);
    expect(out.join(" ")).not.toContain("Bearer");
    expect(out.join(" ")).not.toContain("ghp_leak");
  });

  it("drops nested-object allowlisted values and omits zero cost", () => {
    // costUsd 0 → omitted; a model that's somehow an object → skipped (never stringified).
    expect(safeFields({ costUsd: 0, model: { nested: "x" } })).toEqual([]);
  });

  it("returns [] for a non-object / array output", () => {
    expect(safeFields("plain string output")).toEqual([]);
    expect(safeFields([1, 2, 3])).toEqual([]);
    expect(safeFields(null)).toEqual([]);
  });
});
