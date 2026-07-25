/**
 * Templates screen derivation model — every chip, chain, badge, and line of teaching
 * copy on the screen derives from real data: the catalog metadata the API returns
 * (`GET /templates` → key/name/description/category/tags) plus each template's REAL
 * graph (`GET /templates/:key` → GraphDef). Nothing here invents facts: the category is
 * the API's (with a graph-derived fallback for an API that predates the field), and node
 * chains, approval indicators, "what you'll learn" lines, the required-connection
 * checklist, and the install step cards are computed from the graph's actual nodes/edges.
 */
import type { GraphDef, NodeType } from "@naary/dsl";
import { getIntegrationProvider } from "@naary/dsl";
import type { IconName } from "../../../components";
import type {
  ConnectionRow,
  ConnectionType,
  TemplateDetail,
} from "../../../lib/api";
import {
  CONNECTION_TYPES,
  integrationsTabFor,
} from "../../../lib/connection-types";
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
  textToSpeech: "activity",
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
 * FALLBACK ONLY (#574): a category derived from what the graph actually talks to, by
 * precedence: named provider (GitHub/Jira) → database → email → plain HTTP/API → agent
 * basics. The API now ships a real `category`, so this is used only when a template
 * carries none — i.e. an API deployed before the field existed.
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

/** Title-cases an unrecognized server category id ("code-review" → "Code review"). */
function humanizeCategoryId(id: string): string {
  const words = id.replace(/[-_]+/g, " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : id;
}

/**
 * The category to display for a template: the API's `category` id mapped to its
 * presentation (label/accent/icon), falling back to the graph-derived category when the
 * API sends none. An id the API knows but this bundle doesn't (newer API, older SPA) is
 * shown humanized with neutral agent styling rather than crashing on a missing def —
 * still the SERVER's taxonomy, just without local styling for it.
 */
export function resolveCategory(
  serverCategory: string | undefined,
  graph: GraphDef,
): Category {
  const id = serverCategory?.trim();
  if (!id) return categoryFor(graph);
  const known = CATEGORY_DEFS[id];
  if (known) return known;
  return {
    id,
    name: humanizeCategoryId(id),
    accent: ACCENT.agent,
    icon: "workflow",
  };
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
  /** The API's use-case tags (`GET /templates`); `[]` when it sends none. Searched. */
  tags: string[];
  /** "What you'll learn" checklist — authored from the graph's real nodes. */
  learn: string[];
  /** Connections the graph's nodes need before a run can work (#574). */
  requirements: ConnectionRequirement[];
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
    category: resolveCategory(t.category, t.graph),
    tags: t.tags ?? [],
    learn: deriveLearn(t.graph, hasApproval),
    requirements: deriveConnectionRequirements(t.graph),
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

/* ------------------------------------------------- connection requirements */

/**
 * One connection a template's graph needs before a run can actually work — the unit of
 * the post-import setup checklist (#574 AC: "Import of a template requiring a connection
 * the workspace lacks shows a setup checklist instead of a broken run").
 */
export interface ConnectionRequirement {
  /** Stable id — also the dedupe key, so two sendEmail nodes are ONE row. */
  id: string;
  /** What must be connected, in the user's words ("GitHub", "Email (SMTP)"). */
  label: string;
  /** Connection types that satisfy it — matched against `ConnectionRow.type`. */
  types: ConnectionType[];
  /** Why the graph needs it, naming the real nodes involved. */
  reason: string;
  /** Integrations tab that hosts the connect form (drives the CTA's deep link). */
  tab: "apps" | "providers";
  /** Ids of the template's nodes that need it. */
  nodeIds: string[];
}

/**
 * Node types whose `connectionId` the registry marks OPTIONAL: they only need a connection
 * when the template's config actually pins one (httpRequest against a public API needs
 * none; codeAgent only clones through a GitHub App in write mode). Every other entry in
 * CONNECTION_TYPES has a required `connectionId`, so its mere presence is a requirement.
 * Mirrors the canvas's own resource check (useCanvasDerivations skips httpRequest).
 */
const OPTIONAL_CONNECTION_NODES: ReadonlySet<string> = new Set([
  "httpRequest",
  "codeAgent",
]);

/**
 * `integration` node `provider` → the connection types that can actually authorize it.
 * Deliberately NARROWER than CONNECTION_TYPES.integration (which offers all three app
 * types for any provider, because the canvas can't stop you picking a wrong one): a
 * checklist's entire value is naming the RIGHT provider, and a Jira call cannot run on a
 * GitHub connection.
 *
 * Every other catalog provider (Slack, Notion, GitLab, …) has no dedicated connection
 * type, so it is connected as a `custom` one — hence the fallback below. That trades a
 * possible false MISSING (someone filed a Slack token under a github/atlassian
 * connection) for never reporting a false SATISFIED, which is the direction that would
 * actually mislead. No shipped template uses those providers today.
 */
const INTEGRATION_CONNECTION_TYPES: Record<string, ConnectionType[]> = {
  github: ["github"],
  jira: ["atlassian"],
};
const DEFAULT_INTEGRATION_CONNECTION_TYPES: ConnectionType[] = ["custom"];

const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;

/** How each connection-consuming node type reads in the checklist. */
function requirementFor(
  n: NodeDef,
): Omit<ConnectionRequirement, "nodeIds" | "reason" | "tab"> | null {
  switch (n.type) {
    case "integration": {
      const provider =
        typeof n.config?.provider === "string" ? n.config.provider : "";
      if (!provider) return null;
      // Human-readable name comes from the DSL's integration catalog — the same source
      // the palette and config panel label the provider with.
      const label = getIntegrationProvider(provider)?.label ?? provider;
      return {
        id: `integration:${provider}`,
        label,
        types:
          INTEGRATION_CONNECTION_TYPES[provider] ??
          DEFAULT_INTEGRATION_CONNECTION_TYPES,
      };
    }
    case "mcpTool":
      return {
        id: "mcp",
        label: "MCP tool server",
        types: CONNECTION_TYPES.mcpTool,
      };
    case "sqlQuery":
    case "sqlExec":
      return {
        id: "database",
        label: "SQL database",
        types: CONNECTION_TYPES.sqlQuery,
      };
    case "sendEmail":
      return {
        id: "smtp",
        label: "Email (SMTP)",
        types: CONNECTION_TYPES.sendEmail,
      };
    case "hmac":
    case "jwt":
    case "totp":
      // Read the types from the canonical map like every other case — the three signing
      // node types all map to ["signing"] there, so hardcoding it here would silently drift
      // if that ever changes (Copilot review).
      return {
        id: "signing",
        label: "Signing key",
        types: CONNECTION_TYPES[n.type],
      };
    case "httpRequest":
      return {
        id: "http-auth",
        label: "HTTP API credential",
        types: CONNECTION_TYPES.httpRequest,
      };
    case "codeAgent":
      return {
        id: "code-agent-github",
        label: "GitHub (code agent)",
        types: CONNECTION_TYPES.codeAgent,
      };
    default:
      return null;
  }
}

/** One-line "why", per requirement id, given how many of the graph's nodes want it. */
function reasonFor(id: string, label: string, count: number): string {
  switch (id) {
    case "mcp":
      return `${plural(count, "node calls", "nodes call")} a remote tool over an MCP connection.`;
    case "database":
      return `${plural(count, "node runs", "nodes run")} SQL against it.`;
    case "smtp":
      return `${plural(count, "node sends", "nodes send")} mail through it.`;
    case "signing":
      return `${plural(count, "node signs", "nodes sign")} a payload or mints a token with its secret.`;
    case "http-auth":
      return `${plural(count, "node authenticates", "nodes authenticate")} its outbound request with it.`;
    case "code-agent-github":
      return `${plural(count, "node clones", "nodes clone")} the repo and opens a pull request with it.`;
    default:
      return `${plural(count, "node calls", "nodes call")} the ${label} API through it.`;
  }
}

/**
 * Connections the template's graph needs, derived from its REAL nodes — never from the
 * placeholder `connectionId` strings the seed graphs carry (`"smtp"`, `"app-db"`,
 * `"github"` are edit-me placeholders, not real workspace ids, so matching on them would
 * report every requirement missing every time). One row per distinct requirement, in
 * first-appearance order.
 */
export function deriveConnectionRequirements(
  graph: GraphDef,
): ConnectionRequirement[] {
  const byId = new Map<string, ConnectionRequirement>();

  const add = (
    base: Omit<ConnectionRequirement, "nodeIds" | "reason" | "tab">,
    nodeId: string,
  ) => {
    const existing = byId.get(base.id);
    if (existing) {
      if (!existing.nodeIds.includes(nodeId)) existing.nodeIds.push(nodeId);
      return;
    }
    byId.set(base.id, {
      ...base,
      nodeIds: [nodeId],
      reason: "",
      // The first satisfying type decides the tab; every type in a requirement's set lives
      // on the same Integrations tab today (app types vs provider types never mix).
      tab: integrationsTabFor(base.types[0]),
    });
  };

  for (const n of graph.nodes) {
    const cfg = (n.config ?? {}) as Record<string, unknown>;

    // An agent may call MCP tools mid-reasoning; each tool authenticates through a tenant
    // MCP connection, so a tools[] entry is a real requirement even though the agent node
    // itself carries no connectionId.
    if (
      n.type === "agent" &&
      Array.isArray(cfg.tools) &&
      cfg.tools.length > 0
    ) {
      add(
        {
          id: "mcp",
          label: "MCP tool server",
          types: CONNECTION_TYPES.mcpTool,
        },
        n.id,
      );
    }

    if (
      OPTIONAL_CONNECTION_NODES.has(n.type) &&
      !(typeof cfg.connectionId === "string" && cfg.connectionId.trim())
    ) {
      continue; // optional and unset — the node runs without a connection
    }

    const base = requirementFor(n);
    if (base) add(base, n.id);
  }

  return [...byId.values()].map((r) => ({
    ...r,
    reason: reasonFor(r.id, r.label, r.nodeIds.length),
  }));
}

/**
 * Whether the workspace already satisfies a requirement.
 * - `satisfied`  — a healthy connection of an acceptable type exists.
 * - `unhealthy`  — one exists but is `needs_reauth`/`error`: it does NOT satisfy the
 *   requirement, and the fix is repairing THAT one, not creating another.
 * - `missing`    — the workspace has no connection of an acceptable type at all.
 */
export type RequirementStatus = "satisfied" | "unhealthy" | "missing";

export interface CheckedRequirement extends ConnectionRequirement {
  status: RequirementStatus;
  /** Label of the workspace connection that matched (satisfied / unhealthy only). */
  connectionLabel?: string;
  /** That connection's real status — so the UI reports what it actually is (a
   *  `needs_reauth` and an `error` connection are both unhealthy but read differently). */
  connectionStatus?: ConnectionRow["status"];
}

/**
 * Cross-references the requirements against the workspace's REAL connections, matched by
 * TYPE (see deriveConnectionRequirements on why not by id).
 *
 * A connection that exists but is `needs_reauth`/`error` does NOT satisfy the requirement
 * — that broken credential IS the broken run the AC is about — but it reports distinctly
 * from "missing" so the user is told to repair it rather than to create a second one.
 *
 * The caller MUST NOT call this with a fabricated list: if listConnections failed, render
 * the requirements without a verdict instead of passing `[]` (which would claim every
 * requirement is missing).
 */
export function checkConnectionRequirements(
  requirements: readonly ConnectionRequirement[],
  connections: readonly ConnectionRow[],
): CheckedRequirement[] {
  return requirements.map((req) => {
    const candidates = connections.filter((c) => req.types.includes(c.type));
    const healthy = candidates.find((c) => c.status === "connected");
    if (healthy)
      return {
        ...req,
        status: "satisfied",
        connectionLabel: healthy.label,
        connectionStatus: healthy.status,
      };
    if (candidates.length > 0)
      return {
        ...req,
        status: "unhealthy",
        connectionLabel: candidates[0].label,
        connectionStatus: candidates[0].status,
      };
    return { ...req, status: "missing" };
  });
}

/** How many of the checked requirements still block a working run. */
export function unmetCount(checked: readonly CheckedRequirement[]): number {
  return checked.filter((c) => c.status !== "satisfied").length;
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
