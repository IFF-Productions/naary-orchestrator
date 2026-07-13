/**
 * Data sources for the ExpressionField autocomplete: which node ids a field can reference
 * (`{{ h` → `hook`) and which keys live under a dotted path (`{{ hook.` → `repository`, …).
 * Pure + framework-free so it's unit-testable without CodeMirror.
 */

/** A canvas edge (source → target). Ancestors are computed by walking these backwards. */
export interface RefEdge {
  source: string;
  target: string;
}

/** The set of nodes whose output `selfId` can reference — its transitive predecessors. */
export function ancestorsOf(selfId: string, edges: RefEdge[]): string[] {
  const preds = new Map<string, string[]>();
  for (const e of edges) {
    const list = preds.get(e.target);
    if (list) list.push(e.source);
    else preds.set(e.target, [e.source]);
  }
  const seen = new Set<string>();
  const stack = [selfId];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    for (const p of preds.get(cur) ?? []) {
      if (!seen.has(p)) {
        seen.add(p);
        stack.push(p);
      }
    }
  }
  seen.delete(selfId); // a node isn't its own ancestor (guards a cycle)
  return [...seen];
}

/** Follow dotted segments into a value (object keys only; stops at a non-object). */
function navigate(root: unknown, segments: string[]): unknown {
  let cur = root;
  for (const s of segments) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[s];
  }
  return cur;
}

/**
 * Known top-level output keys per node kind — the autocomplete fallback when a node has no pinned
 * sample. Mirrors the output shapes documented in @naary/dsl's NODE_CATALOG. Only kinds with a
 * FIXED shape are listed; dynamic-output kinds (webhookTrigger/formTrigger/mcpTool) rely on a pin.
 */
export const NODE_OUTPUT_KEYS: Record<string, string[]> = {
  httpRequest: ["status", "headers", "body"],
  pollTrigger: ["changed", "body"],
  integration: ["status", "ok", "body"],
  chatTrigger: ["message", "sessionId"],
  agent: ["output"],
};

/** The completion sources handed to the editor — recomputed when nodes/edges/pins change. */
export interface ExpressionRefs {
  /** Referenceable node ids (ancestors + the reserved `__input`). */
  nodeIds: string[];
  /** Object keys reachable under a dotted `base` (e.g. "hook.repository"), from pins. */
  keysAt(base: string): string[];
}

/**
 * Build the autocomplete sources for the node `selfId` from the canvas edges + the pinned sample
 * outputs. `keysAt` navigates a node's pinned output so `{{ hook.repository.` suggests its keys;
 * with no pin (or a non-object leaf) it returns [] — autocomplete just stays quiet, never wrong.
 */
export function buildExpressionRefs(
  selfId: string,
  edges: RefEdge[],
  pins: Record<string, unknown>,
  nodeKinds: Record<string, string> = {},
): ExpressionRefs {
  const nodeIds = [...ancestorsOf(selfId, edges), "__input"];
  return {
    nodeIds,
    keysAt(base: string): string[] {
      const segments = base.split(".").filter(Boolean); // ["hook","repository"]
      if (segments.length === 0) return [];
      const [nodeId, ...rest] = segments;
      const val = navigate(pins[nodeId], rest);
      if (val && typeof val === "object" && !Array.isArray(val)) {
        return Object.keys(val);
      }
      // No pinned value: at the FIRST level, fall back to the node kind's known output keys.
      if (rest.length === 0 && pins[nodeId] === undefined) {
        return NODE_OUTPUT_KEYS[nodeKinds[nodeId]] ?? [];
      }
      return [];
    },
  };
}
