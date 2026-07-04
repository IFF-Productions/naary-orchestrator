/**
 * Editor-side graph model. The canvas works in these terms (node positions, edges
 * by source/target) and compiles to the platform `@naary/dsl` GraphDef on save —
 * see compile-graph.ts. Positions are editor-only and don't reach the DSL.
 */
import type { EdgeCondition, NodeType } from "@naary/dsl";

export interface CanvasNode {
  id: string;
  type: NodeType;
  position: { x: number; y: number };
  /** Per-type DSL config (agent.systemPrompt, mcpTool.connectionId/tool, …). */
  config?: Record<string, unknown>;
}

/** Editor form of an edge condition: `value` is the RAW input string (kept so the
 *  text field edits smoothly); compile-graph parses it to the DSL value by `op`. */
export interface EdgeConditionDraft {
  path: string;
  op: EdgeCondition["op"];
  value: string;
}

export const CONDITION_OPS: EdgeCondition["op"][] = [
  "eq",
  "neq",
  "gt",
  "lt",
  "in",
  "exists",
];

export interface CanvasEdge {
  id: string;
  /** Source node id (compiles to edge.from). */
  source: string;
  /** Target node id (compiles to edge.to). */
  target: string;
  /** Optional branch predicate; absent / blank path = unconditional edge. */
  condition?: EdgeConditionDraft;
}

/** The node types a user can place, with display labels. Order = palette order. */
/** Palette categories, in display order. */
export const NODE_GROUPS = [
  "Triggers",
  "AI & Tools",
  "Data sources",
  "Transform",
  "Flow",
  "Crypto",
  "Comms",
  "Terminal",
] as const;
export type NodeGroup = (typeof NODE_GROUPS)[number];

export const NODE_KINDS: {
  type: NodeType;
  label: string;
  group: NodeGroup;
}[] = [
  { type: "start", label: "Start", group: "Triggers" },
  { type: "webhookTrigger", label: "Webhook", group: "Triggers" },
  { type: "errorTrigger", label: "Error Trigger", group: "Triggers" },
  { type: "agent", label: "Agent", group: "AI & Tools" },
  { type: "mcpTool", label: "MCP Tool", group: "AI & Tools" },
  { type: "httpRequest", label: "HTTP Request", group: "Data sources" },
  { type: "sqlQuery", label: "SQL Query", group: "Data sources" },
  { type: "rssRead", label: "RSS Read", group: "Data sources" },
  { type: "set", label: "Edit Fields", group: "Transform" },
  { type: "renameKeys", label: "Rename Keys", group: "Transform" },
  { type: "filter", label: "Filter", group: "Transform" },
  { type: "aggregate", label: "Aggregate", group: "Transform" },
  { type: "listOps", label: "List Ops", group: "Transform" },
  { type: "compareDatasets", label: "Compare Datasets", group: "Transform" },
  { type: "xml", label: "XML", group: "Transform" },
  { type: "dateTime", label: "Date & Time", group: "Transform" },
  { type: "merge", label: "Merge", group: "Flow" },
  { type: "forEach", label: "For Each", group: "Flow" },
  { type: "executeSubWorkflow", label: "Sub-workflow", group: "Flow" },
  { type: "wait", label: "Wait", group: "Flow" },
  { type: "stopAndError", label: "Stop & Error", group: "Flow" },
  { type: "respondToWebhook", label: "Respond", group: "Flow" },
  { type: "code", label: "Code", group: "Flow" },
  { type: "humanApproval", label: "Approval", group: "Flow" },
  { type: "hmac", label: "HMAC", group: "Crypto" },
  { type: "jwt", label: "JWT", group: "Crypto" },
  { type: "totp", label: "TOTP", group: "Crypto" },
  { type: "sendEmail", label: "Send Email", group: "Comms" },
  { type: "end", label: "End", group: "Terminal" },
];
