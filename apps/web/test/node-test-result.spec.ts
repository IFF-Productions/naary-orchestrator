import { describe, expect, it } from "vitest";
import type { TestNodeResult } from "../src/lib/api/types";
import { nodeTestState } from "../src/lib/node-test-state";

/**
 * A node test can come back `pure: false` for TWO reasons that must not look the same on screen:
 *
 *   1. this node type can't be tested in isolation — informational, the node goes back to idle;
 *   2. the test RAN and FAILED — an error, and the reason belongs on the node.
 *
 * Reported as: `{"pure":false,"message":"Test run failed: Workflow execution failed"}` "is not
 * being surfaced to logs or to the user to see why its failing". #825 recovered the real reason
 * from Temporal's cause chain; it was then thrown away one layer later, because the canvas
 * treated both shapes identically — cleared the node's state and dropped the text into a
 * transient status line that the next action replaces.
 *
 * These assert `nodeTestState` itself — the function the canvas calls — rather than a copy of its
 * rule, which would pass while the canvas did something else entirely.
 */

describe("a pure:false node test", () => {
  it("puts the FAILURE on the node, with its reason", () => {
    const state = nodeTestState(
      {
        pure: false,
        failed: true,
        message:
          "Test run failed: PagerDuty rejected create_incident with 401 — the token was rejected",
      },
      50,
    );

    expect(state?.status).toBe("error");
    // The reason #825 works to recover must reach the node, not evaporate in a status line.
    expect(state?.message).toContain("401");
  });

  it("clears the node for an untestable node type — that is not a failure", () => {
    const state = nodeTestState(
      {
        pure: false,
        message: '"start" can\'t be tested in isolation — run the full flow.',
      },
      50,
    );

    // null = "back to idle". A red node here would claim something broke when nothing ran.
    expect(state).toBeNull();
  });

  /** The bug itself: without the discriminator, both shapes took the same branch. */
  it("does not treat a failure the same as an untestable node", () => {
    const failure: TestNodeResult = {
      pure: false,
      failed: true,
      message: "Test run failed: connect ECONNREFUSED",
    };
    const untestable: TestNodeResult = {
      pure: false,
      message: "can't be tested in isolation",
    };

    expect(nodeTestState(failure, 1)).not.toEqual(nodeTestState(untestable, 1));
  });
});

describe("a pure node test", () => {
  it("prefers the SERVER's measured duration over the client's stopwatch", () => {
    const state = nodeTestState(
      { pure: true, output: { ok: 1 }, durationMs: 12, costUsd: 0.004 },
      999,
    );

    expect(state).toEqual({
      status: "done",
      output: { ok: 1 },
      ms: 12,
      costUsd: 0.004,
    });
  });

  it("falls back to the client stopwatch when the server measured nothing", () => {
    const state = nodeTestState(
      { pure: true, output: null, durationMs: null, costUsd: null },
      42,
    );

    expect(state?.ms).toBe(42);
    // No fabricated cost: a node that metered nothing must not report 0.
    expect(state).not.toHaveProperty("costUsd");
  });
});
