import type { GraphDef } from "@naary/dsl";
import { describe, expect, it } from "vitest";
import type { ExecutionState } from "../src/lib/api";
import {
  computeCanvasRunStates,
  STEP_TO_NODE_RUN_STATE,
} from "../src/screens/canvas/run-watch";

/** Minimal linear graph: start → a → b → end (enough for computeStepStates). */
const GRAPH = {
  startNodeId: "start",
  nodes: [
    { id: "start", type: "start" },
    { id: "a", type: "agent" },
    { id: "b", type: "httpRequest" },
    { id: "end", type: "end" },
  ],
  edges: [
    { from: "start", to: "a" },
    { from: "a", to: "b" },
    { from: "b", to: "end" },
  ],
} as unknown as GraphDef;

function state(partial: Partial<ExecutionState>): ExecutionState {
  return {
    status: "running",
    currentNodeId: "",
    ctx: {},
    ...partial,
  };
}

describe("computeCanvasRunStates (#490 canvas live run-watch)", () => {
  it("maps a live, mid-run node to running + upstream done + downstream queued", () => {
    const s = state({
      status: "running",
      currentNodeId: "a",
      ctx: { start: { fired: true } },
    });
    const out = computeCanvasRunStates(GRAPH, s);
    expect(out.start).toBe("done"); // entry trigger fired
    expect(out.a).toBe("running"); // the current node
    // Still ahead of the run → StepState "pending" → canvas "queued".
    expect(out.b).toBe("queued");
    expect(out.end).toBe("queued");
  });

  it("marks the failed node error and keeps executed upstream done", () => {
    const s = state({
      status: "failed",
      currentNodeId: "a",
      // ctx came back empty; the interpreter stamped which nodes ran.
      ctx: {},
      executedNodeIds: ["start"],
    });
    const out = computeCanvasRunStates(GRAPH, s);
    expect(out.start).toBe("done");
    expect(out.a).toBe("error");
  });

  it("a terminal (completed) run has NO node left running — watch can stop", () => {
    const s = state({
      status: "completed",
      currentNodeId: "end",
      ctx: { start: {}, a: {}, b: {}, end: {} },
    });
    const out = computeCanvasRunStates(GRAPH, s);
    // Every node resolved; nothing is mid-flight.
    for (const node of GRAPH.nodes) {
      expect(out[node.id], node.id).not.toBe("running");
    }
    expect(out.a).toBe("done");
    expect(out.end).toBe("done");
  });

  it("a paused (awaiting_approval) run marks the current node waiting", () => {
    const s = state({
      status: "awaiting_approval",
      currentNodeId: "a",
      ctx: { start: {} },
    });
    const out = computeCanvasRunStates(GRAPH, s);
    expect(out.a).toBe("waiting");
  });

  it("every StepState maps to a valid NodeRunState (pending → queued)", () => {
    expect(STEP_TO_NODE_RUN_STATE.pending).toBe("queued");
    expect(STEP_TO_NODE_RUN_STATE.done).toBe("done");
    expect(STEP_TO_NODE_RUN_STATE.running).toBe("running");
    expect(STEP_TO_NODE_RUN_STATE.error).toBe("error");
    expect(STEP_TO_NODE_RUN_STATE.waiting).toBe("waiting");
    expect(STEP_TO_NODE_RUN_STATE.skipped).toBe("skipped");
  });
});
