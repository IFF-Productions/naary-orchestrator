import { describe, expect, it, vi } from "vitest";
import type { Logger } from "@naary/logging";
import { type AgentMeta, runLog } from "../src/temporal/activities/shared";

const META: AgentMeta = { tenantId: "t-1", executionId: "e-1", nodeId: "n-1" };

describe("runLog — per-run debug logging (opt-in)", () => {
  it("returns the base logger UNCHANGED when the run didn't opt into debug", () => {
    const child = vi.fn();
    const base = { child } as unknown as Logger;

    expect(runLog(base, META)).toBe(base);
    // No child is created → a normal run pays nothing and stays at the process LOG_LEVEL.
    expect(child).not.toHaveBeenCalled();
  });

  it("returns a DEBUG-level child carrying the run's correlation ids when meta.debug is true", () => {
    const childLogger = { debug: vi.fn() } as unknown as Logger;
    const child = vi.fn().mockReturnValue(childLogger);
    const base = { child } as unknown as Logger;

    const out = runLog(base, { ...META, debug: true });

    expect(out).toBe(childLogger);
    // Debug level + filterable-by-run bindings, so this ONE run's extra lines are isolatable.
    expect(child).toHaveBeenCalledWith(
      { executionId: "e-1", nodeId: "n-1", tenantId: "t-1" },
      { level: "debug" },
    );
  });
});
