/**
 * What a single-node test result means for the node's state on the canvas.
 *
 * Extracted from CanvasPage so it can be tested as the REAL decision rather than a copy of it —
 * a test that re-implements this rule passes happily while the canvas does something else.
 *
 * The distinction that matters: `pure: false` covers two unrelated situations.
 *
 *   - `failed` absent — this node type can't be tested in isolation. Informational; the node goes
 *     back to idle, because a red node would claim something broke when nothing ran.
 *   - `failed: true` — the test RAN and failed. That is an error and belongs ON the node, the same
 *     as a thrown one.
 *
 * Reported as `{"pure":false,"message":"Test run failed: Workflow execution failed"}` "not being
 * surfaced … to see why its failing". #825 recovered the real reason from Temporal's cause chain;
 * it was then discarded one layer later because both shapes took the same branch here.
 */
import type { TestNodeResult } from "./api/types";
import type { NodeTestRun } from "../screens/canvas/canvas-types";

/**
 * The node's new test state, or `null` meaning "clear it" (back to idle).
 * `clientMs` is the caller's wall-clock fallback, used when the server reported no duration.
 */
export function nodeTestState(
  res: TestNodeResult,
  clientMs: number,
): NodeTestRun | null {
  if (res.pure) {
    return {
      status: "done",
      output: res.output,
      ms: typeof res.durationMs === "number" ? res.durationMs : clientMs,
      ...(typeof res.costUsd === "number" ? { costUsd: res.costUsd } : {}),
    };
  }
  if (res.failed)
    return { status: "error", message: res.message, ms: clientMs };
  return null;
}
