/**
 * n8n workflow importer (#579) — a foreign JSON export becomes an unsaved draft graph plus an
 * honest, per-node mapping report.
 *
 * The design commitment, and the one property worth reviewing hardest: **nothing is silently
 * dropped.** Every node in the export produces exactly one report entry, and every report entry
 * either points at a node in the graph or says why it doesn't (a sticky note is an annotation; a
 * disabled node is bridged). A node type we have no equivalent for becomes a `noOp` PLACEHOLDER
 * carrying its original n8n parameters under `config.__n8n`, so the topology survives and the
 * configuration is recoverable by hand.
 *
 * The second commitment: **credentials are never imported.** n8n's `node.credentials` carries a
 * credential id + the account's display name; neither reaches the graph. The importer reports the
 * credential TYPES the workflow used, mapped to the connection type the user should create.
 *
 * What the importer must satisfy, and what its corpus test asserts: every graph it produces passes
 * BOTH save gates — `validateGraph` (structural: ids, reachability, merge fan-in, splitOut brackets,
 * integration provider/action) and `validateGraphConfigs` (per-node zod). An importer that yields
 * unsaveable graphs is a bug, not a partial success. `validateGraph` is the strict one; the config
 * gate is `.partial()`d and lets a draft through with unfilled fields.
 *
 * Pure + dependency-free — no zod, no I/O — so the API and the browser can both run it.
 */
import type { EdgeDef, GraphDef, NodeDef, NodeType } from "./types/core";
import {
  convertN8nValueDeep,
  stripPollutingKeys,
  type UnconvertedExpression,
} from "./n8n-expressions";
import {
  type TranslateCtx,
  asPicked,
  asRecord,
  asString,
  translateConfig,
} from "./n8n-config";
import {
  N8N_APP_TO_PROVIDER,
  N8N_CREDENTIAL_HINT,
  N8N_LM_PROVIDER,
  N8N_SUB_NODE_TYPES,
  type N8nMapStatus,
  lookupN8nNode,
} from "./n8n-map";

// ── The subset of an n8n export we read ───────────────────────────────────────────────────────

interface RawN8nNode {
  name?: unknown;
  type?: unknown;
  parameters?: unknown;
  position?: unknown;
  disabled?: unknown;
  credentials?: unknown;
  notes?: unknown;
  typeVersion?: unknown;
  /** n8n's error policy. `"continueRegularOutput"` (and the legacy `continueOnFail`) is the direct
   *  analogue of our `onError: "continue"`. */
  onError?: unknown;
  continueOnFail?: unknown;
}

/** `connections[sourceName][connectionType][outputIndex][] = { node, type, index }`. */
type RawConnections = Record<
  string,
  Record<
    string,
    Array<Array<{ node?: unknown; type?: unknown }> | null> | undefined
  >
>;

// ── Report ────────────────────────────────────────────────────────────────────────────────────

export interface N8nNodeReport {
  /** The node's name in n8n — how the user will recognise it. */
  n8nName: string;
  n8nType: string;
  /** Our node id, or null when the node is intentionally not in the graph (`skipped`). */
  nodeId: string | null;
  nodeType: NodeType | null;
  status: N8nMapStatus;
  /** Why it is not a faithful import. Always non-empty unless `status === "imported"`. */
  notes: string[];
}

/** A credential TYPE the original workflow used. Never an id, a name, or a secret. */
export interface N8nCredentialReport {
  /** n8n's credential type key, e.g. `httpHeaderAuth`, `githubApi`. */
  n8nType: string;
  /** n8n node names that used it. */
  usedBy: string[];
  /** The connection type to create here, or null when we have no equivalent. */
  suggestedConnectionType: string | null;
}

export interface N8nImportResult {
  /** The workflow name from the export (or a fallback) — for the save dialog. */
  name: string;
  /** An UNSAVED draft. There is no draft state in the schema: saving it creates version 1. */
  graph: GraphDef;
  /** One entry per node in the export, in export order. */
  nodes: N8nNodeReport[];
  credentials: N8nCredentialReport[];
  unconvertedExpressions: UnconvertedExpression[];
  /** Whole-workflow warnings the user must read before saving. */
  warnings: string[];
  counts: Record<N8nMapStatus, number>;
}

// ── id slugging ───────────────────────────────────────────────────────────────────────────────

/** Roots the expression/binding layer reserves — an id must never collide with one. */
const RESERVED_IDS = new Set(["$vars", "$secrets", "__input"]);

/**
 * n8n node names are free text ("Get user's orders (v2)"), but our ids are addressed by
 * `{{ id.path }}` and `{from, path}` bindings, whose path grammar has no quoting — so an id
 * containing `.`, `[` or `]` silently breaks every reference to it. Slugify hard, keep the original
 * in `NodeDef.name` (display-only, and safe: nothing keys on it).
 */
function slugifyId(name: string, used: Set<string>): string {
  let base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!base || base.startsWith("__") || RESERVED_IDS.has(base)) {
    base = base ? `n8n-${base}` : "node";
  }
  let id = base;
  let n = 2;
  while (used.has(id)) {
    id = `${base}-${n}`;
    n += 1;
  }
  used.add(id);
  return id;
}

// ── the importer ──────────────────────────────────────────────────────────────────────────────

/** One planned node, before edges are built. */
interface Planned {
  raw: RawN8nNode;
  n8nName: string;
  n8nType: string;
  id: string | null;
  nodeType: NodeType | null;
  status: N8nMapStatus;
  notes: string[];
  baseConfig: Record<string, unknown>;
  /** True for a node whose edges must be BRIDGED past it (disabled / skipped). */
  bridge: boolean;
}

export class N8nImportError extends Error {}

/**
 * Parse an n8n workflow export into a draft graph + mapping report.
 *
 * Throws only when the input is not an n8n workflow at all — anything else degrades into a
 * placeholder plus a report entry, because a partial import the user can fix beats a hard failure.
 */
export function parseN8nWorkflow(input: unknown): N8nImportResult {
  const wf = asRecord(input);
  if (!Array.isArray(wf.nodes)) {
    throw new N8nImportError(
      "Not an n8n workflow export: expected a top-level `nodes` array.",
    );
  }
  const rawNodes = wf.nodes as RawN8nNode[];
  if (rawNodes.length === 0) {
    throw new N8nImportError("This n8n workflow has no nodes.");
  }
  const connections = asRecord(wf.connections) as RawConnections;
  const warnings: string[] = [];
  const exprSink: UnconvertedExpression[] = [];

  // ── Pass 1: decide each node's fate + allocate ids ──────────────────────────────────────────
  const usedIds = new Set<string>();
  const planned: Planned[] = [];
  const nameToId = new Map<string, string>();
  /** n8n name → the sub-node record, for folding LLM/tool sub-nodes into their parent agent. */
  const subNodes = new Map<string, RawN8nNode>();

  const seenNames = new Set<string>();
  for (const entry of rawNodes) {
    // `nodes[]` is untrusted: a null/undefined or non-object entry must degrade like anything else,
    // not throw a TypeError that surfaces as a baffling 400.
    const raw: RawN8nNode = asRecord(entry);
    const n8nName = asString(raw.name) ?? "(unnamed)";
    const n8nType = asString(raw.type) ?? "(unknown)";

    // n8n forbids duplicate node names, but a hand-edited export can carry them — and `connections`
    // is keyed by NAME, so the second node would quietly steal the first one's edges and leave it
    // isolated. Warn rather than let that pass as a clean import.
    if (seenNames.has(n8nName)) {
      warnings.push(
        `Two nodes are both named "${n8nName}". n8n connections are keyed by name, so only one of them keeps the wiring — rename them in n8n and re-export, or reconnect the stray node by hand.`,
      );
    }
    seenNames.add(n8nName);

    if (N8N_SUB_NODE_TYPES.has(n8nType)) {
      // A sub-node is CONFIGURATION of its parent, not a step. It gets no id and no edges; what
      // can be folded into the parent agent is applied in pass 3.
      subNodes.set(n8nName, raw);
      planned.push({
        raw,
        n8nName,
        n8nType,
        id: null,
        nodeType: null,
        status: "skipped",
        notes: [
          "an n8n sub-node (model / memory / tool) — configuration of the node it is attached to, not a step of its own.",
        ],
        baseConfig: {},
        bridge: false,
      });
      continue;
    }

    const mapping = lookupN8nNode(n8nType);
    const provider = Object.prototype.hasOwnProperty.call(
      N8N_APP_TO_PROVIDER,
      n8nType,
    )
      ? N8N_APP_TO_PROVIDER[n8nType]
      : undefined;

    if (raw.disabled === true) {
      // Disabled in n8n = not executed. We have no disabled flag, so keep the report entry and
      // BRIDGE its edges (predecessor → successor) rather than leaving a dead node in the path.
      planned.push({
        raw,
        n8nName,
        n8nType,
        id: null,
        nodeType: null,
        status: "skipped",
        notes: [
          "disabled in n8n, so it is not imported; the connection through it is preserved (its predecessor now feeds its successor directly).",
        ],
        baseConfig: {},
        bridge: true,
      });
      continue;
    }

    if (mapping?.status === "skipped") {
      planned.push({
        raw,
        n8nName,
        n8nType,
        id: null,
        nodeType: null,
        status: "skipped",
        notes: mapping.note ? [mapping.note] : [],
        baseConfig: {},
        bridge: true,
      });
      continue;
    }

    if (mapping?.nodeType) {
      const id = slugifyId(n8nName, usedIds);
      nameToId.set(n8nName, id);
      planned.push({
        raw,
        n8nName,
        n8nType,
        id,
        nodeType: mapping.nodeType,
        status: mapping.status,
        notes: mapping.note ? [mapping.note] : [],
        baseConfig: { ...(mapping.baseConfig ?? {}) },
        bridge: false,
      });
      continue;
    }

    if (provider) {
      // A native app node whose provider we DO have. The action vocabularies don't line up 1:1, so
      // pre-selecting one would be a guess — leave action/connectionId for the user.
      const id = slugifyId(n8nName, usedIds);
      nameToId.set(n8nName, id);
      planned.push({
        raw,
        n8nName,
        n8nType,
        id,
        nodeType: "integration",
        status: "approximated",
        notes: [
          `mapped to our '${provider}' integration. Pick the action and a connection — n8n's operations don't map 1:1, so choosing one for you would be a guess.`,
        ],
        baseConfig: { provider },
        bridge: false,
      });
      continue;
    }

    // No equivalent at all → a visible placeholder that carries the original config.
    const id = slugifyId(n8nName, usedIds);
    nameToId.set(n8nName, id);
    planned.push({
      raw,
      n8nName,
      n8nType,
      id,
      nodeType: "noOp",
      status: "unmapped",
      notes: [
        mapping?.note ??
          `no equivalent for n8n type '${n8nType}'. Imported as a placeholder that does nothing; its original n8n parameters are kept on the node under \`__n8n\` so you can rebuild it.`,
      ],
      baseConfig: {},
      bridge: false,
    });
  }

  // ── Pass 2: edges (n8n `connections` is keyed by NAME and carries the output index) ──────────
  const byName = new Map<string, Planned>();
  for (const p of planned) byName.set(p.n8nName, p);

  /**
   * Follow bridges: a disabled/sticky node forwards to whatever ITS main output pointed at.
   *
   * `seen` is shared across the whole traversal, not cloned per path — which LOOKS like it could
   * drop an edge when a fan-out's branches reconverge, and doesn't. A node is added to `seen` by the
   * branch that visits it first, and that same branch has already pushed its resolution into the
   * shared `out`; a later branch short-circuiting to `[]` therefore removes nothing from the result.
   * Resolution is purely structural (it depends on the node, never on the path taken to reach it),
   * so "already resolved once" and "resolve again" are the same answer. Sharing additionally
   * de-duplicates a diamond, so a bridge reached twice yields one edge, not two.
   * Covered both ways by the fan-out and diamond cases in `n8n-import.spec.ts`.
   */
  function resolveTargets(name: string, seen = new Set<string>()): string[] {
    if (seen.has(name)) return []; // a bridge cycle can't be walked
    seen.add(name);
    const p = byName.get(name);
    if (!p) return [];
    if (p.id) return [p.id];
    if (!p.bridge) return [];
    const out: string[] = [];
    for (const group of connections[name]?.main ?? []) {
      for (const link of group ?? []) {
        const next = asString(link?.node);
        if (next) out.push(...resolveTargets(next, seen));
      }
    }
    return out;
  }

  /**
   * Edges are built in TWO phases, and the order is load-bearing:
   *
   *   2a (here) — the TOPOLOGY only. Node config translation needs to know each node's single
   *               predecessor (that's what n8n's `$json` means), so the edges must exist first.
   *   2b (after pass 3) — the branch CONDITIONS. A Switch's per-output condition names one of the
   *               node's own rules, which only exist once its config has been translated.
   *
   * Doing conditions in 2a is the bug this split exists to prevent: every Switch edge would come out
   * unconditional, so every branch would fire on every run.
   */
  interface PlannedEdge {
    from: string;
    to: string;
    source: Planned;
    outputIndex: number;
  }
  const plannedEdges: PlannedEdge[] = [];
  const inbound = new Map<string, string[]>();
  const noteInbound = (from: string, to: string): void => {
    const list = inbound.get(to) ?? [];
    list.push(from);
    inbound.set(to, list);
  };

  for (const [sourceName, byType] of Object.entries(connections)) {
    const source = byName.get(sourceName);
    if (!source?.id) continue; // unknown, or a bridged source (resolveTargets wired past it)
    for (const [connType, outputs] of Object.entries(byType)) {
      // ai_languageModel / ai_tool / ai_memory / … are sub-node wirings, NOT flow edges. Turning
      // them into edges would put a model node in the execution path.
      if (connType !== "main" || !Array.isArray(outputs)) continue;
      outputs.forEach((group, outputIndex) => {
        for (const link of group ?? []) {
          const targetName = asString(link?.node);
          if (!targetName) continue;
          for (const to of resolveTargets(targetName)) {
            plannedEdges.push({ from: source.id!, to, source, outputIndex });
            noteInbound(source.id!, to);
          }
        }
      });
    }
  }

  /**
   * Node types whose output is NOT the data flowing through them, so n8n's `$json` must be resolved
   * PAST them.
   *
   * This is the subtlest thing in the importer. In n8n an IF passes the incoming item straight
   * through, so `{{ $json.orderId }}` on the node *after* an IF means the item the IF received. Here,
   * `if` outputs `{ result: boolean }` and `switch` outputs `{ matched: string }` — a predicate, not
   * the data. Binding `$json` to the immediate predecessor would produce
   * `{{ high-value.orderId }}`, which resolves to nothing at run time: a silently broken import that
   * no validator would catch. So walk up until a node that actually carries data.
   *
   * The set is derived from what each type's output actually IS (see `node-output.ts`), not from
   * intuition:
   *  - `if` → `{result}`, `switch` → `{matched}` — predicates.
   *  - `respondToWebhook` → `{statusCode}`. The interpreter responds and KEEPS GOING, so a Respond
   *    node mid-flow has successors, and n8n passes the item through it.
   *  - `noOp` → `{}` — and every unmapped placeholder is a `noOp`, so `$json` correctly reaches
   *    past a node we couldn't translate to the last one that produced data.
   *  - duration-mode `wait` writes nothing. (Webhook-mode wait DOES produce a payload here, but
   *    n8n's Wait passes the original items through by default, so walking past it is the faithful
   *    reading.)
   * `merge` and `filter` are deliberately NOT in the set — both carry data forward.
   */
  const PASS_THROUGH_TYPES: ReadonlySet<string> = new Set([
    "if",
    "switch",
    "wait",
    "noOp",
    "respondToWebhook",
  ]);
  const plannedById = new Map<string, Planned>();
  for (const p of planned) if (p.id) plannedById.set(p.id, p);

  function dataPredecessorOf(
    id: string,
    seen = new Set<string>(),
  ): string | null {
    if (seen.has(id)) return null; // a cycle of predicates has no data source to name
    seen.add(id);
    const ins = inbound.get(id) ?? [];
    // A fan-in has no single "incoming item" — report the token instead of guessing a branch.
    if (ins.length !== 1) return null;
    const up = ins[0];
    const upType = plannedById.get(up)?.nodeType;
    if (upType && PASS_THROUGH_TYPES.has(upType)) {
      return dataPredecessorOf(up, seen);
    }
    return up;
  }

  // ── Pass 3: build the nodes (config translation needs the predecessor for `$json`) ───────────
  const nodes: NodeDef[] = [];
  const reports: N8nNodeReport[] = [];

  for (const p of planned) {
    if (!p.id || !p.nodeType) {
      reports.push({
        n8nName: p.n8nName,
        n8nType: p.n8nType,
        nodeId: null,
        nodeType: null,
        status: p.status,
        notes: p.notes,
      });
      continue;
    }
    // n8n's `$json` is "the incoming item". With a fan-in there is no single upstream to bind it to,
    // so leave it null — convertN8nExpression then reports each such token as unconverted rather
    // than picking an arbitrary branch. Predicate nodes are walked THROUGH (see below).
    const predecessorId = dataPredecessorOf(p.id);
    const ctx: TranslateCtx = {
      nodeId: p.id,
      params: asRecord(p.raw.parameters),
      predecessorId,
      nameToId,
      notes: p.notes,
      exprSink,
    };
    const translated = translateConfig(p.nodeType, ctx);
    const config: Record<string, unknown> = { ...p.baseConfig, ...translated };

    // Unmapped placeholders carry the ORIGINAL n8n node verbatim so nothing is lost. `noOp` has no
    // concrete schema (permissive record) and the save path persists the original graph bytes, so
    // this survives a round-trip untouched.
    if (p.status === "unmapped") {
      config.__n8n = {
        type: p.n8nType,
        typeVersion: p.raw.typeVersion ?? null,
        // Verbatim EXCEPT the prototype-polluting keys. This is the one path that stores raw
        // imported parameters (convertN8nValueDeep's guarded output is discarded below, because
        // converting would rewrite the strings we promised to preserve), so the guard has to be
        // applied here or an untrusted `__proto__` survives into the stored graph.
        parameters: stripPollutingKeys(asRecord(p.raw.parameters)) as Record<
          string,
          unknown
        >,
      };
      // A placeholder's parameters aren't translated (there is nothing to translate them INTO), but
      // any expression inside them is still work the user must redo — so scan for the unconvertible
      // ones and report them. The converted value is discarded; `__n8n` keeps the original verbatim.
      const scan = convertN8nValueDeep(
        asRecord(p.raw.parameters),
        predecessorId,
        nameToId,
        "__n8n.parameters",
      );
      for (const u of scan.unconverted) {
        exprSink.push({ nodeId: p.id, ...u });
      }
    }
    const notes = asString(p.raw.notes);
    if (notes) config.__n8nNote = notes;

    // Any node that used a credential in n8n needs one attached HERE, by hand. Noted per node (not
    // just in the workflow-level credential summary) because this is the one thing the user must do
    // before the imported workflow can run, and it has to be visible next to the node that needs it.
    const usedCreds = Object.keys(asRecord(p.raw.credentials));
    if (usedCreds.length > 0) {
      p.notes.push(
        `used the n8n credential type(s) ${usedCreds.join(", ")} — credentials are never imported. Create the matching connection here and attach it to this node.`,
      );
      if (p.status === "imported") p.status = "approximated";
    }

    const node: NodeDef = { id: p.id, type: p.nodeType, name: p.n8nName };
    if (Object.keys(config).length > 0) node.config = config;
    if (
      p.raw.onError === "continueRegularOutput" ||
      p.raw.continueOnFail === true
    ) {
      node.onError = "continue";
    }
    nodes.push(node);
    reports.push({
      n8nName: p.n8nName,
      n8nType: p.n8nType,
      nodeId: p.id,
      nodeType: p.nodeType,
      status: p.status,
      notes: p.notes,
    });
  }

  // ── Pass 2b: branch conditions (needs the Switch rules pass 3 just produced) ─────────────────
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const edges: EdgeDef[] = plannedEdges.map(
    ({ from, to, source, outputIndex }) => {
      // n8n gives a branching node one OUTPUT PER BRANCH; we give every node one output and put the
      // branch on the edge. So output index → edge condition.
      if (source.nodeType === "if") {
        // n8n's IF: output 0 = true, output 1 = false. Our `if` node outputs `{ result: boolean }`.
        return {
          from,
          to,
          condition: {
            path: `${from}.result`,
            op: "eq",
            value: outputIndex === 0,
          },
        };
      }
      if (source.nodeType === "switch") {
        const cfg = nodeById.get(from)?.config ?? {};
        const rules = (cfg.rules ?? []) as Array<{ name: string }>;
        // n8n's EXTRA fallback output sits just past the rules. Our switch names it via
        // `config.fallback` and emits that name in `matched`, so the edge is gated like any other.
        // Leaving it unconditional would fire the fallback branch on EVERY run, whichever rule
        // actually matched — the whole reason `fallback` is translated at all.
        const name =
          rules[outputIndex]?.name ??
          (outputIndex === rules.length
            ? (asString(cfg.fallback) ?? undefined)
            : undefined);
        if (name === undefined) {
          source.notes.push(
            `n8n output #${outputIndex} has no matching switch rule and the node declares no fallback output — that edge is UNCONDITIONAL, so it always fires; gate it by hand or set the switch's \`fallback\`.`,
          );
          return { from, to };
        }
        // Our `switch` outputs `{ matched: <rule name | fallback name> }`.
        return {
          from,
          to,
          condition: { path: `${from}.matched`, op: "eq", value: name },
        };
      }
      if (outputIndex > 0) {
        source.notes.push(
          `n8n output #${outputIndex} was folded into this node's single output — we have one output per node and branch on edge conditions instead.`,
        );
      }
      return { from, to };
    },
  );

  // ── Fold LLM sub-nodes into their parent agent ───────────────────────────────────────────────
  for (const [subName, sub] of subNodes) {
    const subType = asString(sub.type) ?? "";
    const provider = N8N_LM_PROVIDER[subType];
    // `model` is a resource locator in newer n8n versions and a bare string in older ones.
    const model =
      asPicked(asRecord(sub.parameters).model) ??
      asPicked(asRecord(sub.parameters).modelName);
    // The sub-node is the SOURCE of the ai_* connection, so its parent is its connection target.
    for (const [connType, outputs] of Object.entries(
      connections[subName] ?? {},
    )) {
      if (connType === "main" || !Array.isArray(outputs)) continue;
      for (const group of outputs) {
        for (const link of group ?? []) {
          const parentId = nameToId.get(asString(link?.node) ?? "");
          const parent = nodes.find((n) => n.id === parentId);
          if (!parent || parent.type !== "agent") continue;
          parent.config ??= {};
          if (provider && parent.config.provider === undefined) {
            parent.config.provider = provider;
          }
          if (model && parent.config.model === undefined) {
            parent.config.model = model;
            reports
              .find((r) => r.nodeId === parentId)
              ?.notes.push(
                `model '${model}' came from the attached n8n '${subName}' sub-node — check it is a model we support, and add your own provider key.`,
              );
          } else if (!provider) {
            reports
              .find((r) => r.nodeId === parentId)
              ?.notes.push(
                `the attached n8n sub-node '${subName}' (${subType}) has no equivalent here — re-create it as an MCP tool, a memory setting, or an outputSchema.`,
              );
          }
        }
      }
    }
  }

  // ── Merge fan-in: our validator rejects a CONDITIONAL edge into a merge ─────────────────────
  const mergeIds = new Set(
    nodes.filter((n) => n.type === "merge").map((n) => n.id),
  );
  for (const e of edges) {
    if (e.condition && mergeIds.has(e.to)) {
      delete e.condition;
      const r = reports.find((x) => x.nodeId === e.to);
      if (r) {
        r.status = r.status === "imported" ? "approximated" : r.status;
        r.notes.push(
          `the branch condition on the edge from '${e.from}' was removed: a merge requires unconditional fan-in here, so it now waits for EVERY inbound branch. Re-model the join if the branches were mutually exclusive.`,
        );
      }
    }
  }

  // ── Entry node ──────────────────────────────────────────────────────────────────────────────
  const ENTRY_TYPES: ReadonlySet<string> = new Set([
    "start",
    "webhookTrigger",
    "scheduleTrigger",
    "pollTrigger",
    "formTrigger",
    "chatTrigger",
    "errorTrigger",
    "mcpServerTrigger",
  ]);
  const hasNoInbound = (n: NodeDef): boolean => !inbound.get(n.id)?.length;
  // Prefer a trigger with no inbound edge; then any trigger; then any source node.
  let start =
    nodes.find((n) => ENTRY_TYPES.has(n.type) && hasNoInbound(n)) ??
    nodes.find((n) => ENTRY_TYPES.has(n.type)) ??
    nodes.find(hasNoInbound);

  const multipleTriggers =
    nodes.filter((n) => ENTRY_TYPES.has(n.type) && hasNoInbound(n)).length > 1;

  if (!start) {
    // Every node has an inbound edge (a fully cyclic import) — synthesize an entry.
    const id = slugifyId("start", usedIds);
    start = { id, type: "start" as NodeType, name: "Start" };
    nodes.unshift(start);
    const first = nodes[1];
    if (first) {
      edges.push({ from: start.id, to: first.id });
      noteInbound(start.id, first.id);
    }
    warnings.push(
      "No trigger node was found, so a manual start node was added at the front.",
    );
  }
  // `validateGraph` rejects a multi-node graph whose start has no outgoing edge ("disconnected"),
  // which an export with a stray/unwired trigger would otherwise produce.
  if (nodes.length > 1 && !edges.some((e) => e.from === start.id)) {
    const orphan = nodes.find((n) => n.id !== start.id && hasNoInbound(n));
    const target = orphan ?? nodes.find((n) => n.id !== start.id);
    if (target) {
      edges.push({ from: start.id, to: target.id });
      noteInbound(start.id, target.id);
      warnings.push(
        `The entry node '${start.id}' had no outgoing connection in the export, so it was wired to '${target.id}' to keep the graph connected — check the flow.`,
      );
    }
  }
  if (multipleTriggers) {
    warnings.push(
      "The export has more than one trigger. A graph has ONE entry node here; the others were imported as nodes but will not start a run — split them into separate workflows.",
    );
  }
  if (start.type === "scheduleTrigger") {
    warnings.push(
      "This workflow's entry is a schedule trigger: SAVING it creates a live cron schedule. Review the cron expression (and the workflow's active flag) before you save.",
    );
  }
  if (wf.active === true) {
    warnings.push(
      "The n8n workflow was active. Imported workflows are never activated automatically — activate it here when you have reconnected its credentials.",
    );
  }

  // ── Credentials: types only, never an id or an account name ─────────────────────────────────
  const credMap = new Map<string, Set<string>>();
  for (const entry of rawNodes) {
    const raw: RawN8nNode = asRecord(entry);
    const creds = asRecord(raw.credentials);
    const owner = asString(raw.name) ?? "(unnamed)";
    for (const credType of Object.keys(creds)) {
      const set = credMap.get(credType) ?? new Set<string>();
      set.add(owner);
      credMap.set(credType, set);
    }
  }
  const credentials: N8nCredentialReport[] = [...credMap.entries()]
    .map(([n8nType, usedBy]) => ({
      n8nType,
      usedBy: [...usedBy].sort(),
      suggestedConnectionType: Object.prototype.hasOwnProperty.call(
        N8N_CREDENTIAL_HINT,
        n8nType,
      )
        ? N8N_CREDENTIAL_HINT[n8nType]
        : null,
    }))
    .sort((a, b) => a.n8nType.localeCompare(b.n8nType));
  if (credentials.length > 0) {
    warnings.push(
      `${credentials.length} credential type(s) were referenced and NOT imported — secrets never cross an import. Create the matching connections, then attach them to the nodes listed in the report.`,
    );
  }

  const counts: Record<N8nMapStatus, number> = {
    imported: 0,
    approximated: 0,
    unmapped: 0,
    skipped: 0,
  };
  for (const r of reports) counts[r.status] += 1;

  return {
    name: asString(wf.name) ?? "Imported n8n workflow",
    graph: { nodes, edges, startNodeId: start.id },
    nodes: reports,
    credentials,
    unconvertedExpressions: exprSink,
    warnings,
    counts,
  };
}
