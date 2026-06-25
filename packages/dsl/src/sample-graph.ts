import type { GraphDef } from "./types";

/**
 * Slice #1's hardcoded, linear graph: start → agent → humanApproval → end.
 * (Loaded from Postgres in a later slice; hardcoded here on purpose.)
 */
export const sampleGraph: GraphDef = {
  startNodeId: "start",
  nodes: [
    { id: "start", type: "start" },
    { id: "agent", type: "agent", config: { canned: "hello from stub agent" } },
    { id: "approval", type: "humanApproval" },
    { id: "end", type: "end" },
  ],
  edges: [
    { from: "start", to: "agent" },
    { from: "agent", to: "approval" },
    { from: "approval", to: "end" },
  ],
};
