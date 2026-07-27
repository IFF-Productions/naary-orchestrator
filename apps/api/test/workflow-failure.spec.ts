import { describe, expect, it } from "vitest";
import {
  describeWorkflowFailure,
  failureChain,
} from "../src/executions/workflow-failure";

/**
 * Reported from a real single-node test run:
 *
 *     {"pure":false,"message":"Test run failed: Workflow execution failed"}
 *
 * `client.workflow.execute()` rejects with a `WorkflowFailedError` whose own message is ALWAYS
 * those three words; the reason lives in its `cause` chain. Reading `e.message` returned the
 * wrapper to the user and logged nothing, so the failure was undiagnosable from either end.
 */

/** The shape Temporal actually produces: generic wrapper → activity wrapper → the real failure. */
const temporalFailure = (inner: {
  message: string;
  type?: string;
  cause?: unknown;
}) => ({
  name: "WorkflowFailedError",
  message: "Workflow execution failed",
  cause: {
    name: "ActivityFailure",
    message: "Activity task failed",
    cause: inner,
  },
});

describe("describeWorkflowFailure", () => {
  it("digs out the activity's real error instead of the wrapper", () => {
    const err = temporalFailure({
      message:
        "integration 'pagerduty.acknowledge' failed: 401 Unauthorized [POST /incidents/PT4KHLK]",
      type: "INTEGRATION_WRITE_FAILED",
    });
    const msg = describeWorkflowFailure(err);
    expect(msg).toContain("pagerduty.acknowledge");
    expect(msg).toContain("401");
    // The failure TYPE is kept — it is what makes the error searchable and actionable.
    expect(msg).toContain("INTEGRATION_WRITE_FAILED");
    // …and the useless wrapper is gone.
    expect(msg).not.toBe("Workflow execution failed");
  });

  /** The INNERMOST informative layer wins: Temporal nests, so the outermost is the least specific. */
  it("prefers the deepest informative message", () => {
    const err = temporalFailure({
      message: "connection 'conn-1' has no token",
      type: "INTEGRATION_NO_TOKEN",
      cause: { message: "no rows returned" },
    });
    expect(describeWorkflowFailure(err)).toContain("no rows returned");
  });

  /** When every layer is generic there is nothing better — but it must still say something. */
  it("falls back to the outermost message when the whole chain is generic", () => {
    expect(
      describeWorkflowFailure({
        message: "Workflow execution failed",
        cause: { message: "Activity task failed" },
      }),
    ).toBe("Workflow execution failed");
  });

  /** An activity failure can quote a provider's response body — which can carry a token. */
  it("redacts secret-shaped values out of the surfaced reason", () => {
    const msg = describeWorkflowFailure(
      temporalFailure({
        message:
          'provider rejected: {"error":"bad key","token":"sk-live-abcdef1234567890abcdef"}',
      }),
    );
    expect(msg).not.toContain("sk-live-abcdef1234567890abcdef");
  });

  it("never throws, whatever it is handed", () => {
    for (const junk of [
      undefined,
      null,
      "a string",
      42,
      {},
      [],
      new Error(""),
    ]) {
      expect(() => describeWorkflowFailure(junk)).not.toThrow();
    }
    expect(describeWorkflowFailure(undefined)).toBe("the node errored");
    expect(describeWorkflowFailure(new Error("plain"))).toBe("plain");
  });

  /** A cyclic cause chain must not spin — it can arrive over a serialization boundary. */
  it("terminates on a cyclic chain", () => {
    const a: Record<string, unknown> = { message: "a" };
    const b: Record<string, unknown> = { message: "b", cause: a };
    a.cause = b;
    expect(() => describeWorkflowFailure(a)).not.toThrow();
    expect(failureChain(a).length).toBeLessThan(12);
  });

  it("caps a runaway message", () => {
    const msg = describeWorkflowFailure(
      temporalFailure({ message: "x".repeat(5000) }),
    );
    expect(msg.length).toBeLessThanOrEqual(300);
  });
});

describe("failureChain", () => {
  /** The chain is what gets LOGGED — the full path, so the server side is diagnosable even when
   *  the user-facing message is the innermost layer only. */
  it("returns every layer, outermost first", () => {
    expect(
      failureChain(temporalFailure({ message: "boom", type: "NODE_FAILED" })),
    ).toEqual([
      "Workflow execution failed",
      "Activity task failed",
      "boom [NODE_FAILED]",
    ]);
  });

  /** The chain is logged in FULL, so an unbounded entry is its own incident: an activity failure
   *  can quote a multi-KB provider body or a stack. */
  it("caps each layer so a log line can't run away", () => {
    const chain = failureChain({
      message: "outer",
      cause: { message: "y".repeat(9000), cause: { message: "inner" } },
    });
    expect(chain).toHaveLength(3);
    for (const entry of chain) expect(entry.length).toBeLessThanOrEqual(520);
    // The deepest layer still survives — capping must not truncate the CHAIN, only its entries.
    expect(chain[2]).toBe("inner");
  });

  it("is empty for a non-object", () => {
    expect(failureChain("nope")).toEqual([]);
    expect(failureChain(undefined)).toEqual([]);
  });
});
