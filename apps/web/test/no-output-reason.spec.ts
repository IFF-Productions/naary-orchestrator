// Why a run-detail step shows no output. Reported as "it's always saying no output recorded on
// the step" — the `end` node hits it on EVERY successful run, because it is a terminal
// passthrough that legitimately produces nothing.
//
// The invariant this file exists to hold: the generic "No output was recorded" wording must stay
// REACHABLE. It is also what a run whose ctx we failed to read looks like (see the state:completed
// branch in executions.queries.ts), and relabelling every empty output as "no output by design"
// would turn a real data-loss bug into a reassuring sentence.
import { describe, expect, it } from "vitest";
import { noOutputReason } from "../src/screens/app/run-detail/StepDetailCard";
import type { StepDetail } from "../src/screens/app/run-detail/StepDetailCard";

function step(over: Partial<StepDetail>): StepDetail {
  return {
    id: "n1",
    label: "Node",
    typeLine: "set",
    icon: "workflow",
    accent: "",
    state: "done",
    duration: null,
    output: undefined,
    isTriggerInput: false,
    ...over,
  } as StepDetail;
}

describe("noOutputReason", () => {
  it("names the end node's emptiness as structural, not as a missing record", () => {
    const msg = noOutputReason(step({ nodeType: "end", state: "done" }));
    expect(msg).toContain("end of the workflow");
    expect(msg).not.toContain("No output was recorded");
  });

  it("STILL says 'no output was recorded' for a done node that should have produced one", () => {
    // The load-bearing case: a completed step of an ordinary node with nothing in ctx is not
    // normal, and must keep reading as the anomaly it is.
    expect(noOutputReason(step({ nodeType: "agent", state: "done" }))).toBe(
      "No output was recorded for this step.",
    );
    // …including when the node type is unknown (an older run, or a type the UI doesn't model).
    expect(noOutputReason(step({ state: "done" }))).toBe(
      "No output was recorded for this step.",
    );
  });

  it("prefers the run-state explanation over the node type", () => {
    // An `end` node on a run that never got there is "didn't run", not "has no output by design".
    expect(noOutputReason(step({ nodeType: "end", state: "pending" }))).toBe(
      "No output yet — this step hasn't run.",
    );
    expect(
      noOutputReason(step({ nodeType: "end", state: "skipped" })),
    ).toContain("branch was not taken");
  });

  it("points a failed step at the evidence it has", () => {
    expect(noOutputReason(step({ state: "error" }))).toContain("Execution log");
    expect(
      noOutputReason(
        step({ state: "error", http: { nodeId: "n1" } as StepDetail["http"] }),
      ),
    ).toContain("request/response");
  });
});
