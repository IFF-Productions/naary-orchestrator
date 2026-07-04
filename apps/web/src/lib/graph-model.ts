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

/**
 * The single node-type registry (audit A-1). One row per DSL node type carries all
 * its editor-display metadata — palette label + group, theme accent — so the canvas,
 * the read-only run view, and the design-system page derive from ONE source and can't
 * drift (they previously kept parallel `ACCENT` maps + subtitle functions that had
 * already diverged). `accent` is a CSS custom property with a hex fallback.
 * Row order = palette order.
 */
export interface NodeKind {
  type: NodeType;
  label: string;
  group: NodeGroup;
  accent: string;
  /** One-line, plain-language description shown in the palette + config panel. */
  description: string;
  /** Working example config a freshly-placed node starts with, so a non-technical
   *  user sees filled-in fields instead of blanks. Omitted = no config. */
  defaultConfig?: Record<string, unknown>;
}

// prettier-ignore
export const NODE_KINDS: NodeKind[] = [
  { type: "start", label: "Start", group: "Triggers", accent: "var(--node-trigger)",
    description: "Starts the workflow when you run it or on a schedule." },
  { type: "webhookTrigger", label: "Webhook", group: "Triggers", accent: "var(--node-trigger)",
    description: "Starts the workflow when an external service calls its webhook URL." },
  { type: "errorTrigger", label: "Error Trigger", group: "Triggers", accent: "var(--node-error, #d6584f)",
    description: "Entry point for an error-handler workflow; runs when another flow fails." },
  { type: "agent", label: "Agent", group: "AI & Tools", accent: "var(--node-agent)",
    description: "Ask an AI model to work with the data — summarize, classify, or draft.",
    defaultConfig: { provider: "anthropic", model: "claude-opus-4-8", systemPrompt: "You are a helpful assistant. Summarize the input in one paragraph." } },
  { type: "mcpTool", label: "MCP Tool", group: "AI & Tools", accent: "var(--node-mcp)",
    description: "Call a tool on a connected service (e.g. GitHub, Jira) via MCP.",
    defaultConfig: { connectionId: "", tool: "" } },
  { type: "httpRequest", label: "HTTP Request", group: "Data sources", accent: "var(--node-http, #2f9e8f)",
    description: "Call any REST API and use the response in later steps.",
    defaultConfig: { method: "GET", url: "https://api.example.com/resource" } },
  { type: "sqlQuery", label: "SQL Query", group: "Data sources", accent: "var(--node-sql, #b06fd6)",
    description: "Run a read-only query against your database.",
    defaultConfig: { connectionId: "", sql: "SELECT 1" } },
  { type: "rssRead", label: "RSS Read", group: "Data sources", accent: "var(--node-rss, #d98a5a)",
    description: "Fetch and parse an RSS/Atom feed into a list of items.",
    defaultConfig: { url: "https://hnrss.org/frontpage" } },
  { type: "set", label: "Edit Fields", group: "Transform", accent: "var(--node-set, #d98a3d)",
    description: "Build or reshape an object from fixed values and upstream data.",
    defaultConfig: { fields: {} } },
  { type: "renameKeys", label: "Rename Keys", group: "Transform", accent: "var(--node-rename, #c9803e)",
    description: "Rename or drop fields on an object." },
  { type: "filter", label: "Filter", group: "Transform", accent: "var(--node-filter, #3f9e8f)",
    description: "Keep only the array items that match a condition." },
  { type: "aggregate", label: "Aggregate", group: "Transform", accent: "var(--node-aggregate, #b0863e)",
    description: "Collapse an array — count, sum, first, last, or collect.",
    defaultConfig: { operation: "collect" } },
  { type: "listOps", label: "List Ops", group: "Transform", accent: "var(--node-listops, #4f9e7f)",
    description: "Sort, limit, or de-duplicate an array." },
  { type: "compareDatasets", label: "Compare Datasets", group: "Transform", accent: "var(--node-compare, #7f8f4f)",
    description: "Diff two lists by a key — what was added, removed, or changed." },
  { type: "xml", label: "XML", group: "Transform", accent: "var(--node-xml, #8f6f4f)",
    description: "Convert XML to data, or data to XML.",
    defaultConfig: { operation: "parse" } },
  { type: "dateTime", label: "Date & Time", group: "Transform", accent: "var(--node-datetime, #6f8fd6)",
    description: "Get the current time or do date math.",
    defaultConfig: { source: "now" } },
  { type: "merge", label: "Merge", group: "Flow", accent: "var(--node-merge, #3fae86)",
    description: "Wait for several branches to finish, then combine their results.",
    defaultConfig: { mode: "array" } },
  { type: "forEach", label: "For Each", group: "Flow", accent: "var(--node-foreach, #5b6fd6)",
    description: "Run a saved workflow once for each item in a list.",
    defaultConfig: { workflowKey: "" } },
  { type: "executeSubWorkflow", label: "Sub-workflow", group: "Flow", accent: "var(--node-subflow, #5b8def)",
    description: "Run another saved workflow and use its result.",
    defaultConfig: { workflowKey: "" } },
  { type: "wait", label: "Wait", group: "Flow", accent: "var(--node-wait, #8a8f98)",
    description: "Pause the workflow for a set time — survives restarts.",
    defaultConfig: { durationSeconds: 60 } },
  { type: "stopAndError", label: "Stop & Error", group: "Flow", accent: "var(--node-error, #d6584f)",
    description: "Stop the workflow and mark the run failed.",
    defaultConfig: { message: "Stopped by the workflow" } },
  { type: "respondToWebhook", label: "Respond", group: "Flow", accent: "var(--node-respond, #3f8fae)",
    description: "Send an HTTP response back to the webhook caller.",
    defaultConfig: { statusCode: 200 } },
  { type: "code", label: "Code", group: "Flow", accent: "var(--node-code, #6f7a8f)",
    description: "Run a small piece of sandboxed JavaScript.",
    defaultConfig: { code: "return input;" } },
  { type: "humanApproval", label: "Approval", group: "Flow", accent: "var(--node-approval)",
    description: "Pause until a person approves or rejects — can wait for days.",
    defaultConfig: { title: "Approve this step", instructions: "" } },
  { type: "hmac", label: "HMAC", group: "Crypto", accent: "var(--node-hmac, #a86fd6)",
    description: "Sign data with a secret key (HMAC).",
    defaultConfig: { connectionId: "" } },
  { type: "jwt", label: "JWT", group: "Crypto", accent: "var(--node-jwt, #7a6fd6)",
    description: "Create a signed JWT token.",
    defaultConfig: { connectionId: "" } },
  { type: "totp", label: "TOTP", group: "Crypto", accent: "var(--node-totp, #9a6fc6)",
    description: "Generate a one-time passcode (TOTP).",
    defaultConfig: { connectionId: "" } },
  { type: "sendEmail", label: "Send Email", group: "Comms", accent: "var(--node-email, #4f9ad6)",
    description: "Send an email through an SMTP connection.",
    defaultConfig: { connectionId: "", subject: "" } },
  { type: "end", label: "End", group: "Terminal", accent: "var(--node-end)",
    description: "Marks the end of the workflow." },
];

/** DSL node type → theme accent color, derived from the one registry above. */
export const ACCENT = Object.fromEntries(
  NODE_KINDS.map((k) => [k.type, k.accent]),
) as Record<NodeType, string>;

/** DSL node type → palette label, derived from the one registry above. */
export const NODE_LABEL = Object.fromEntries(
  NODE_KINDS.map((k) => [k.type, k.label]),
) as Record<NodeType, string>;

/** DSL node type → plain-language description, derived from the one registry. */
export const NODE_DESCRIPTION = Object.fromEntries(
  NODE_KINDS.map((k) => [k.type, k.description]),
) as Record<NodeType, string>;

/** A fresh copy of the working example config a newly-placed node starts with
 *  (undefined = no config). Copied so canvas edits never mutate the registry. */
export function defaultConfigFor(
  type: NodeType,
): Record<string, unknown> | undefined {
  const dc = NODE_KINDS.find((k) => k.type === type)?.defaultConfig;
  return dc ? structuredClone(dc) : undefined;
}

/**
 * One-line node subtitle for the canvas + run view (a compact echo of the node's
 * config). Single source so the editor and the read-only view render identically.
 * Returns undefined when there's nothing worth showing.
 */
export function nodeSubtitle(
  kind: NodeType,
  config?: Record<string, unknown>,
): string | undefined {
  if (!config) return undefined;
  if (kind === "agent") {
    const model = config.model as string | undefined;
    return model ? model.replace("claude-", "") : undefined;
  }
  if (kind === "mcpTool") {
    const tool = config.tool as string | undefined;
    const conn = config.connectionId as string | undefined;
    if (tool && conn) return `${conn} · ${tool}`;
    return tool || conn || undefined;
  }
  if (kind === "httpRequest") {
    const method = (config.method as string | undefined) ?? "GET";
    const url = config.url as string | undefined;
    if (!url) return method;
    const short = url.replace(/^https?:\/\//, "");
    return `${method} ${short}`;
  }
  if (kind === "sqlQuery") {
    const conn = config.connectionId as string | undefined;
    const sql = config.sql as string | undefined;
    const snippet = sql
      ? sql.replace(/\s+/g, " ").trim().slice(0, 32)
      : undefined;
    if (conn && snippet) return `${conn} · ${snippet}`;
    return conn || snippet || undefined;
  }
  if (kind === "set") {
    const fields = (config.fields as Record<string, unknown> | undefined) ?? {};
    const binds =
      (config.fieldBindings as Record<string, unknown> | undefined) ?? {};
    const keys = new Set([...Object.keys(fields), ...Object.keys(binds)]);
    const n = keys.size;
    return n ? `${n} field${n === 1 ? "" : "s"}` : undefined;
  }
  if (kind === "merge") {
    const mode = (config.mode as string | undefined) ?? "array";
    return `join · ${mode}`;
  }
  if (kind === "renameKeys") {
    const from = config.from as string | undefined;
    return from ? `from ${from}` : undefined;
  }
  if (kind === "filter") {
    const c = config.condition as { path?: string; op?: string } | undefined;
    return c?.path ? `${c.path} ${c.op ?? ""}`.trim() : undefined;
  }
  if (kind === "aggregate" || kind === "listOps" || kind === "xml") {
    const op = config.operation as string | undefined;
    return op || undefined;
  }
  if (kind === "compareDatasets") {
    const k = config.key as string | undefined;
    return k ? `by ${k}` : undefined;
  }
  if (kind === "dateTime") {
    const src = config.source;
    return src && src !== "now" ? "from upstream" : "now";
  }
  if (kind === "hmac" || kind === "jwt" || kind === "totp") {
    const conn = config.connectionId as string | undefined;
    return conn || undefined;
  }
  if (kind === "sendEmail") {
    const to = config.to as string | undefined;
    return to ? `→ ${to}` : (config.connectionId as string | undefined);
  }
  if (kind === "rssRead") {
    const url = config.url as string | undefined;
    return url ? url.replace(/^https?:\/\//, "").slice(0, 32) : undefined;
  }
  if (kind === "executeSubWorkflow") {
    const key = config.workflowKey as string | undefined;
    return key ? `↳ ${key}` : undefined;
  }
  if (kind === "forEach") {
    const key = config.workflowKey as string | undefined;
    return key ? `⟳ ${key}` : undefined;
  }
  if (kind === "wait") {
    const secs = config.durationSeconds as number | undefined;
    return secs && secs > 0 ? `${secs}s` : undefined;
  }
  if (kind === "stopAndError") {
    const msg = config.message as string | undefined;
    return msg ? msg.slice(0, 32) : undefined;
  }
  if (kind === "respondToWebhook") {
    return `HTTP ${(config.statusCode as number | undefined) ?? 200}`;
  }
  if (kind === "code") {
    const c = config.code as string | undefined;
    if (!c) return "JS";
    const lines = c.split("\n").length;
    return `JS · ${lines} line${lines === 1 ? "" : "s"}`;
  }
  return undefined;
}
