import { describe, expect, it } from "vitest";
import { sampleGraph, walk } from "@naary/dsl";
import { TASK_QUEUE } from "@naary/contracts";

// Proves the pnpm-workspace boundary actually resolves at runtime (built JS in
// node_modules via symlink), not just at type-check time. Importing @naary/contracts
// from this (client-side) test also confirms its transitive @temporalio/workflow
// import is client-safe — it does NOT pull in workflow-sandbox runtime.
describe("pnpm workspace cross-package resolution", () => {
  it("imports the built @naary/dsl package and runs walk across the boundary", () => {
    expect(walk(sampleGraph).map((n) => n.type)).toEqual([
      "start",
      "agent",
      "humanApproval",
      "end",
    ]);
  });

  it("imports @naary/contracts in client context (TASK_QUEUE resolves)", () => {
    expect(TASK_QUEUE).toBe("orchestrator");
  });
});
