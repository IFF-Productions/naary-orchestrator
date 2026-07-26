/**
 * Run-status classification (src/lib/run-status.ts) — the seam the Runs filter tabs, the
 * notifications bell, the observability charts and the run diagram all share.
 *
 * The point of these is the PARTITION. "Rejected" (a human declined at an approval gate) used
 * to be counted as a failure in the Runs filters, so a working approval flow looked like an
 * outage. Splitting it out is only safe if the aggregate `isFailure` keeps its old meaning —
 * the bell and the success-rate denominators depend on that — so both halves are asserted here.
 */
import { describe, expect, it } from "vitest";
import {
  isFailure,
  isRejected,
  isSuccess,
  isSystemFailure,
  isTerminal,
  RUN_STATUS_UI,
  runStatusUi,
  successRate,
} from "../src/lib/run-status";

/** Every status the control plane can report (RUN_STATUS_UI is the source of truth). */
const ALL = Object.keys(RUN_STATUS_UI);
const TERMINAL = ALL.filter(isTerminal);

describe("isRejected", () => {
  it("is true for exactly one status", () => {
    expect(ALL.filter(isRejected)).toEqual(["rejected"]);
  });
});

describe("the terminal partition", () => {
  it("puts every terminal status in exactly one of completed / rejected / system-failure", () => {
    for (const s of TERMINAL) {
      const buckets = [isSuccess(s), isRejected(s), isSystemFailure(s)].filter(
        Boolean,
      );
      expect(buckets, `${s} landed in ${buckets.length} buckets`).toHaveLength(
        1,
      );
    }
  });

  it("classifies no NON-terminal status as rejected or a system failure", () => {
    for (const s of ALL.filter((x) => !isTerminal(x))) {
      expect(isRejected(s), s).toBe(false);
      expect(isSystemFailure(s), s).toBe(false);
    }
  });
});

describe("isSystemFailure", () => {
  it("covers the genuine failures — what an operator should investigate", () => {
    expect(ALL.filter(isSystemFailure).sort()).toEqual(
      [
        "budget_exceeded",
        "canceled",
        "circuit_open",
        "failed",
        "invalid_graph",
        "terminated",
        "timed_out",
      ].sort(),
    );
  });

  it("excludes a human rejection — the system did what it was asked", () => {
    expect(isSystemFailure("rejected")).toBe(false);
  });
});

describe("isFailure (unchanged aggregate)", () => {
  // REGRESSION GUARD: the notifications bell, observe-model's failure buckets and the run
  // diagram all key off isFailure. A rejected run produced no result, so it must stay in the
  // aggregate "didn't succeed" bucket even though the Runs tabs now list it separately.
  it("still counts a rejected run as not-successful", () => {
    expect(isFailure("rejected")).toBe(true);
  });

  it("is exactly terminal-minus-completed", () => {
    expect(ALL.filter(isFailure).sort()).toEqual(
      TERMINAL.filter((s) => s !== "completed").sort(),
    );
  });

  it("is the union of rejected and system failures", () => {
    for (const s of ALL) {
      expect(isFailure(s), s).toBe(isRejected(s) || isSystemFailure(s));
    }
  });
});

describe("successRate", () => {
  it("counts a rejection against the rate (it produced no result)", () => {
    expect(successRate(["completed", "rejected"])).toBe(50);
  });

  it("ignores runs still in flight", () => {
    expect(successRate(["completed", "running", "awaiting_approval"])).toBe(
      100,
    );
  });

  it("is null before anything has finished", () => {
    expect(successRate(["running", "awaiting_webhook"])).toBeNull();
  });
});

describe("runStatusUi", () => {
  it("labels a rejection distinctly from a failure", () => {
    expect(runStatusUi("rejected").label).toBe("Rejected");
    expect(runStatusUi("failed").label).toBe("Failed");
  });

  it("falls back to the raw status rather than inventing one", () => {
    expect(runStatusUi("brand_new_status")).toEqual({
      state: "idle",
      label: "brand_new_status",
    });
  });
});
