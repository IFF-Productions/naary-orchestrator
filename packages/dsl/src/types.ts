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

/** Start node: an optional sample trigger input used for manual/test runs. */
export interface StartNodeConfig {
  sampleInput?: Record<string, unknown>;
}

/** Human-approval node config. The interpreter reads `timeoutHours` to bound the
 *  durable wait (auto-reject on elapse); title/instructions are display-only (the
 *  UI reads them from the graph). */
export interface ApprovalNodeConfig {
  title?: string;
  instructions?: string;
  /** Auto-reject if no decision within this many hours (omitted = wait forever). */
  timeoutHours?: number;
}

export interface McpToolNodeConfig {
  connectionId: string;
  tool: string;
  /** Static arguments, merged under any resolved bindings. */
  arguments?: Record<string, unknown>;
  /** argName → upstream output binding; overrides a static key of the same name. */
  argumentBindings?: Record<string, ArgBinding>;
  /** Flat per-call cost metered into the run budget (Slice #6 / Arch§4.6). */
  costUsd?: number;
}

/**
 * Slice #6 — a structured, PURE edge predicate (never code/eval). Evaluated
 * against the run `ctx` to decide whether to take the edge. `path` is a dotted
 * path into ctx (e.g. "agent.output.category"); `op` compares the resolved value
 * to `value`. An edge with no condition is unconditional (linear/parallel).
 */
export interface EdgeCondition {
  path: string;
  op: "eq" | "neq" | "in" | "exists" | "gt" | "lt";
  value?: unknown;
}

export interface EdgeDef {
  from: string;
  to: string;
  condition?: EdgeCondition;
}

export interface GraphDef {
  nodes: NodeDef[];
  edges: EdgeDef[];
  startNodeId: string;
}
