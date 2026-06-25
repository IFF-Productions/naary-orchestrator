/**
 * The graph DSL: the data a workflow is compiled to and the interpreter walks.
 * Platform-agnostic — no Temporal, no I/O. (CLAUDE.md: interpreter, not codegen.)
 */

export type NodeType = "start" | "agent" | "humanApproval" | "end";

export interface NodeDef {
  id: string;
  type: NodeType;
  /** Node-specific configuration, e.g. the agent node's canned output. */
  config?: Record<string, unknown>;
}

export interface EdgeDef {
  from: string;
  to: string;
}

export interface GraphDef {
  nodes: NodeDef[];
  edges: EdgeDef[];
  startNodeId: string;
}
