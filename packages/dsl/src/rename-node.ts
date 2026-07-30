/**
 * RENAME A NODE'S ID (#833), rewriting every reference to it.
 *
 * Asked for as: "can we have the ability to actually rename the node slug". A node's id is what
 * every expression references — `{{ agent-1a2b.output.title }}` — so today every binding in a
 * flow is written against an opaque generated string.
 *
 * `NodeDef.name` stays display-only on purpose: execution, edge conditions and `{{ … }}` all key
 * on the id, so renaming the *name* can never break a reference. That's the right split. The fix
 * is to make the ID renameable, with a rename that moves everything pointing at it.
 *
 * THE RISK IS ENTIRELY IN THE ENUMERATION. A rename that misses one reference is silent breakage
 * discovered on a run — the exact failure class this feature exists to reduce. What moves:
 *
 *   1. `NodeDef.id`
 *   2. `GraphDef.startNodeId`
 *   3. `edges[].from` / `edges[].to`
 *   4. `{{ oldId… }}` in every string anywhere in every node's `config` (arbitrarily nested),
 *      located with `templateTokens` — the SAME regex the runtime resolves with, so this can't
 *      drift from what actually resolves, and escaped `\{{` literals are skipped for free
 *   5. `ArgBinding.from` — `{ from, path? }` objects anywhere in a config
 *   6. `EdgeCondition.path`, whose first segment is a node id
 *   7. `handoff.targets[].to` — AND the edge conditions that route on it, see below
 *
 * ATOMIC: everything is validated before anything is rewritten, and the rewrite builds a new
 * graph rather than mutating. A partial rename is worse than no rename.
 *
 * Pure. Never throws. Lives here rather than in the canvas so it can be tested against the list
 * above without a browser.
 */
import { templateTokens } from "./template";
import type { ArgBinding, EdgeDef, GraphDef, NodeDef } from "./types";

/** The charset the expression grammar accepts. A space or a dot makes a token that can't resolve. */
const VALID_ID = /^[\w$-]+$/;

export type RenameNodeResult =
  | { ok: true; graph: GraphDef; rewritten: number }
  | { ok: false; error: string };

/** First segment of a dotted/indexed ctx path: `a-1.output.x` → `a-1`, `a-1[0]` → `a-1`. */
function head(path: string): string {
  const m = /^[^.[]*/.exec(path);
  return m ? m[0] : "";
}

/** Replace the leading node id in a ctx path, keeping the remainder byte-for-byte. */
function rehead(path: string, oldId: string, newId: string): string {
  return head(path) === oldId ? newId + path.slice(oldId.length) : path;
}

/**
 * An ArgBinding, structurally: `{ from: string, path?: string }` and nothing else.
 *
 * Deliberately shape-based rather than an allow-list of the 13 key names that hold one today
 * (`fieldBindings`, `argumentBindings`, `paramBindings`, `aBinding`, `source`, …). An allow-list
 * silently misses the next binding field somebody adds, and silent misses are the whole risk here.
 *
 * The strictness is what makes it safe: `SendEmailNodeConfig` has a `from` string too, but it sits
 * on an object with `connectionId`/`to`/`subject`/…, so it can never match.
 */
function isArgBinding(v: unknown): v is ArgBinding {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const keys = Object.keys(v as object);
  if (!keys.length || keys.length > 2) return false;
  if (!keys.every((k) => k === "from" || k === "path")) return false;
  return typeof (v as ArgBinding).from === "string";
}

/** Rewrite every `{{ oldId… }}` token in a string, preserving the rest of the text exactly. */
function rewriteTemplates(
  s: string,
  oldId: string,
  newId: string,
  count: { n: number },
): string {
  const tokens = templateTokens(s);
  if (!tokens.length) return s;
  let out = "";
  let cursor = 0;
  for (const t of tokens) {
    if (head(t.path) !== oldId) continue;
    const raw = s.slice(t.start, t.end);
    // Splice the identifier INSIDE the token rather than rebuilding `{{ path }}`, so the author's
    // spacing (`{{x}}` vs `{{ x }}`) survives a rename untouched.
    const at = raw.indexOf(t.path);
    if (at < 0) continue;
    out +=
      s.slice(cursor, t.start) +
      raw.slice(0, at) +
      rehead(t.path, oldId, newId) +
      raw.slice(at + t.path.length);
    cursor = t.end;
    count.n += 1;
  }
  return cursor === 0 ? s : out + s.slice(cursor);
}

/**
 * `handoff.targets[].to` is a bare node id in a field named `to` — not a template, not an
 * ArgBinding, so the generic walk cannot see it. Handled explicitly, which is the honest cost of
 * a field that holds a reference without looking like one.
 */
function rewriteHandoffTargets(
  config: NodeDef["config"],
  oldId: string,
  newId: string,
  count: { n: number },
): NodeDef["config"] {
  const cfg = config as { handoff?: { targets?: unknown[] } } | undefined;
  const targets = cfg?.handoff?.targets;
  if (!Array.isArray(targets)) return config;
  let hit = false;
  const next = targets.map((t) => {
    const target = t as { to?: unknown };
    if (target?.to !== oldId) return t;
    hit = true;
    count.n += 1;
    return { ...(t as object), to: newId };
  });
  if (!hit) return config;
  return {
    ...(cfg as object),
    handoff: { ...(cfg as { handoff: object }).handoff, targets: next },
  } as NodeDef["config"];
}

/** Deep-rewrite a node config: template strings and ArgBindings, arrays and nesting included. */
function rewriteConfig(
  value: unknown,
  oldId: string,
  newId: string,
  count: { n: number },
): unknown {
  if (typeof value === "string")
    return rewriteTemplates(value, oldId, newId, count);
  if (Array.isArray(value))
    return value.map((v) => rewriteConfig(v, oldId, newId, count));
  if (value && typeof value === "object") {
    if (isArgBinding(value)) {
      if (value.from !== oldId) return value;
      count.n += 1;
      return { ...value, from: newId };
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = rewriteConfig(v, oldId, newId, count);
    }
    return out;
  }
  return value;
}

/**
 * A handoff target's MODEL-FACING name defaults to its `to` (the node id), and the routing edge
 * compares `<supervisor>.output.target` against that name. So renaming a target node moves the
 * name too — and any edge condition still comparing against the old one would be a route the
 * model can never satisfy. Both sides move together or the graph is broken in a way that only
 * shows up when the model picks that branch.
 */
function handoffNamesLosingTheirId(
  nodes: NodeDef[],
  oldId: string,
): Set<string> {
  const paths = new Set<string>();
  for (const n of nodes) {
    const handoff = (
      n.config as { handoff?: { targets?: unknown[] } } | undefined
    )?.handoff;
    if (!handoff?.targets) continue;
    for (const t of handoff.targets) {
      const target = t as { to?: unknown; name?: unknown };
      // Only when the name is IMPLICIT. An explicit name is the author's choice of what the model
      // sees and has nothing to do with the id.
      if (target.to === oldId && target.name === undefined) {
        paths.add(`${n.id}.output.target`);
      }
    }
  }
  return paths;
}

/**
 * Keys the RUNTIME seeds into ctx, which are therefore never node ids: `$vars`, `$secrets`, and
 * the `__*` bookkeeping (`__input`, `__costUsd`, `__nodeTimes`, …). Exported because callers that
 * walk a ctx by key — not just by reference — need the same list.
 */
export function isReservedCtxKey(id: string): boolean {
  return id === "$vars" || id === "$secrets" || id.startsWith("__");
}

/**
 * Which node ids a node's CONFIG reads data from — the read-only sibling of `rewriteConfig`.
 *
 * "Reads data from" is the precise claim, and it is narrower than "references". Only the two
 * kinds that pull an upstream node's OUTPUT into this node count:
 *   - `{{ nodeId… }}` template tokens anywhere in a nested config string
 *   - `ArgBinding.from` — `{ from, path? }` objects anywhere
 *
 * Deliberately NOT included, though `renameNode` rewrites them all: `edges[].from/.to` and
 * `EdgeCondition.path` belong to the graph's edges rather than to this node, and
 * `handoff.targets[].to` names somewhere the node can hand control TO — a downstream routing
 * target, not data it consumed.
 *
 * Also not included: the RESERVED ctx keys. `{{ $vars.REGION }}` and `{{ __input.id }}` are
 * ordinary references and the walk sees `$vars`/`__input` as their heads — but those are keys the
 * runtime seeds into ctx, not node ids, so returning them would make this function's name a lie
 * and hand every caller a filtering job it would eventually forget. Filtered here, once.
 *
 * Exists for the run diagnosis (see run-diagnosis.ts), which sends a failing node's inputs to a
 * model and must therefore know exactly which upstream outputs it actually read — anything wider
 * ships data the diagnosis has no use for. It lives HERE, sharing `isArgBinding` and
 * `templateTokens` with the rename walk, so the two enumerations cannot drift apart; a drift test
 * asserts a config is rewritten by `renameNode` if and only if it appears here.
 *
 * Pure. Never throws. Ids are returned deduped, in first-seen order.
 */
export function referencedNodeIds(node: NodeDef): string[] {
  const found = new Set<string>();

  const walk = (value: unknown): void => {
    if (typeof value === "string") {
      // `templateTokens` is the SAME parser the runtime resolves with, so an escaped `\{{` is
      // skipped for free and this cannot diverge from what actually resolves at run time.
      for (const t of templateTokens(value)) {
        const id = head(t.path);
        if (id) found.add(id);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const v of value) walk(v);
      return;
    }
    if (value && typeof value === "object") {
      if (isArgBinding(value)) {
        found.add(value.from);
        return;
      }
      for (const v of Object.values(value as Record<string, unknown>)) walk(v);
    }
  };

  walk(node.config);
  // A node referring to itself is not an input — `{{ self.x }}` reads an output it hasn't written.
  found.delete(node.id);
  return [...found].filter((id) => !isReservedCtxKey(id));
}

export function renameNode(
  graph: GraphDef,
  oldId: string,
  newId: string,
): RenameNodeResult {
  // ---- validate everything BEFORE touching anything ----
  if (!graph?.nodes)
    return { ok: false, error: "There is no graph to rename in." };
  if (!graph.nodes.some((n) => n.id === oldId))
    return { ok: false, error: `No node called "${oldId}".` };
  const trimmed = (newId ?? "").trim();
  if (!trimmed) return { ok: false, error: "A node needs a name." };
  if (trimmed === oldId) return { ok: true, graph, rewritten: 0 };
  if (!VALID_ID.test(trimmed))
    return {
      ok: false,
      error:
        `"${trimmed}" can't be used: a node name may contain only letters, numbers, ` +
        `_, $ and -. Anything else makes an expression that can never resolve.`,
    };
  if (graph.nodes.some((n) => n.id === trimmed))
    return { ok: false, error: `Another node is already called "${trimmed}".` };

  // ---- rewrite ----
  const count = { n: 0 };
  const handoffPaths = handoffNamesLosingTheirId(graph.nodes, oldId);

  const nodes = graph.nodes.map((n) => {
    const next: NodeDef = { ...n };
    if (next.id === oldId) {
      next.id = trimmed;
      count.n += 1;
    }
    if (next.config) {
      next.config = rewriteConfig(
        next.config,
        oldId,
        trimmed,
        count,
      ) as NodeDef["config"];
      next.config = rewriteHandoffTargets(next.config, oldId, trimmed, count);
    }
    return next;
  });

  const edges = graph.edges.map((e) => {
    const next: EdgeDef = { ...e };
    if (next.from === oldId) {
      next.from = trimmed;
      count.n += 1;
    }
    if (next.to === oldId) {
      next.to = trimmed;
      count.n += 1;
    }
    if (next.condition) {
      const path = rehead(next.condition.path, oldId, trimmed);
      // The handoff case: this edge routes on a target name that just changed with the id.
      const value =
        handoffPaths.has(next.condition.path) && next.condition.value === oldId
          ? trimmed
          : next.condition.value;
      if (path !== next.condition.path || value !== next.condition.value) {
        next.condition = { ...next.condition, path, value };
        count.n += 1;
      }
    }
    return next;
  });

  const startNodeId = graph.startNodeId === oldId ? trimmed : graph.startNodeId;
  if (startNodeId !== graph.startNodeId) count.n += 1;

  return {
    ok: true,
    graph: { ...graph, nodes, edges, startNodeId },
    rewritten: count.n,
  };
}
