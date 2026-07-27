/**
 * Compile the editor's canvas model into a platform GraphDef and validate it with
 * the SAME `validateGraph` the server runs (so the on-canvas status matches the API
 * 400). Pure — no React, unit-tested in test/compile-graph.spec.ts.
 *
 * Entry-node rule: GraphDef needs exactly one `startNodeId`, so the canvas must have
 * exactly one entry/trigger node (Start / Webhook / Schedule / Poll / Error) — enforced
 * here with a clear message (validateGraph only checks the id resolves, not entry-node count).
 */
import type {
  EdgeCondition,
  EdgeDef,
  GraphDef,
  NodeDef,
  NodeType,
} from "@naary/dsl";
// Namespace import: @naary/dsl ships CommonJS (its `export *` becomes __exportStar),
// which rollup can't statically tree-shake for a named value import — but the
// runtime namespace object carries `validateGraph`. (Types above are erased.)
import * as dsl from "@naary/dsl";
import type { CanvasEdge, CanvasNode, EdgeConditionDraft } from "./graph-model";

export interface CompileResult {
  graph?: GraphDef;
  error?: string;
}

// Every node type that can START a graph (be its `startNodeId`). All are handled as entry
// nodes by the interpreter. Keep in sync with the trigger node types.
// Exported because the canvas places a trigger differently from a step (node-placement.ts) and must
// not keep a second copy of this list to decide which is which.
export const ENTRY_TYPES: ReadonlySet<NodeType> = new Set<NodeType>([
  "start",
  "webhookTrigger",
  "scheduleTrigger",
  "formTrigger",
  "chatTrigger",
  "pollTrigger",
  "errorTrigger",
]);

export function compileGraph(
  nodes: CanvasNode[],
  edges: CanvasEdge[],
): CompileResult {
  if (nodes.length === 0) {
    return { error: "Empty canvas — add a Start node to begin." };
  }

  const entries = nodes.filter((n) => ENTRY_TYPES.has(n.type));
  if (entries.length === 0) {
    return {
      error: "No entry node — add a Start / Webhook / Schedule / Poll trigger.",
    };
  }
  if (entries.length > 1) {
    return {
      error:
        "Multiple entry nodes — keep exactly one trigger (Start/Webhook/Schedule/Poll).",
    };
  }

  const graphNodes: NodeDef[] = nodes.map((n) => {
    // `onError` + `retry` are first-class NodeDef fields but are edited in config-space on
    // the canvas; lift them out so they don't ride in config (onError only when "continue" —
    // "stop" is the default; retry only when it has real content).
    const cfg = n.config ? { ...n.config } : undefined;
    const onError = cfg?.onError;
    const retry = cfg?.retry as NodeDef["retry"] | undefined;
    // Custom display name (n8n rename) — edited in config-space, lifted to the first-class
    // NodeDef.name. Trim; a blank name is "no custom name" (omit). Never rides in DSL config.
    const rawName = cfg?.__name;
    const name =
      typeof rawName === "string" && rawName.trim()
        ? rawName.trim()
        : undefined;
    if (cfg) {
      delete cfg.onError;
      delete cfg.retry;
      delete cfg.__name;
    }
    const retryOut =
      retry && Object.values(retry).some((v) => v !== undefined && v !== "")
        ? retry
        : undefined;
    return {
      id: n.id,
      type: n.type,
      ...(name ? { name } : {}),
      ...(cfg && Object.keys(cfg).length > 0 ? { config: cfg } : {}),
      ...(onError === "continue" ? { onError: "continue" as const } : {}),
      ...(retryOut ? { retry: retryOut } : {}),
    };
  });
  const graphEdges: EdgeDef[] = edges.map((e) => {
    const condition = buildCondition(e.condition);
    return {
      from: e.source,
      to: e.target,
      ...(condition ? { condition } : {}),
    };
  });

  const graph: GraphDef = {
    nodes: graphNodes,
    edges: graphEdges,
    startNodeId: entries[0].id,
  };

  const check = dsl.validateGraph(graph);
  if (!check.valid) return { error: check.error ?? "Invalid graph." };
  return { graph };
}

/** Editor draft → DSL EdgeCondition. A blank path means "unconditional" (omit).
 *  Value handling by op: valueless ops (exists/isEmpty/notEmpty) carry none; `in` becomes
 *  an array; numeric ops (gt/lt/gte/lte) coerce to Number; STRING ops (contains/notContains/
 *  startsWith/endsWith/regex) keep the raw string verbatim (so "42" stays a string and a
 *  regex pattern isn't mangled); eq/neq coerce numeric/boolean-looking text. Mirrors
 *  evaluateCondition in @naary/dsl. */
function buildCondition(draft?: EdgeConditionDraft): EdgeCondition | undefined {
  if (!draft || !draft.path.trim()) return undefined;
  const base = { path: draft.path.trim(), op: draft.op };
  switch (draft.op) {
    case "exists":
    case "isEmpty":
    case "notEmpty":
      return base;
    case "in":
      return {
        ...base,
        value: draft.value
          .split(",")
          .map((s) => coerce(s.trim()))
          .filter((v) => v !== ""),
      };
    case "gt":
    case "lt":
    case "gte":
    case "lte":
      return { ...base, value: Number(draft.value) };
    case "contains":
    case "notContains":
    case "startsWith":
    case "endsWith":
    case "regex":
      return { ...base, value: draft.value };
    default:
      return { ...base, value: coerce(draft.value) };
  }
}

/** "true"/"false" → boolean, numeric string → number, else the trimmed string. */
function coerce(s: string): string | number | boolean {
  if (s === "true") return true;
  if (s === "false") return false;
  if (s !== "" && !Number.isNaN(Number(s))) return Number(s);
  return s;
}
