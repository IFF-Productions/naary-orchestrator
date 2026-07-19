/**
 * Templates screen derivation model — every chip, chain, badge, and line of teaching
 * copy on the screen derives from the REAL template graphs the API returns
 * (`GET /templates/:key` → GraphDef). The API deliberately carries no presentation
 * metadata beyond name/description, so nothing here invents facts: categories,
 * node chains, approval indicators, "what you'll learn" lines, and the install
 * step cards are all computed from the graph's actual nodes/edges.
 */
import type { GraphDef, NodeType } from "@naary/dsl";
import type { IconName } from "../../../components";
import type { TemplateDetail } from "../../../lib/api";
import { ACCENT, nodeDisplayLabel } from "../../../lib/graph-model";
import { orderedNodes } from "../../../lib/graph-order";

type NodeDef = GraphDef["nodes"][number];

/* ---------------------------------------------------------------- icons */

/**
 * DSL node type → closest glyph in the shared icon set (we must not extend
 * src/components/Icon.tsx from this screen). Anything unmapped falls back to
 * the generic workflow glyph.
 */
const NODE_ICON: Partial<Record<NodeType, IconName>> = {
  start: "play",
  webhookTrigger: "bolt",
  errorTrigger: "alert",
  pollTrigger: "refresh",
  scheduleTrigger: "clock",
  formTrigger: "edit",
  chatTrigger: "activity",
  agent: "agent",
  codeAgent: "agent",
  mcpTool: "mcp",
  integration: "mcp",
  httpRequest: "http",
  graphQL: "http",
  rssRead: "http",
  sqlQuery: "archive",
  sqlExec: "archive",
  sendEmail: "external",
  respondToWebhook: "arrow-left",
  humanApproval: "approval",
  if: "router",
  switch: "router",
  merge: "router",
  filter: "filter",
  wait: "clock",
  code: "edit",
  hmac: "key",
  jwt: "key",
  totp: "key",
  hash: "key",
  random: "key",
  end: "end",
};

export function iconForNode(type: NodeType): IconName {
  return NODE_ICON[type] ?? "workflow";
}

/* ---------------------------------------------------------------- beats */

/** The four-beat loop the hero teaches. Colors are the real node-type accents. */
export const BEATS: {
  name: string;
  sub: string;
  accent: string;
  icon: IconName;
}[] = [
  {
    name: "Trigger",
    sub: "an event starts it",
    accent: "var(--node-trigger)",
    icon: "bolt",
  },
  {
    name: "Run",
    sub: "steps execute",
    accent: "var(--node-mcp)",
    icon: "http",
  },
  {
    name: "Approval",
    sub: "a human decides",
    accent: "var(--node-approval)",
    icon: "approval",
  },
  {
    name: "Done",
    sub: "systems updated",
    accent: "var(--node-http)",
    icon: "check-circle",
  },
];

/* ---------------------------------------------------------------- chain */

/** One step of a template's node chain (the icon strip + preview "The flow" list). */
export interface ChainNode {
  id: string;
  kind: NodeType;
  label: string;
  accent: string;
  icon: IconName;
}

/**
 * The template's real nodes in execution-ish order (same walk the Simple-mode
 * step list uses). The terminal `end` marker is dropped — it carries no
 * information the strip needs.
 */
export function deriveChain(graph: GraphDef): ChainNode[] {
  return orderedNodes(graph)
    .filter((n) => n.type !== "end")
    .map((n) => ({
      id: n.id,
      kind: n.type,
      label: nodeDisplayLabel(n.type, n.config),
      accent: ACCENT[n.type],
      icon: iconForNode(n.type),
    }));
}

/* ---------------------------------------------------------------- categories */

export interface Category {
  id: string;
  name: string;
  accent: string;
  icon: IconName;
}

const CATEGORY_DEFS: Record<string, Category> = {
  github: {
    id: "github",
    name: "GitHub",
    accent: ACCENT.integration,
    icon: "mcp",
  },
  jira: { id: "jira", name: "Jira", accent: ACCENT.integration, icon: "mcp" },
  database: {
    id: "database",
    name: "Database",
    accent: ACCENT.sqlQuery,
    icon: "archive",
  },
  email: {
    id: "email",
    name: "Email",
    accent: ACCENT.sendEmail,
    icon: "external",
  },
  api: {
    id: "api",
    name: "HTTP & APIs",
    accent: ACCENT.httpRequest,
    icon: "http",
  },
  agents: {
    id: "agents",
    name: "Agent basics",
    accent: ACCENT.agent,
    icon: "agent",
  },
};

function nodeTargetsProvider(n: NodeDef, provider: string): boolean {
  const cfg = n.config ?? {};
  if (n.type === "integration") return cfg.provider === provider;
  // The seed graphs point mcpTool nodes at a connection literally named after the
  // provider ("github"/"jira") — the only provider signal the graph data carries.
  if (n.type === "mcpTool") return cfg.connectionId === provider;
  return false;
}

/**
 * A template's category is derived from what its graph actually talks to,
 * by precedence: named provider (GitHub/Jira) → database → email → plain
 * HTTP/API → agent basics. The API stores no category, so this is the honest
 * equivalent of the design's hand-authored categories.
 */
export function categoryFor(graph: GraphDef): Category {
  const nodes = graph.nodes;
  if (nodes.some((n) => nodeTargetsProvider(n, "github")))
    return CATEGORY_DEFS.github;
  if (nodes.some((n) => nodeTargetsProvider(n, "jira")))
    return CATEGORY_DEFS.jira;
  if (nodes.some((n) => n.type === "sqlQuery" || n.type === "sqlExec"))
    return CATEGORY_DEFS.database;
  if (nodes.some((n) => n.type === "sendEmail")) return CATEGORY_DEFS.email;
  if (
    nodes.some(
      (n) =>
        n.type === "httpRequest" ||
        n.type === "graphQL" ||
        n.type === "rssRead",
    )
  )
    return CATEGORY_DEFS.api;
  return CATEGORY_DEFS.agents;
}

/* ---------------------------------------------------------------- view */

export interface TemplateView {
  key: string;
  name: string;
  description: string;
  nodeCount: number;
  graph: GraphDef;
  chain: ChainNode[];
  hasApproval: boolean;
  category: Category;
  /** "What you'll learn" checklist — authored from the graph's real nodes. */
  learn: string[];
}

const TRIGGER_TYPES: ReadonlySet<NodeType> = new Set([
  "start",
  "webhookTrigger",
  "errorTrigger",
  "pollTrigger",
  "scheduleTrigger",
  "formTrigger",
  "chatTrigger",
]);

const TRIGGER_LEARN: Partial<Record<NodeType, string>> = {
  start: "Starting a run manually (or from the API) with the Run button",
  webhookTrigger: "How a webhook trigger turns an inbound event into a run",
  scheduleTrigger: "Running the workflow on a cron schedule",
  formTrigger: "Using a hosted public form as the trigger",
  chatTrigger: "Using a hosted chat message as the trigger",
  pollTrigger: "Polling a URL on an interval as the trigger",
  errorTrigger: "Reacting to another workflow's failure",
};

/** First-occurrence capability sentences, keyed by node type. */
const CAPABILITY_LEARN: [NodeType, (n: NodeDef) => string][] = [
  [
    "agent",
    () => "Prompting an AI agent and mapping its output into the next node",
  ],
  [
    "integration",
    (n) =>
      `Acting on ${nodeDisplayLabel("integration", n.config)} through a native integration connection`,
  ],
  ["mcpTool", () => "Calling an external tool over an MCP connection"],
  [
    "sqlQuery",
    () => "Running a read-only, parameterized query against your database",
  ],
  ["rssRead", () => "Pulling and parsing an RSS/Atom feed"],
  ["httpRequest", () => "Calling an external REST API from a node"],
  ["sendEmail", () => "Sending the result by email through an SMTP connection"],
  [
    "respondToWebhook",
    () => "Returning a synchronous HTTP response to the caller",
  ],
];

function deriveLearn(graph: GraphDef, hasApproval: boolean): string[] {
  const trigger = graph.nodes.find((n) => n.id === graph.startNodeId);
  const out: string[] = [];
  if (trigger) {
    const line = TRIGGER_LEARN[trigger.type];
    if (line) out.push(line);
  }
  for (const [type, phrase] of CAPABILITY_LEARN) {
    const node = graph.nodes.find((n) => n.type === type);
    if (node) out.push(phrase(node));
    if (out.length >= 4) break;
  }
  if (graph.edges.some((e) => e.condition)) {
    out.push("Branching the flow on a node's output");
  }
  if (hasApproval) {
    out.push("A human-approval gate that pauses the run until someone decides");
  }
  return out.slice(0, 5);
}

export function deriveTemplateView(t: TemplateDetail): TemplateView {
  const hasApproval = t.graph.nodes.some((n) => n.type === "humanApproval");
  return {
    key: t.key,
    name: t.name,
    description: t.description,
    nodeCount: t.nodeCount,
    graph: t.graph,
    chain: deriveChain(t.graph),
    hasApproval,
    category: categoryFor(t.graph),
    learn: deriveLearn(t.graph, hasApproval),
  };
}

/** Category filter chips for the gallery, with counts, biggest first ("All" leads). */
export function deriveCategoryChips(
  views: TemplateView[],
): { id: string; name: string; count: number }[] {
  const counts = new Map<string, { name: string; count: number }>();
  for (const v of views) {
    const c = counts.get(v.category.id);
    if (c) c.count += 1;
    else counts.set(v.category.id, { name: v.category.name, count: 1 });
  }
  const chips = [...counts.entries()]
    .map(([id, c]) => ({ id, name: c.name, count: c.count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return [{ id: "all", name: "All", count: views.length }, ...chips];
}

/* ---------------------------------------------------------------- install steps */

/** One card of the install-success "here's what happens when it runs" walkthrough. */
export interface InstallStep {
  tag: string;
  title: string;
  body: string;
  accent: string;
  icon: IconName;
}

/**
 * The staggered TRIGGER → RUN → (APPROVAL) → DONE walkthrough, derived from the
 * installed template's real graph. The APPROVAL beat collapses away when the
 * graph has no humanApproval node (the design does the same).
 */
export function deriveInstallSteps(view: TemplateView): InstallStep[] {
  const trigger = view.chain.find((n) => TRIGGER_TYPES.has(n.kind));
  const work = view.chain.filter(
    (n) => !TRIGGER_TYPES.has(n.kind) && n.kind !== "humanApproval",
  );
  const approval = view.graph.nodes.find((n) => n.type === "humanApproval");
  const workLabels = work.map((n) => n.label);
  const last = workLabels[workLabels.length - 1];

  const steps: InstallStep[] = [];

  const isManual = !trigger || trigger.kind === "start";
  steps.push({
    tag: "TRIGGER",
    title: isManual
      ? "You start it"
      : `A ${trigger.label.toLowerCase()} event fires`,
    body: isManual
      ? "This workflow starts manually — open it and hit Run (or call the API) to kick off a run."
      : trigger.kind === "webhookTrigger"
        ? "An inbound event starts the run — register a webhook endpoint for this workflow and every delivery becomes a run."
        : `The ${trigger.label} trigger starts the run.`,
    accent: "var(--node-trigger)",
    icon: "bolt",
  });

  steps.push({
    tag: "RUN",
    title: "Steps run automatically",
    body:
      workLabels.length > 0
        ? `${workLabels.join(" → ")} execute in order, each node's output feeding the next.`
        : "The graph's nodes execute in order, each node's output feeding the next.",
    accent: "var(--node-mcp)",
    icon: "http",
  });

  if (approval) {
    const cfg = approval.config as { title?: string } | undefined;
    steps.push({
      tag: "APPROVAL",
      title: cfg?.title?.trim() || "A human approves",
      body: "The run pauses durably until a person approves or rejects — it can wait for days and survives restarts.",
      accent: "var(--node-approval)",
      icon: "approval",
    });
  }

  steps.push({
    tag: "DONE",
    title: "The run completes",
    body: last
      ? `After ${last}, the run finishes and records its result — inspect every node's output on the run detail page.`
      : "The run finishes and records its result — inspect every node's output on the run detail page.",
    accent: "var(--node-http)",
    icon: "check-circle",
  });

  return steps;
}

/* ---------------------------------------------------------------- install key */

/**
 * Stable workflowKey from a display name. Mirrors the canvas's fork naming
 * (screens/canvas/flow.tsx `slugify`) — duplicated here because importing that
 * module would pull the whole react-flow chunk into this screen.
 */
export function slugifyName(name: string): string {
  return (
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "workflow"
  );
}

/**
 * The key to install a template under: slug(name), suffixed -2/-3/… if the
 * workspace already has that key — saving under an existing key would silently
 * create a new VERSION of that workflow instead of a fresh install.
 */
export function uniqueWorkflowKey(
  name: string,
  taken: ReadonlySet<string>,
): string {
  const base = slugifyName(name);
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(`${base}-${i}`)) i += 1;
  return `${base}-${i}`;
}
