/**
 * Editor-side graph model. The canvas works in these terms (node positions, edges
 * by source/target) and compiles to the platform `@naary/dsl` GraphDef on save —
 * see compile-graph.ts. Positions are editor-only and don't reach the DSL.
 */
import { INTEGRATION_PROVIDERS, getIntegrationProvider } from "@naary/dsl";
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
  "gte",
  "lte",
  "contains",
  "notContains",
  "startsWith",
  "endsWith",
  "regex",
  "in",
  "exists",
  "isEmpty",
  "notEmpty",
];

/** Operators that take no `value` (the value field is hidden for these). */
export const VALUELESS_OPS: EdgeCondition["op"][] = [
  "exists",
  "isEmpty",
  "notEmpty",
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
  "Integrations",
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

/**
 * Curated palette ORDER for the derived integration tiles (issue #688). Every provider in
 * `INTEGRATION_CATALOG` gets a tile — this list only decides which ones sit at the TOP of the
 * Integrations group (the rail popover and the catalog modal both render tiles in NODE_KINDS
 * order). Providers not named here follow, alphabetically by label, so a new catalog entry
 * lands in a predictable place with NO web-side edit required. `github` MUST stay first:
 * `defaultConfigFor("integration")` resolves the first integration row.
 */
const INTEGRATION_TILE_ORDER: string[] = [
  "github",
  "jira",
  "slack",
  "notion",
  "stripe",
  "linear",
  "gitlab",
  "hubspot",
  "discord",
  "sentry",
  "airtable",
  "asana",
  "sendgrid",
  "zendesk",
];

/**
 * Per-provider tile copy that PREDATES the derivation (the original four hand-listed tiles).
 * Their descriptions + default actions were hand-written for the palette and are kept
 * byte-identical so nothing shifts for existing users: the catalog's own `description` is
 * worded differently and its FIRST action is a read (`get_issue` / `get_page`), whereas these
 * tiles have always defaulted to the common write. Every other provider derives both from the
 * catalog — do NOT add entries here for new providers.
 */
const INTEGRATION_TILE_OVERRIDES: Record<
  string,
  { description: string; action: string }
> = {
  github: {
    description: "Act on GitHub issues — create, comment, label, or read.",
    action: "create_issue",
  },
  jira: {
    description: "Manage Jira tickets — create, comment, transition, or read.",
    action: "create_issue",
  },
  slack: {
    description: "Post to Slack — send a message, reply in a thread, or react.",
    action: "post_message",
  },
  notion: {
    description:
      "Read/write Notion — query a database, create a page, append blocks.",
    action: "create_page",
  },
  // Batch 4 (#684) hand-authored these four tiles on main before this derivation landed.
  // Their copy is better than the catalog's generic `description`, so it's preserved here.
  // googlesheets ALSO needs its action pinned: the catalog's first action is `get_values`
  // (a read), but the tile has always defaulted to the `append_row` write — same trap as
  // github/jira/notion above. mattermost/pagerduty/deepl already lead with their write
  // action, so only their copy is overridden.
  mattermost: {
    description:
      "Post to Mattermost — send a message, reply in a thread, react, or read history.",
    action: "send_message",
  },
  pagerduty: {
    description:
      "Manage PagerDuty incidents — create, acknowledge, resolve, annotate, or read.",
    action: "create_incident",
  },
  googlesheets: {
    description:
      "Read and write a Google Sheet — append rows, read a range, update or clear values.",
    action: "append_row",
  },
  deepl: {
    description:
      "Translate text with DeepL — translate, check quota usage, list languages.",
    action: "translate_text",
  },
};

/**
 * The Integrations palette rows, DERIVED from the DSL provider catalog (issue #688): label,
 * description and the default action all come from the provider itself, so adding a provider
 * to `INTEGRATION_CATALOG` automatically yields a palette tile (previously these four rows
 * were hand-listed, which left ~30 shipped providers unreachable from the canvas).
 */
export const INTEGRATION_NODE_KINDS: NodeKind[] = [...INTEGRATION_PROVIDERS]
  .sort((a, b) => {
    const ia = INTEGRATION_TILE_ORDER.indexOf(a.key);
    const ib = INTEGRATION_TILE_ORDER.indexOf(b.key);
    if (ia !== -1 || ib !== -1) {
      // Curated providers first, in curated order; everything else after them.
      if (ia === -1) return 1;
      if (ib === -1) return -1;
      return ia - ib;
    }
    // Explicit locale: the tail order must not depend on the browser's locale.
    return a.label.localeCompare(b.label, "en");
  })
  .map((p) => {
    const override = INTEGRATION_TILE_OVERRIDES[p.key];
    return {
      type: "integration" as const,
      label: p.label,
      group: "Integrations" as const,
      accent: "var(--node-mcp)",
      description: override?.description ?? p.description,
      defaultConfig: {
        provider: p.key,
        action: override?.action ?? p.actions[0]?.key ?? "",
        connectionId: "",
        fields: {},
      },
    };
  });

// prettier-ignore
export const NODE_KINDS: NodeKind[] = [
  { type: "start", label: "Start", group: "Triggers", accent: "var(--node-trigger)",
    description: "Starts the workflow when you run it or on a schedule." },
  { type: "webhookTrigger", label: "Webhook", group: "Triggers", accent: "var(--node-trigger)",
    description: "Starts the workflow when an external service calls its webhook URL." },
  { type: "errorTrigger", label: "Error Trigger", group: "Triggers", accent: "var(--node-error, #d6584f)",
    description: "Entry point for an error-handler workflow; runs when another flow fails." },
  { type: "pollTrigger", label: "Poll", group: "Triggers", accent: "var(--node-poll, #4f9ad6)",
    description: "Check a URL on a set interval; only continue when the result changed.",
    defaultConfig: { url: "https://api.example.com/resource", intervalSeconds: 300 } },
  { type: "scheduleTrigger", label: "Schedule", group: "Triggers", accent: "var(--node-schedule, #5b8def)",
    description: "Run the workflow on a cron schedule (e.g. every weekday at 9am).",
    defaultConfig: { cron: "0 9 * * 1-5" } },
  { type: "formTrigger", label: "Form", group: "Triggers", accent: "var(--node-trigger)",
    description: "Start from a hosted public form — the submitted fields become the trigger data.",
    defaultConfig: { fields: [] } },
  { type: "chatTrigger", label: "Chat", group: "Triggers", accent: "var(--node-trigger)",
    description: "Start from a hosted chat — the message + sessionId become the trigger data.",
    defaultConfig: {} },
  { type: "mcpServerTrigger", label: "MCP Server", group: "Triggers", accent: "var(--node-trigger)",
    description: "Host this workflow as a tool on naary's MCP server — an external AI agent invokes it to start a run.",
    defaultConfig: {} },
  { type: "agent", label: "Agent", group: "AI & Tools", accent: "var(--node-agent)",
    description: "Ask an AI model to work with the data — summarize, classify, or draft.",
    defaultConfig: { provider: "anthropic", model: "claude-opus-4-8", systemPrompt: "You are a helpful assistant. Summarize the input in one paragraph." } },
  { type: "codeAgent", label: "Code Agent", group: "AI & Tools", accent: "var(--node-agent)",
    description: "Run an agentic coding CLI (Claude Code) on a task — reads code and returns a plan (read-only).",
    defaultConfig: { tool: "claude", prompt: "" } },
  { type: "mcpTool", label: "MCP Tool", group: "AI & Tools", accent: "var(--node-mcp)",
    description: "Call a tool on a connected service (e.g. GitHub, Jira) via MCP.",
    defaultConfig: { connectionId: "", tool: "" } },
  // One tile per INTEGRATION_CATALOG provider, derived above (#688) — never hand-list these.
  ...INTEGRATION_NODE_KINDS,
  { type: "httpRequest", label: "HTTP Request", group: "Data sources", accent: "var(--node-http, #2f9e8f)",
    description: "Call any REST API and use the response in later steps.",
    defaultConfig: { method: "GET", url: "https://api.example.com/resource" } },
  { type: "graphQL", label: "GraphQL", group: "Data sources", accent: "var(--node-graphql, #e535ab)",
    description: "Query a GraphQL API — the response data is available to later steps.",
    defaultConfig: { url: "https://api.example.com/graphql", query: "query {\n  __typename\n}" } },
  { type: "sqlQuery", label: "SQL Query", group: "Data sources", accent: "var(--node-sql, #b06fd6)",
    description: "Run a read-only query against your database.",
    defaultConfig: { connectionId: "", sql: "SELECT 1" } },
  { type: "sqlExec", label: "SQL Write", group: "Data sources", accent: "var(--node-sqlexec, #c05fa6)",
    description: "Write to your database (INSERT/UPDATE/DELETE) in a transaction.",
    defaultConfig: { connectionId: "", sql: "UPDATE users SET seen = true WHERE id = $1" } },
  { type: "rssRead", label: "RSS Read", group: "Data sources", accent: "var(--node-rss, #d98a5a)",
    description: "Fetch and parse an RSS/Atom feed into a list of items.",
    defaultConfig: { url: "https://hnrss.org/frontpage" } },
  { type: "set", label: "Edit Fields", group: "Transform", accent: "var(--node-set, #d98a3d)",
    description: "Build or reshape an object from fixed values and upstream data.",
    defaultConfig: { fields: {} } },
  { type: "renameKeys", label: "Rename Keys", group: "Transform", accent: "var(--node-rename, #c9803e)",
    description: "Rename or drop fields on an object." },
  { type: "text", label: "Text", group: "Transform", accent: "var(--node-text, #c98f5a)",
    description: "Transform a string — case, trim, split, replace, or regex extract.",
    defaultConfig: { operation: "trim", from: "" } },
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
  { type: "htmlExtract", label: "HTML Extract", group: "Transform", accent: "var(--node-htmlx, #a07050)",
    description: "Pull text or attributes out of HTML using CSS selectors.",
    defaultConfig: { from: "", extractions: [{ key: "title", selector: "h1", return: "text" }] } },
  { type: "vectorUpsert", label: "Vector Upsert", group: "Data sources", accent: "var(--node-agent)",
    description: "RAG: embed text chunk(s) and store them in the tenant vector store.",
    defaultConfig: { collection: "docs", from: "" } },
  { type: "vectorQuery", label: "Vector Query", group: "Data sources", accent: "var(--node-agent)",
    description: "RAG: embed a query and return the top-k nearest stored chunks.",
    defaultConfig: { collection: "docs", from: "", topK: 4 } },
  { type: "markdown", label: "Markdown", group: "Transform", accent: "var(--node-htmlx, #a07050)",
    description: "Convert an HTML string to Markdown.",
    defaultConfig: { from: "" } },
  { type: "noOp", label: "No-op", group: "Flow", accent: "var(--node-merge, #3fae86)",
    description: "Does nothing; a structural / placeholder node.",
    defaultConfig: {} },
  { type: "splitOut", label: "Split Out", group: "Flow", accent: "var(--node-merge, #3fae86)",
    description: "Run the linear region up to Loop End once per array item.",
    defaultConfig: { from: "" } },
  { type: "loopEnd", label: "Loop End", group: "Flow", accent: "var(--node-merge, #3fae86)",
    description: "Close a Split Out region — collect the per-item outputs into an array.",
    defaultConfig: { from: "" } },
  { type: "csv", label: "CSV", group: "Transform", accent: "var(--node-csv, #4f9e6f)",
    description: "Parse CSV text into rows, or build CSV from a list.",
    defaultConfig: { operation: "parse", from: "", header: true } },
  { type: "json", label: "JSON", group: "Transform", accent: "var(--node-json, #6f9e5a)",
    description: "Parse a JSON string into data, or stringify data to JSON.",
    defaultConfig: { operation: "parse", from: "" } },
  { type: "number", label: "Math", group: "Transform", accent: "var(--node-number, #b0863e)",
    description: "Do arithmetic — add, subtract, multiply, divide, round.",
    defaultConfig: { operation: "add" } },
  { type: "encode", label: "Encode", group: "Transform", accent: "var(--node-encode, #7f8f9f)",
    description: "Encode or decode a string — base64, hex, or URL-encoding.",
    defaultConfig: { operation: "base64Encode", from: "" } },
  { type: "dateTime", label: "Date & Time", group: "Transform", accent: "var(--node-datetime, #6f8fd6)",
    description: "Get the current time or do date math.",
    defaultConfig: { source: "now" } },
  { type: "merge", label: "Merge", group: "Flow", accent: "var(--node-merge, #3fae86)",
    description: "Wait for several branches to finish, then combine their results.",
    defaultConfig: { mode: "array" } },
  { type: "if", label: "IF", group: "Flow", accent: "var(--node-if, #4f9ad6)",
    description: "True/false gate — combine conditions with AND/OR, then branch.",
    defaultConfig: { combine: "and", conditions: [{ path: "", op: "eq", value: "" }] } },
  { type: "switch", label: "Switch", group: "Flow", accent: "var(--node-switch, #d69a4f)",
    description: "Route to a branch based on the first rule that matches.",
    defaultConfig: { rules: [{ name: "match", condition: { path: "", op: "eq", value: "" } }], fallback: "default" } },
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
  { type: "hash", label: "Hash", group: "Crypto", accent: "var(--node-hash, #8f7fd6)",
    description: "One-way digest of a value (SHA-256/512, MD5) — no key needed.",
    defaultConfig: { algorithm: "sha256", encoding: "hex" } },
  { type: "random", label: "Random", group: "Crypto", accent: "var(--node-random, #6f8fd6)",
    description: "Generate a random value — UUID, hex, base64, or a number.",
    defaultConfig: { operation: "uuid" } },
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

/**
 * The label to SHOW on a node — provider-aware. Every integration tile (GitHub, Jira,
 * Slack, Notion, …) shares the DSL type `"integration"`, so NODE_LABEL["integration"]
 * collapses to whichever tile was registered LAST ("Notion"). Rendering that verbatim
 * mislabels every integration node. This resolves the real provider from the node's
 * config so a GitHub node reads "GitHub". Use this at EVERY node render site (canvas,
 * workflow detail, run view) — NODE_LABEL[type] alone is wrong for integrations.
 */
export function nodeDisplayLabel(
  type: NodeType,
  config?: Record<string, unknown> | null,
): string {
  // A user-set custom name (config-space `__name`, lifted to NodeDef.name on save) wins over the
  // derived type label — so a renamed node reads the same on the canvas, the inspector, and runs.
  const custom = (config as { __name?: unknown } | undefined)?.__name;
  if (typeof custom === "string" && custom.trim()) return custom.trim();
  if (type === "integration") {
    return getIntegrationProvider(providerKey(config))?.label ?? "Integration";
  }
  return NODE_LABEL[type];
}

/**
 * The `provider` key out of a node's config, defensively. `config` is
 * `Record<string, unknown>` — a hand-edited, AI-generated, or legacy graph can carry
 * `provider: 123` (or an object), and asserting `{provider?: string}` then calling `.trim()`
 * THROWS at render time and blanks the config panel / canvas label. Mirrors the `typeof`
 * guard `nodeDisplayLabel` already uses for `__name`. Non-strings resolve to "" → the
 * generic "Integration" label + catalog-fallback description, which is the right degrade.
 */
function providerKey(config?: Record<string, unknown> | null): string {
  const raw = config?.provider;
  return typeof raw === "string" ? raw.trim() : "";
}

/** DSL node type → plain-language description, derived from the one registry. */
export const NODE_DESCRIPTION = Object.fromEntries(
  NODE_KINDS.map((k) => [k.type, k.description]),
) as Record<NodeType, string>;

/** Provider key → that integration tile's description (the palette copy, so the four
 *  hand-written overrides win over the catalog's generic wording). */
const INTEGRATION_TILE_DESCRIPTION: Record<string, string> = Object.fromEntries(
  INTEGRATION_NODE_KINDS.map((k) => [
    String(k.defaultConfig?.provider ?? ""),
    k.description,
  ]),
);

/**
 * The description to SHOW for a node — provider-aware, for the same reason as
 * `nodeDisplayLabel`: every integration tile shares the type `"integration"`, so
 * `NODE_DESCRIPTION["integration"]` collapses to whichever tile is LAST in the registry.
 * Rendering that verbatim describes the wrong provider. Use this at description render
 * sites (config panel) — NODE_DESCRIPTION[type] alone is wrong for integrations.
 */
export function nodeDisplayDescription(
  type: NodeType,
  config?: Record<string, unknown> | null,
): string {
  if (type === "integration") {
    const provider = providerKey(config);
    return (
      INTEGRATION_TILE_DESCRIPTION[provider] ??
      getIntegrationProvider(provider)?.description ??
      "Call a connected service's API (provider + action from the catalog)."
    );
  }
  return NODE_DESCRIPTION[type];
}

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
  if (kind === "codeAgent") {
    const tool = (config.tool as string | undefined) ?? "claude";
    return `${tool} · read-only`;
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
  if (kind === "graphQL") {
    const url = config.url as string | undefined;
    if (!url) return "POST";
    return `POST ${url.replace(/^https?:\/\//, "")}`;
  }
  if (kind === "sqlQuery" || kind === "sqlExec") {
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
  if (kind === "pollTrigger") {
    const secs = config.intervalSeconds as number | undefined;
    const url = config.url as string | undefined;
    const host = url ? url.replace(/^https?:\/\//, "").slice(0, 22) : undefined;
    const every = secs ? `every ${secs}s` : undefined;
    return [every, host].filter(Boolean).join(" · ") || undefined;
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
