/**
 * The graph DSL: the data a workflow is compiled to and the interpreter walks.
 * Platform-agnostic — no Temporal, no I/O. (CLAUDE.md: interpreter, not codegen.)
 */

export type NodeType =
  | "start"
  | "webhookTrigger" // Slice #4: entry node whose output is the inbound event
  | "agent"
  | "mcpTool" // Slice #4: calls a remote MCP server tool via a connection
  | "humanApproval"
  | "end";

export interface NodeDef {
  id: string;
  type: NodeType;
  /** Node-specific configuration, e.g. the agent node's canned output. */
  config?: Record<string, unknown>;
}

/**
 * Slice #4 — bind one MCP tool argument to an upstream node's output.
 * `from` is the producing node id; `path` is an optional dotted path into that
 * node's output (e.g. "pull_request.number", "output.category"). Resolved purely
 * in the interpreter (deterministic graph-traversal work), never in the activity.
 */
export interface ArgBinding {
  from: string;
  path?: string;
}

export interface McpToolNodeConfig {
  connectionId: string;
  tool: string;
  /** Static arguments, merged under any resolved bindings. */
  arguments?: Record<string, unknown>;
  /** argName → upstream output binding; overrides a static key of the same name. */
  argumentBindings?: Record<string, ArgBinding>;
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
