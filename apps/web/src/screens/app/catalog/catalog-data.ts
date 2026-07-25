/**
 * Node-catalog derivation layer (redesign, "Naary Node Catalog.dc.html").
 *
 * DATA HONESTY: every entry is derived from the REAL registry — `NODE_CATALOG` /
 * `NODE_TYPES` (@naary/dsl), the per-node zod config schemas (via their JSON-schema
 * projection, `nodeConfigJsonSchema`), the integration provider catalog, and the
 * canvas palette's display metadata (NODE_KINDS in lib/graph-model). Nothing here is
 * invented: inputs = the node's config schema fields (required = schema-required),
 * outputs = the output shape the registry summary documents (or a generic `output`
 * when it documents none), auth = presence of connectionId / provider+model fields
 * (or the integration provider's own auth text). Where the registry can't express
 * something the design mocked (e.g. cost profiles), it is omitted.
 */
import { INTEGRATION_CATALOG, NODE_CATALOG, NODE_TYPES } from "@naary/dsl";
import type { NodeGroup as RegistryGroup, NodeType } from "@naary/dsl";
import { nodeConfigJsonSchema } from "@naary/dsl/dist/registry";
import { NODE_KINDS } from "../../../lib/graph-model";

/* ---------------- categories ---------------- */

export type CategoryId =
  | "trigger"
  | "ai"
  | "data"
  | "transform"
  | "control"
  | "integration"
  | "utility";

export interface CatalogCategory {
  id: CategoryId;
  name: string;
  /** Category accent — the codebase's node-accent CSS vars (README mapping table). */
  color: string;
  /** 24-viewbox stroke path (design glyph). */
  ipath: string;
}

/** Design categories, in rail/grid order. Colors are theme-aware token vars. */
export const CATEGORIES: CatalogCategory[] = [
  {
    id: "trigger",
    name: "Triggers",
    color: "var(--node-trigger)",
    ipath: "M13 3 4 14h6l-1 7 9-11h-6z",
  },
  {
    id: "ai",
    name: "AI & Agents",
    color: "var(--node-agent)",
    ipath: "M12 3l2.1 4.6L19 9l-3.4 3.3.8 4.7L12 15l-4.4 2 .8-4.7L5 9z",
  },
  {
    id: "data",
    name: "Data",
    color: "var(--node-mcp)",
    ipath: "M4 7h16M4 12h16M4 17h10",
  },
  {
    id: "transform",
    name: "Transform",
    color: "var(--state-done)",
    ipath: "M4 8h10l-3-3m3 3-3 3M20 16H10l3-3m-3 3 3 3",
  },
  {
    id: "control",
    name: "Control flow",
    color: "var(--node-router)",
    ipath: "M6 5v5a3 3 0 0 0 3 3h9m0 0-3-3m3 3-3 3",
  },
  {
    id: "integration",
    name: "Integrations",
    color: "var(--node-approval)",
    ipath: "M9 12h6m-3-3v6M6 6h12v12H6z",
  },
  {
    id: "utility",
    name: "Utilities",
    color: "var(--ink-faint)",
    ipath: "M12 8a4 4 0 1 0 0 8m0-8v8m0-8 6-3m-6 3-6-3m6 11 6 3m-6-3-6 3",
  },
];

/**
 * Registry group → design category — THE one-place mapping. The registry's own
 * categorization (NODE_CATALOG group) drives this; the sole override below it is
 * the `integration` node type, whose provider tiles form the design's
 * "Integrations" category.
 */
const GROUP_TO_CATEGORY: Record<RegistryGroup, CategoryId> = {
  trigger: "trigger",
  ai: "ai",
  "data-source": "data",
  transform: "transform",
  flow: "control",
  crypto: "utility",
  comms: "utility",
  terminal: "utility",
};

export function categoryOf(id: CategoryId): CatalogCategory {
  // CATEGORIES is exhaustive over CategoryId, so the lookup always resolves.
  return CATEGORIES.find((c) => c.id === id) as CatalogCategory;
}

/* ---------------- entry model ---------------- */

export interface CatalogPort {
  name: string;
  /** Schema-derived type name; absent when the registry doesn't state one. */
  type?: string;
  required?: boolean;
}

export interface CatalogEntry {
  /** Stable id — the node type, or `integration:<provider>` for provider tiles. */
  id: string;
  nodeType: NodeType;
  /** Set on integration tiles — one per INTEGRATION_CATALOG provider (github, stripe, …). */
  provider?: string;
  name: string;
  desc: string;
  category: CategoryId;
  /** True for graph entry nodes (a run starts here). */
  entry: boolean;
  ipath: string;
  inputs: CatalogPort[];
  outputs: CatalogPort[];
  /** Authentication requirement, or null when the schema declares none. */
  auth: string | null;
  /** Configuration chips (enum fields / provider actions). */
  cfg: string[];
}

/* ---------------- per-node glyphs (presentation only) ---------------- */

// Design glyph paths keyed by our REAL node types; anything unmapped falls back
// to its category glyph. Purely visual — carries no data claims.
const NODE_IPATH: Partial<Record<NodeType, string>> = {
  start: "M13 3 4 14h6l-1 7 9-11h-6z",
  webhookTrigger: "M12 3v7m0 0-3-3m3 3 3-3M5 14a7 7 0 0 0 14 0",
  scheduleTrigger: "M12 7v5l3 2M20 12a8 8 0 1 1-16 0 8 8 0 0 1 16 0z",
  pollTrigger: "M4 4v6h6M20 20v-6h-6M19 9a8 8 0 0 0-14-3M5 15a8 8 0 0 0 14 3",
  formTrigger: "M6 4h12v16H6zM9 9h6M9 13h6",
  chatTrigger: "M5 6h14v10H9l-4 3z",
  mcpServerTrigger: "M12 3v6m0 6v6M5 12h6m2 0h6M7 7l3 3m4 4 3 3",
  errorTrigger:
    "M12 8v5m0 3h.01M10.3 4l-7 12a2 2 0 0 0 1.7 3h14a2 2 0 0 0 1.7-3l-7-12a2 2 0 0 0-3.4 0z",
  agent: "M12 3l2.1 4.6L19 9l-3.4 3.3.8 4.7L12 15l-4.4 2 .8-4.7L5 9z",
  codeAgent: "M8 8l-4 4 4 4m8-8 4 4-4 4M13 5l-2 14",
  // Speaker cone + two radiating waves.
  textToSpeech:
    "M4 10v4h3l4 3V7l-4 3H4zM15.5 9.5a4 4 0 0 1 0 5M18 7a7 7 0 0 1 0 10",
  mcpTool: "M12 3v6m0 6v6M5 12h6m2 0h6M7 7l3 3m4 4 3 3",
  httpRequest:
    "M4 12h16M12 4a15 15 0 0 1 0 16M12 4a15 15 0 0 0 0 16M20 12a8 8 0 1 1-16 0 8 8 0 0 1 16 0z",
  graphQL: "M12 3l7.5 4.5v9L12 21l-7.5-4.5v-9zM12 3v18M4.5 7.5 12 12l7.5-4.5",
  sqlQuery:
    "M5 6c0-1.5 3-2.5 7-2.5S19 4.5 19 6m-14 0v12c0 1.5 3 2.5 7 2.5s7-1 7-2.5V6m-14 6c0 1.5 3 2.5 7 2.5s7-1 7-2.5",
  sqlExec:
    "M5 6c0-1.5 3-2.5 7-2.5S19 4.5 19 6v12c0 1.5-3 2.5-7 2.5m-7-9c0 1.5 3 2.5 7 2.5M9 18l2 2 4-4",
  rssRead:
    "M5 19a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM5 13a6 6 0 0 1 6 6M5 7a12 12 0 0 1 12 12",
  vectorUpsert: "M12 3v18M5 7l7 4 7-4M5 12l7 4 7-4",
  vectorQuery: "M11 4a6 6 0 1 0 0 12 6 6 0 0 0 0-12zM20 20l-4.5-4.5",
  set: "M4 6h16M4 12h10M4 18h7M17 15l3 3-3 3",
  renameKeys: "M4 6h16M4 12h10M4 18h7M17 15l3 3-3 3",
  text: "M4 5h16M9 5v14M4 5v3M20 5v3",
  filter: "M4 5h16l-6 7v6l-4 2v-8z",
  aggregate: "M5 20V10M12 20V4M19 20v-7",
  listOps: "M7 4v16m0 0-3-3m3 3 3-3M17 20V4m0 0-3 3m3-3 3 3",
  compareDatasets: "M8 8h10v10H8zM4 4h10v2M4 4v10h2",
  xml: "M8 8l-4 4 4 4m8-8 4 4-4 4",
  htmlExtract: "M6 4h9l3 3v13H6zM14 4v4h4M9 13h6M9 16h4",
  markdown: "M6 4h9l3 3v13H6zM14 4v4h4M9 13h6M9 16h4",
  noOp: "M5 12h14",
  splitOut: "M12 4v6m0 4v6M4 12h6m4 0h6",
  loopEnd: "M4 4v6h6M19 9a8 8 0 0 0-14-3M20 20v-6h-6M5 15a8 8 0 0 0 14 3",
  csv: "M6 4h12v16H6zM6 9h12M6 14h12M11 9v11",
  json: "M9 4H7a3 3 0 0 0-3 3v2a2 2 0 0 1-2 2 2 2 0 0 1 2 2v2a3 3 0 0 0 3 3h2",
  number: "M12 5v14m-7-7h14",
  encode:
    "M15 4h2a3 3 0 0 1 3 3v2a2 2 0 0 0 2 2 2 2 0 0 0-2 2v2a3 3 0 0 1-3 3h-2",
  dateTime: "M12 7v5l3 2M20 12a8 8 0 1 1-16 0 8 8 0 0 1 16 0z",
  merge: "M6 4v5a5 5 0 0 0 5 5h2a5 5 0 0 1 5 5v1M6 4l-2 3m2-3 2 3",
  if: "M6 5v5a3 3 0 0 0 3 3h9m0 0-3-3m3 3-3 3",
  switch: "M4 6h16M7 12h10M10 18h4",
  executeSubWorkflow: "M4 5h7v6H4zM13 13h7v6h-7zM11 8h4a2 2 0 0 1 2 2v3",
  forEach: "M4 6h4v4H4zM4 14h4v4H4zM12 8h8M12 16h8",
  wait: "M12 7v5l3 2M20 12a8 8 0 1 1-16 0 8 8 0 0 1 16 0z",
  humanApproval: "M5 12.5 10 17.5 19.5 7",
  respondToWebhook: "M5 12h14M13 6l6 6-6 6",
  code: "M8 8l-4 4 4 4m8-8 4 4-4 4",
  hmac: "M12 3l7 4v5c0 4-3 7-7 9-4-2-7-5-7-9V7z",
  jwt: "M12 3v18M7 6l10 12M17 6 7 18",
  totp: "M12 7v5l3 2M20 12a8 8 0 1 1-16 0 8 8 0 0 1 16 0z",
  hash: "M9 4 7 20M17 4l-2 16M4 9h16M4 15h16",
  random: "M12 4v6m0 4v6M4 12h6m4 0h6",
  sendEmail: "M4 6h16v12H4zM4 7l8 6 8-6",
  stopAndError: "M9 4h6l4 4v6l-4 4H9l-4-4V8zM9 9l6 6m0-6-6 6",
  end: "M7 7h10v10H7z",
};

const INTEGRATION_IPATH: Record<string, string> = {
  github:
    "M9 19c-4 1.5-4-2.5-6-3m12 5v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 0 0-1.3-3.2 4.2 4.2 0 0 0-.1-3.2s-1-.3-3.4 1.3a11.6 11.6 0 0 0-6 0C6.3 2.5 5.3 2.8 5.3 2.8a4.2 4.2 0 0 0-.1 3.2A4.6 4.6 0 0 0 4 9.2c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.2-.5 2V21",
  jira: "M12 3 3 12l4 4 5-5 5 5 4-4z",
  slack: "M9 4v10m0 0a2 2 0 1 1-4 0m4 0h6M20 9h-10m0 0a2 2 0 1 1 0-4",
  notion: "M6 5h9l3 3v11H6zM10 9v6M10 9l4 6",
};

/* ---------------- schema introspection ---------------- */

interface JsonSchemaProp {
  type?: string | string[];
  enum?: unknown[];
  anyOf?: unknown[];
  properties?: Record<string, unknown>;
}
interface JsonSchemaObject {
  properties?: Record<string, JsonSchemaProp>;
  required?: string[];
}

function configSchema(type: NodeType): JsonSchemaObject {
  return nodeConfigJsonSchema(type) as JsonSchemaObject;
}

/** Compact type name for a JSON-schema property (the zod schema's projection). */
function fieldTypeName(p: JsonSchemaProp): string {
  if (Array.isArray(p.enum)) return "enum";
  if (p.anyOf) return "any";
  const t = Array.isArray(p.type) ? p.type[0] : p.type;
  if (t === "object") {
    // {from, path?} upstream-output bindings are their own concept in the DSL.
    return p.properties && "from" in p.properties ? "binding" : "object";
  }
  if (t === "integer") return "number";
  return t ?? "any";
}

/** Inputs = the node's config schema fields; required = schema-required. */
function deriveInputs(type: NodeType): CatalogPort[] {
  const js = configSchema(type);
  const required = new Set(js.required ?? []);
  return Object.entries(js.properties ?? {}).map(([name, p]) => ({
    name,
    type: fieldTypeName(p),
    required: required.has(name),
  }));
}

// The registry documents each node's output shape in its summary as `{a,b,c}`
// (identifier lists only — `{key: value}` examples don't match). One shape max.
const OUTPUT_RE =
  /\{\s*([A-Za-z_][A-Za-z0-9_]*(?:\s*,\s*[A-Za-z_][A-Za-z0-9_]*)*)\s*\}/;

/** Outputs = the shape the registry summary documents; terminal nodes have none;
 *  nodes without a documented shape expose the generic `output` value. */
function deriveOutputs(type: NodeType): CatalogPort[] {
  const entry = NODE_CATALOG[type];
  if (entry.group === "terminal") return [];
  const m = entry.summary.match(OUTPUT_RE);
  if (!m) return [{ name: "output", type: "json" }];
  return m[1].split(",").map((s) => ({ name: s.trim() }));
}

/** Auth requirement, from field presence alone: connectionId ⇒ a saved
 *  connection; provider/model ⇒ the tenant's BYOK model key. Null = none. */
function deriveAuth(type: NodeType): string | null {
  const js = configSchema(type);
  const props = js.properties ?? {};
  const required = new Set(js.required ?? []);
  const parts: string[] = [];
  if ("provider" in props || "model" in props) {
    parts.push("Model provider key (BYOK), resolved per workspace");
  }
  if ("connectionId" in props) {
    parts.push(
      required.has("connectionId")
        ? "Saved connection (connectionId)"
        : "Optional saved connection (connectionId)",
    );
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** Configuration chips = the schema's enum-valued fields with their options. */
function deriveCfg(type: NodeType): string[] {
  const js = configSchema(type);
  return Object.entries(js.properties ?? {})
    .filter(([, p]) => Array.isArray(p.enum))
    .map(([name, p]) => {
      const vals = (p.enum as unknown[]).map(String);
      const shown = vals.slice(0, 4).join(" | ");
      return vals.length > 4 ? `${name}: ${shown} | …` : `${name}: ${shown}`;
    });
}

/* ---------------- catalog build ---------------- */

function entryForType(
  type: NodeType,
  name: string,
  desc: string,
): CatalogEntry {
  const reg = NODE_CATALOG[type];
  const category = GROUP_TO_CATEGORY[reg.group];
  return {
    id: type,
    nodeType: type,
    name,
    desc,
    category,
    entry: reg.entry === true,
    ipath: NODE_IPATH[type] ?? categoryOf(category).ipath,
    inputs: deriveInputs(type),
    outputs: deriveOutputs(type),
    auth: deriveAuth(type),
    cfg: deriveCfg(type),
  };
}

function buildCatalog(): CatalogEntry[] {
  const entries: CatalogEntry[] = [];
  const seen = new Set<NodeType>();

  // The canvas palette (NODE_KINDS) carries the display names/descriptions and
  // expands `integration` into one tile per provider — reuse both decisions. Those
  // integration rows are DERIVED from INTEGRATION_CATALOG (#688), so every shipped
  // provider lands here (and in the rail popover + catalog modal) automatically.
  for (const kind of NODE_KINDS) {
    if (kind.type === "integration") {
      const providerKey = String(kind.defaultConfig?.provider ?? "");
      const p = INTEGRATION_CATALOG[providerKey];
      if (!p) continue;
      seen.add("integration");
      entries.push({
        id: `integration:${p.key}`,
        nodeType: "integration",
        provider: p.key,
        name: p.label,
        desc: p.description,
        category: "integration",
        entry: false,
        ipath: INTEGRATION_IPATH[p.key] ?? categoryOf("integration").ipath,
        inputs: deriveInputs("integration"),
        outputs: deriveOutputs("integration"),
        // The provider catalog states its own auth requirement — use it verbatim.
        auth: p.auth,
        // Chips = the provider's real actions.
        cfg: p.actions.map((a) => a.label),
      });
    } else if (!seen.has(kind.type)) {
      seen.add(kind.type);
      entries.push(entryForType(kind.type, kind.label, kind.description));
    }
  }

  // Registry completeness: any NodeType the palette doesn't list still appears
  // (type as name, registry summary as description) — the registry is the truth.
  for (const type of NODE_TYPES) {
    if (!seen.has(type)) {
      entries.push(entryForType(type, type, NODE_CATALOG[type].summary));
    }
  }

  // Stable-sort into category (rail) order so "All nodes" reads grouped.
  const rank = new Map(CATEGORIES.map((c, i) => [c.id, i]));
  return entries
    .map((e, i) => ({ e, i }))
    .sort(
      (a, b) =>
        (rank.get(a.e.category) ?? 0) - (rank.get(b.e.category) ?? 0) ||
        a.i - b.i,
    )
    .map(({ e }) => e);
}

/** The full browsable catalog, derived once per session. */
export const CATALOG: CatalogEntry[] = buildCatalog();

export function categoryCount(id: CategoryId): number {
  return CATALOG.filter((e) => e.category === id).length;
}

/** The `/app/canvas?add=…` deep link for an entry (provider tiles carry theirs). */
export function addToCanvasUrl(entry: CatalogEntry): string {
  const base = `/app/canvas?add=${encodeURIComponent(entry.nodeType)}`;
  return entry.provider
    ? `${base}&provider=${encodeURIComponent(entry.provider)}`
    : base;
}
