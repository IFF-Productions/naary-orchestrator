import { describe, expect, it } from "vitest";
import { sampleGraph, walk } from "@naary/dsl";
import { CONTRACTS_PACKAGE } from "@naary/contracts";

// Proves the pnpm-workspace boundary actually resolves at runtime (built JS in
// node_modules via symlink), not just at type-check time. @naary/dsl now has
// real exports (Task 1); @naary/contracts is still a placeholder until Task 3.
describe("pnpm workspace cross-package resolution", () => {
  it("imports the built @naary/dsl package and runs walk across the boundary", () => {
    expect(walk(sampleGraph).map((n) => n.type)).toEqual([
      "start",
      "agent",
      "humanApproval",
      "end",
    ]);
  });

  it("imports the built @naary/contracts package", () => {
    expect(CONTRACTS_PACKAGE).toBe("@naary/contracts");
  });
});
