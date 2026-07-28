import { describe, expect, it } from "vitest";
import type { EvalRun } from "../src/lib/api";
import {
  passRate,
  runState,
  scoresByVersion,
  versionComparison,
} from "../src/screens/app/workflows/evals-model";

/**
 * #575's AC2 is a comparison — *"vN passed 18/20 vs vN-1 20/20"* — so the read-model has to be
 * right about WHICH run represents a version, and has to stay quiet when there is nothing to
 * compare against.
 */

const run = (over: Partial<EvalRun> = {}): EvalRun => ({
  id: "r1",
  datasetId: "d1",
  datasetName: "golden",
  workflowId: "wf",
  graphVersion: 1,
  graphContentHash: "abc",
  status: "completed",
  totalCases: 20,
  passed: 20,
  failed: 0,
  errored: 0,
  costUsd: 0.12,
  startedAt: "2026-07-01T10:00:00Z",
  finishedAt: "2026-07-01T10:05:00Z",
  ...over,
});

describe("passRate", () => {
  it("is a fraction of the cases actually run", () => {
    expect(passRate({ passed: 18, totalCases: 20 })).toBe(0.9);
  });

  it("is null — not 0 — when nothing was measured", () => {
    // 0% and "no data" are different claims; a 0 here would render as a total failure.
    expect(passRate({ passed: 0, totalCases: 0 })).toBeNull();
  });
});

describe("scoresByVersion", () => {
  it("keeps the LATEST run per version, not the best", () => {
    const s = scoresByVersion([
      run({
        id: "a",
        graphVersion: 3,
        passed: 20,
        startedAt: "2026-07-01T10:00:00Z",
      }),
      run({
        id: "b",
        graphVersion: 3,
        passed: 12,
        startedAt: "2026-07-02T10:00:00Z",
      }),
    ]);

    // Re-running after a change must MOVE the number; showing the best run would flatter it.
    expect(s).toHaveLength(1);
    expect(s[0].passed).toBe(12);
    expect(s[0].runId).toBe("b");
  });

  it("breaks a startedAt tie deterministically", () => {
    const same = "2026-07-01T10:00:00Z";
    const a = scoresByVersion([
      run({ id: "a", graphVersion: 1, passed: 1, startedAt: same }),
      run({ id: "b", graphVersion: 1, passed: 2, startedAt: same }),
    ]);
    const b = scoresByVersion([
      run({ id: "b", graphVersion: 1, passed: 2, startedAt: same }),
      run({ id: "a", graphVersion: 1, passed: 1, startedAt: same }),
    ]);

    // Same input set in either order → same answer, rather than "whatever the API listed first".
    expect(a).toEqual(b);
  });

  it("sorts ascending by version so a trend reads left to right", () => {
    const s = scoresByVersion([
      run({ id: "x", graphVersion: 9 }),
      run({ id: "y", graphVersion: 2 }),
      run({ id: "z", graphVersion: 5 }),
    ]);

    expect(s.map((v) => v.graphVersion)).toEqual([2, 5, 9]);
  });
});

describe("versionComparison", () => {
  it("names both versions and both scores", () => {
    const text = versionComparison([
      run({ id: "a", graphVersion: 8, passed: 20, totalCases: 20 }),
      run({ id: "b", graphVersion: 9, passed: 18, totalCases: 20 }),
    ]);

    expect(text).toBe("v9 passed 18/20 vs v8's 20/20");
  });

  it("says NOTHING when there is only one version", () => {
    // "18/20" alone isn't a comparison, and inventing a baseline would be worse than silence.
    expect(versionComparison([run({ graphVersion: 1 })])).toBeNull();
    expect(versionComparison([])).toBeNull();
  });
});

describe("runState", () => {
  it("is running while unfinished, even if the status says otherwise", () => {
    expect(runState(run({ finishedAt: null }))).toBe("running");
    expect(runState(run({ status: "running" }))).toBe("running");
  });

  it("is an error when any case failed or errored", () => {
    expect(runState(run({ failed: 1 }))).toBe("error");
    expect(runState(run({ errored: 1 }))).toBe("error");
  });

  it("is done only when everything passed", () => {
    expect(runState(run())).toBe("done");
  });
});
