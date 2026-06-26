/**
 * Editor-side graph model. The canvas works in these terms (node positions, edges
 * by source/target) and compiles to the platform `@naary/dsl` GraphDef on save —
 * see compile-graph.ts. Positions are editor-only and don't reach the DSL.
 */
import type { NodeType } from "@naary/dsl";

export interface CanvasNode {
  id: string;
  type: NodeType;
  position: { x: number; y: number };
  /** Per-type DSL config (agent.systemPrompt, mcpTool.connectionId/tool, …). */
  config?: Record<string, unknown>;
}

export interface CanvasEdge {
  id: string;
  /** Source node id (compiles to edge.from). */
  source: string;
  /** Target node id (compiles to edge.to). */
  target: string;
}

/** The node types a user can place, with display labels. Order = palette order. */
export const NODE_KINDS: { type: NodeType; label: string }[] = [
  { type: "start", label: "Start" },
  { type: "webhookTrigger", label: "Webhook" },
  { type: "agent", label: "Agent" },
  { type: "mcpTool", label: "MCP Tool" },
  { type: "humanApproval", label: "Approval" },
  { type: "end", label: "End" },
];
