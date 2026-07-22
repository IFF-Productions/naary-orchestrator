import { describe, expect, it } from "vitest";
import {
  buildDebugEvents,
  safeFields,
} from "../src/screens/app/run-detail/DebugLogSection";
import type { TimelineStep } from "../src/screens/app/run-detail/StepTimeline";

const step = (p: Partial<TimelineStep> & { id: string }): TimelineStep => ({
  label: p.id,
  icon: "workflow",
  accent: "var(--ink-3)",
  state: "done",
  duration: null,
  durationMs: null,
  cost: null,
  ...p,
});

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

describe("buildDebugEvents — synthetic per-node rows for the timeline", () => {
  it("emits one row per EXECUTED node, stamped with finish time + safe fields", () => {
    const steps: TimelineStep[] = [
      step({ id: "agent", label: "Agent", state: "done", duration: "340ms" }),
      step({ id: "skipped", state: "skipped" }), // not executed → no row
      step({ id: "pending", state: "pending" }), // not executed → no row
    ];
    const ctx = { agent: { model: "opus", costUsd: 0.02, text: "SECRET" } };
    const nodeTimes = { agent: { s: 1000, f: 1340 } };

    const rows = buildDebugEvents(steps, ctx, nodeTimes);

    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("debug");
    expect(rows[0].at).toBe(new Date(1340).toISOString()); // finish time → sortable into timeline
    expect(rows[0].label).toBe(
      "Agent (agent)  ·  340ms  ·  model=opus  ·  cost=$0.0200",
    );
    expect(rows[0].label).not.toContain("SECRET"); // content never leaks
  });

  it("gives an untimed executed node a null `at` (caller sorts those last)", () => {
    const rows = buildDebugEvents(
      [step({ id: "n", state: "done" })],
      {},
      null, // no nodeTimes
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].at).toBeNull();
  });
});
