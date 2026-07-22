/**
 * Canvas live run-watch (#490): map a run's REAL execution state onto the
 * interactive editor canvas's per-node card state, so opening a run on the
 * canvas highlights nodes as they execute.
 *
 * The state-derivation is NOT duplicated — it reuses the Run Detail screen's
 * `computeStepStates` (ctx keys = executed nodes, currentNodeId + status →
 * done/running/waiting/error/pending/skipped) so the canvas and RunDetail agree
 * exactly. This module only translates that StepState into the canvas card's
 * NodeRunState union, which the NodeCard already renders visually.
 */
import type { GraphDef } from "@naary/dsl";
import type { ExecutionState } from "../../lib/api";
import {
  computeStepStates,
  type StepState,
} from "../app/run-detail/run-view-model";
import type { NodeRunState } from "./NodeCard";

/**
 * RunDetail's StepState → the canvas card's NodeRunState. The canvas union has
 * no "pending" (a node still ahead of a live run); "queued" is its exact
 * counterpart (ahead-of-run, not yet started) and the NodeCard renders it.
 */
export const STEP_TO_NODE_RUN_STATE: Record<StepState, NodeRunState> = {
  done: "done",
  running: "running",
  error: "error",
  waiting: "waiting",
  pending: "queued",
  skipped: "skipped",
};

/**
 * Per-node NodeRunState for EVERY node in the (canvas-compiled) graph, derived
 * from the live run state. Feeds `NaaryData.runState` on each canvas node.
 *
 * `done/running/error/waiting` map purely by node id (robust even if the open
 * graph diverged from the executed snapshot); `pending/skipped` additionally
 * depend on the edges/reachability matching — identical for the same, unedited
 * workflow (the primary "Open in canvas" path).
 */
export function computeCanvasRunStates(
  graph: GraphDef,
  state: ExecutionState,
): Record<string, NodeRunState> {
  const steps = computeStepStates(
    graph,
    state.ctx,
    state.currentNodeId,
    state.status,
    state.executedNodeIds,
  );
  const out: Record<string, NodeRunState> = {};
  for (const [id, s] of Object.entries(steps)) {
    out[id] = STEP_TO_NODE_RUN_STATE[s];
  }
  return out;
}
