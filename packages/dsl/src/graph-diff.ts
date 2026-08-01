import { canonicalize } from "./canonical";
import type { EdgeCondition, EdgeDef, GraphDef, NodeDef } from "./types";

/**
 * Structural diff of two graph versions (workflow diff — review what changed before promoting).
 * Pure + deterministic: nodes matched by id, edges matched by (from → to). A node is "changed"
 * when it exists in both but any of its type/config/onError/retry differ (canonical compare), and
 * the changed top-level fields are reported. Order-independent (uses id/pair keys, not positions).
 *
 * ONE ENTRY PER THING THAT CHANGED. A reviewer scans this to decide whether to promote, and the
 * unit they reason about is "which nodes am I changing" — so a node that changed in five ways is
 * ONE `NodeChange` carrying five `details`, never five entries. Anything that inflates the entry
 * count makes a small change look risky and a large one unreadable. The same rule is why an edge
 * whose condition was edited is one `edgesChanged` entry rather than a removal plus an addition,
 * and why an edge is never attributed to its endpoint nodes: it belongs to neither, so it stays
 * its own entry rather than being duplicated under both.
 *
 * FIELD-LEVEL DETAIL (#1020). `fields` alone reports top-level `NodeDef` keys, so every edit a
 * user actually makes — a URL, a prompt, a binding, an action, a header — collapsed to the single
 * word "config". `details` names the individual paths, with before → after. `fields` is kept
 * alongside it (it has consumers) rather than replaced.
 */

/** Per-side cap on a rendered value. A `systemPrompt` or an `outputSchema` is unbounded; a diff row isn't. */
const MAX_VALUE_CHARS = 200;
/**
 * Cap on a single path SEGMENT. Array items are addressed by an identity value taken from the
 * config itself (`config.fields[key=email]`), which is author-supplied and therefore unbounded.
 */
const MAX_SEGMENT_CHARS = 40;
/** Cap on how many field changes one node reports. The overflow is counted, never dropped silently. */
const MAX_DETAILS_PER_NODE = 20;
/**
 * How deep the per-field walk descends before comparing a subtree as one value. Bounds both the
 * work and the path length on a deeply nested `outputSchema`, where "the schema changed" is a
 * more useful sentence than forty `config.outputSchema.properties.x.items.type` rows anyway.
 */
const MAX_DEPTH = 6;

/**
 * One changed value inside a node, addressed by a dotted path relative to the `NodeDef`
 * (`config.title`, `retry.maxAttempts`, `config.fields[key=email].label`).
 *
 * `path` is DISPLAY-ONLY and deliberately not parseable back into an accessor: a config key
 * containing a `.` or a `]`, or one long enough to be clipped, is unambiguous to a human reading
 * a review and ambiguous to a parser. Nothing should try to evaluate these.
 */
export interface FieldChange {
  path: string;
  kind: "added" | "removed" | "changed";
  /** JSON rendering of the old value, clipped. Absent for "added". */
  before?: string;
  /** JSON rendering of the new value, clipped. Absent for "removed". */
  after?: string;
  /**
   * True when either side was clipped. The clipped string carries its own
   * `… [truncated, N chars total]` marker, so the truncation is stated in the text as well —
   * this flag is for callers that want to style or count it.
   */
  truncated?: boolean;
  /** Extra wording the value alone doesn't carry — e.g. an array's item count on both sides. */
  note?: string;
}

export interface NodeChange {
  id: string;
  before: NodeDef;
  after: NodeDef;
  /** Which top-level NodeDef fields differ: any of "type" | "name" | "config" | "onError" | "retry". */
  fields: string[];
  /**
   * The individual values that changed, with before → after. Always present (possibly empty when
   * every change was swallowed by the cap below) so a renderer never has a reason to fall back to
   * the bare `fields` line.
   */
  details: FieldChange[];
  /** How many further changes exist beyond `details`. 0 normally; > 0 must be shown, not hidden. */
  detailsOmitted: number;
}

/**
 * An edge that still runs between the same two nodes but whose CONDITION was edited.
 *
 * Before #1020 this was reported as one edge removed plus one edge added, because the edge key
 * included the condition. That is right for a structural hash and wrong for a human review: a
 * threshold moving from `> 5` to `> 10` read as routing being torn out and rebuilt.
 */
export interface EdgeChange {
  from: string;
  to: string;
  /** The condition before the edit; absent when the edge was previously unconditional. */
  before?: EdgeCondition;
  /** The condition after the edit; absent when the edge became unconditional. */
  after?: EdgeCondition;
}

export interface GraphDiff {
  nodesAdded: NodeDef[];
  nodesRemoved: NodeDef[];
  nodesChanged: NodeChange[];
  edgesAdded: EdgeDef[];
  edgesRemoved: EdgeDef[];
  /** Edges that kept their from → to but changed condition. See EdgeChange. */
  edgesChanged: EdgeChange[];
  /**
   * True when the edge SET is unchanged but its ORDER differs. Edge order is semantically
   * significant here — the interpreter takes the FIRST matching outgoing edge (walk.ts precedence)
   * and canonicalize()/contentHash preserve it — so a pure reorder is a real, behaviour-affecting
   * change, not a no-op.
   */
  edgesReordered: boolean;
  startNodeChanged: boolean;
}

// `name` is DISPLAY-only (nothing executes off it), but it is still part of the saved node: a
// diff that reports "no changes" after a node was retitled describes a version that isn't the
// one on screen, and the canvas's unsaved-changes guard (which asks graphsEqual whether there
// is work to lose) would let a rename be discarded silently.
const NODE_FIELDS = ["type", "name", "config", "onError", "retry"] as const;

/**
 * JSON, length-capped, with the truncation STATED rather than silent — the house pattern, and the
 * same wording as `clip` in run-diagnosis.ts. Kept local rather than shared: that file's contract
 * is about what leaves the tenant to a model, which is a separate review surface from this one.
 */
function clip(
  value: unknown,
  max: number,
): { text: string; truncated: boolean } {
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    // Circular or unserializable — the shape is not worth failing a diff over.
    return { text: "[unserializable]", truncated: false };
  }
  return text.length <= max
    ? { text, truncated: false }
    : {
        text: `${text.slice(0, max)}… [truncated, ${text.length} chars total]`,
        truncated: true,
      };
}

/** Bound one path segment. Author-supplied identity values reach the path; see FieldChange.path. */
function clipSegment(s: string): string {
  return s.length <= MAX_SEGMENT_CHARS
    ? s
    : `${s.slice(0, MAX_SEGMENT_CHARS)}…`;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Keys an array item may be MATCHED on, in preference order.
 *
 * WHY IDENTITY AND NOT INDEX. Config arrays are things like a form's `fields`, a switch's `rules`
 * and a tool allowlist. Index-based paths describe an insertion at the front as "every item
 * changed" — precise-looking and wrong, which is the worst thing a promotion review can be. These
 * three keys are the identity conventions the node schemas actually use (form fields carry `key`,
 * switch rules carry `name`, connections/nodes carry `id`), so when they are present the match is
 * real rather than assumed. This list is the extension point if a schema adopts another.
 *
 * WHEN NO IDENTITY EXISTS the array is compared AS ONE VALUE (see diffValue) rather than by index.
 * Coarse and true beats precise and wrong; the clipped JSON plus an item count still says what
 * happened, and `clip` bounds it.
 */
const IDENTITY_KEYS = ["id", "key", "name"] as const;

/** An array can be keyed on `key` when every item is an object carrying it, primitively + uniquely. */
function usableAsIdentity(items: unknown[], key: string): boolean {
  const seen = new Set<string>();
  for (const item of items) {
    if (!isPlainObject(item)) return false;
    const v = item[key];
    // Objects/arrays as an identity would compare by reference-ish JSON and read terribly in a path.
    if (
      typeof v !== "string" &&
      typeof v !== "number" &&
      typeof v !== "boolean"
    ) {
      return false;
    }
    const s = String(v);
    if (seen.has(s)) return false; // ambiguous — two items would claim the same path
    seen.add(s);
  }
  return true;
}

function sharedIdentityKey(before: unknown[], after: unknown[]): string | null {
  for (const key of IDENTITY_KEYS) {
    if (usableAsIdentity(before, key) && usableAsIdentity(after, key))
      return key;
  }
  return null;
}

function leaf(
  path: string,
  kind: FieldChange["kind"],
  before: unknown,
  after: unknown,
  note?: string,
): FieldChange {
  const out: FieldChange = { path, kind };
  let truncated = false;
  if (kind !== "added") {
    const c = clip(before, MAX_VALUE_CHARS);
    out.before = c.text;
    truncated ||= c.truncated;
  }
  if (kind !== "removed") {
    const c = clip(after, MAX_VALUE_CHARS);
    out.after = c.text;
    truncated ||= c.truncated;
  }
  if (truncated) out.truncated = true;
  if (note) out.note = note;
  return out;
}

/**
 * Walk two values in parallel, emitting one FieldChange per differing leaf.
 *
 * Object keys are visited in sorted order and array items in array order, so the output is
 * deterministic for a given pair of inputs — the same property `canonicalize` gives the hash.
 */
function diffValue(
  path: string,
  before: unknown,
  after: unknown,
  out: FieldChange[],
  depth: number,
): void {
  if (canonicalize(before ?? null) === canonicalize(after ?? null)) return;

  // A field appearing or disappearing wholesale still descends when the present side is a
  // container: "config.title added" is the useful sentence, "config added" (with the whole object
  // inlined) is the one that made this issue necessary.
  const b =
    before === undefined && (isPlainObject(after) || Array.isArray(after))
      ? Array.isArray(after)
        ? []
        : {}
      : before;
  const a =
    after === undefined && (isPlainObject(before) || Array.isArray(before))
      ? Array.isArray(before)
        ? []
        : {}
      : after;

  if (b === undefined) {
    out.push(leaf(path, "added", undefined, a));
    return;
  }
  if (a === undefined) {
    out.push(leaf(path, "removed", b, undefined));
    return;
  }

  if (depth < MAX_DEPTH && isPlainObject(b) && isPlainObject(a)) {
    const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])].sort();
    for (const key of keys) {
      diffValue(`${path}.${clipSegment(key)}`, b[key], a[key], out, depth + 1);
    }
    return;
  }

  if (depth < MAX_DEPTH && Array.isArray(b) && Array.isArray(a)) {
    const idKey = sharedIdentityKey(b, a);
    if (idKey) {
      const beforeById = new Map(
        b.map((it) => [String((it as Record<string, unknown>)[idKey]), it]),
      );
      const afterById = new Map(
        a.map((it) => [String((it as Record<string, unknown>)[idKey]), it]),
      );
      for (const [id, item] of afterById) {
        const p = `${path}[${clipSegment(idKey)}=${clipSegment(id)}]`;
        const prev = beforeById.get(id);
        if (prev === undefined) out.push(leaf(p, "added", undefined, item));
        else diffValue(p, prev, item, out, depth + 1);
      }
      for (const [id, item] of beforeById) {
        if (afterById.has(id)) continue;
        out.push(
          leaf(
            `${path}[${clipSegment(idKey)}=${clipSegment(id)}]`,
            "removed",
            item,
            undefined,
          ),
        );
      }
      return;
    }
    // No identity to match on — compare the list as one value. The item counts are stated because
    // two clipped JSON blobs can look near-identical when what actually happened is a new entry.
    out.push(
      leaf(path, "changed", b, a, `${b.length} items → ${a.length} items`),
    );
    return;
  }

  out.push(leaf(path, "changed", b, a));
}

function describeNodeChange(
  before: NodeDef,
  after: NodeDef,
): Omit<NodeChange, "id" | "before" | "after"> {
  const fields: string[] = [];
  const all: FieldChange[] = [];
  for (const f of NODE_FIELDS) {
    if (canonicalize(before[f] ?? null) === canonicalize(after[f] ?? null)) {
      continue;
    }
    fields.push(f);
    diffValue(f, before[f], after[f], all, 0);
  }
  return {
    fields,
    details: all.slice(0, MAX_DETAILS_PER_NODE),
    detailsOmitted: Math.max(0, all.length - MAX_DETAILS_PER_NODE),
  };
}

/** Stable identity for an edge PAIR. The condition is deliberately NOT part of it — see EdgeChange. */
function pairKey(e: EdgeDef): string {
  return `${e.from}\0${e.to}`;
}

function conditionKey(e: EdgeDef): string {
  return e.condition ? canonicalize(e.condition) : "";
}

interface PositionedEdge {
  edge: EdgeDef;
  index: number;
}

function groupByPair(edges: EdgeDef[]): Map<string, PositionedEdge[]> {
  const out = new Map<string, PositionedEdge[]>();
  edges.forEach((edge, index) => {
    const k = pairKey(edge);
    const list = out.get(k);
    if (list) list.push({ edge, index });
    else out.set(k, [{ edge, index }]);
  });
  return out;
}

interface EdgeDiff {
  edgesAdded: EdgeDef[];
  edgesRemoved: EdgeDef[];
  edgesChanged: EdgeChange[];
  edgesReordered: boolean;
}

/**
 * Match edges on from → to, then compare conditions.
 *
 * Several edges may share a pair (a switch fanning two conditions at the same target), so within a
 * pair group the identical-condition edges are paired off FIRST and only the leftovers are matched
 * positionally. Without that first pass, swapping two same-pair edges would report two condition
 * changes instead of the reorder it is.
 */
function diffEdges(from: EdgeDef[], to: EdgeDef[]): EdgeDiff {
  const fromGroups = groupByPair(from);
  const toGroups = groupByPair(to);

  const added: PositionedEdge[] = [];
  const removed: PositionedEdge[] = [];
  const edgesChanged: EdgeChange[] = [];
  const matched: { fromIndex: number; toIndex: number }[] = [];

  for (const [key, tos] of toGroups) {
    const froms = fromGroups.get(key) ?? [];
    const usedFrom = new Set<number>();
    const unmatchedTo: PositionedEdge[] = [];

    // Pass 1: identical conditions pair off, in order.
    for (const t of tos) {
      const tk = conditionKey(t.edge);
      const hit = froms.find(
        (f) => !usedFrom.has(f.index) && conditionKey(f.edge) === tk,
      );
      if (hit) {
        usedFrom.add(hit.index);
        matched.push({ fromIndex: hit.index, toIndex: t.index });
      } else {
        unmatchedTo.push(t);
      }
    }

    // Pass 2: whatever is left in this pair group is the same route with an edited condition.
    const leftoverFrom = froms.filter((f) => !usedFrom.has(f.index));
    const n = Math.min(leftoverFrom.length, unmatchedTo.length);
    for (let i = 0; i < n; i++) {
      const f = leftoverFrom[i];
      const t = unmatchedTo[i];
      matched.push({ fromIndex: f.index, toIndex: t.index });
      const change: EdgeChange = { from: t.edge.from, to: t.edge.to };
      if (f.edge.condition) change.before = f.edge.condition;
      if (t.edge.condition) change.after = t.edge.condition;
      edgesChanged.push(change);
    }
    for (let i = n; i < unmatchedTo.length; i++) added.push(unmatchedTo[i]);
    for (let i = n; i < leftoverFrom.length; i++) removed.push(leftoverFrom[i]);
  }

  // Pairs that vanished entirely never appear in the loop above.
  for (const [key, froms] of fromGroups) {
    if (!toGroups.has(key)) removed.push(...froms);
  }

  // Order matters (traversal precedence). With the SET identical, a genuine reorder is exactly
  // "the matched source positions are no longer ascending when read in target order" — which also
  // catches a swap of two edges that share a from → to pair, where the pair sequence alone can't.
  const byTarget = [...matched].sort((x, y) => x.toIndex - y.toIndex);
  let ascending = true;
  for (let i = 1; i < byTarget.length; i++) {
    if (byTarget[i].fromIndex < byTarget[i - 1].fromIndex) ascending = false;
  }

  const bySourceOrder = (a: PositionedEdge, b: PositionedEdge) =>
    a.index - b.index;
  return {
    edgesAdded: added.sort(bySourceOrder).map((p) => p.edge),
    edgesRemoved: removed.sort(bySourceOrder).map((p) => p.edge),
    edgesChanged,
    edgesReordered: added.length === 0 && removed.length === 0 && !ascending,
  };
}

export function diffGraphs(from: GraphDef, to: GraphDef): GraphDiff {
  const fromNodes = new Map(from.nodes.map((n) => [n.id, n]));
  const toNodes = new Map(to.nodes.map((n) => [n.id, n]));

  const nodesAdded: NodeDef[] = [];
  const nodesRemoved: NodeDef[] = [];
  const nodesChanged: NodeChange[] = [];

  for (const [id, after] of toNodes) {
    const before = fromNodes.get(id);
    if (!before) {
      nodesAdded.push(after);
      continue;
    }
    const described = describeNodeChange(before, after);
    if (described.fields.length > 0) {
      nodesChanged.push({ id, before, after, ...described });
    }
  }
  for (const [id, before] of fromNodes) {
    if (!toNodes.has(id)) nodesRemoved.push(before);
  }

  return {
    nodesAdded,
    nodesRemoved,
    nodesChanged,
    ...diffEdges(from.edges, to.edges),
    startNodeChanged: from.startNodeId !== to.startNodeId,
  };
}

/** True when the two graphs are structurally identical (no changes). */
export function graphsEqual(from: GraphDef, to: GraphDef): boolean {
  const d = diffGraphs(from, to);
  return (
    !d.startNodeChanged &&
    d.nodesAdded.length === 0 &&
    d.nodesRemoved.length === 0 &&
    d.nodesChanged.length === 0 &&
    d.edgesAdded.length === 0 &&
    d.edgesRemoved.length === 0 &&
    d.edgesChanged.length === 0 &&
    !d.edgesReordered
  );
}
