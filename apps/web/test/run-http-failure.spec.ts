import { describe, expect, it } from "vitest";
import { historyTimes } from "../src/screens/app/run-detail/run-view-model";
import type { HttpFailure, RunEvent } from "../src/lib/api";

/**
 * The step card shows the run's failure message on the node that died (#525) and, since #916, the
 * redacted request/response that node captured. Both come off the execution log — and they must
 * come off the SAME event: a failed run records an `activityTaskFailed` AND a generic
 * `workflowExecutionFailed`, so picking each independently could pair one call's message with
 * another call's request.
 */

const CAPTURE: HttpFailure = {
  nodeId: "integration-1",
  request: {
    method: "POST",
    url: "https://api.github.com/repos/o/r/issues",
    headers: { authorization: "[REDACTED]" },
  },
  response: { status: 404, headers: {} },
};

function ev(over: Partial<RunEvent>): RunEvent {
  return { id: 1, kind: "activity", label: "x", at: null, ...over };
}

describe("historyTimes — the failing call", () => {
  it("takes the message and the capture from the same (first) error event", () => {
    const other: HttpFailure = {
      ...CAPTURE,
      request: { ...CAPTURE.request, url: "https://elsewhere.example/x" },
    };
    const out = historyTimes([
      ev({ id: 1, kind: "started", at: "2026-07-24T10:00:00.000Z" }),
      ev({
        id: 2,
        kind: "error",
        label: "Activity failed",
        detail: "integration 'github.comment_issue' failed: 404",
        http: CAPTURE,
      }),
      ev({
        id: 3,
        kind: "error",
        label: "Run failed",
        detail: "Activity task failed",
        http: other,
      }),
    ]);
    expect(out.errorDetail).toContain("comment_issue");
    expect(out.errorHttp).toBe(CAPTURE);
  });

  it("is null when the failing node made no HTTP call", () => {
    const out = historyTimes([
      ev({
        id: 2,
        kind: "error",
        label: "Activity failed",
        detail: "agent failed",
      }),
    ]);
    expect(out.errorDetail).toBe("agent failed");
    expect(out.errorHttp).toBeNull();
  });

  it("is null for a run with no history at all", () => {
    expect(historyTimes(null).errorHttp).toBeNull();
    expect(historyTimes([]).errorHttp).toBeNull();
  });

  it("names the node it belongs to, so the card can refuse to show it elsewhere", () => {
    // A node with onError:"continue" also records an activityTaskFailed, so the run's first
    // error event isn't always the node that killed the run. The card gates on this id
    // (RunDetail.tsx) rather than trusting the position.
    const out = historyTimes([
      ev({ id: 2, kind: "error", detail: "boom", http: CAPTURE }),
    ]);
    expect(out.errorHttp?.nodeId).toBe("integration-1");
  });
});
