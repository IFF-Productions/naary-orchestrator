/**
 * THE AGENT OUTPUT CONTRACT (#830 / #1016).
 *
 * An agent node returns a STRUCTURED object only when its config carries an `outputSchema`.
 * Without one it returns free text as `{ text }` — so a graph that asks for JSON in the
 * `systemPrompt` and then reads `<agentId>.output.<field>` downstream reads a field that can
 * never exist. Nothing errors: the read resolves to `undefined` and the flow carries on in
 * whatever direction `undefined` happens to take it.
 *
 * That is how `moderationGraph` shipped a moderation gate that failed OPEN (`flagged` undefined
 * ⇒ `eq true` never matched and `neq true` always did — every submission auto-accepted, the
 * human-review branch unreachable). A prompt is a request; the schema is the contract.
 *
 * This module holds the two pure primitives that fact needs, so the template drift guard, the
 * canvas lint and the #1016 fork migration all agree on ONE definition of "reads a field" and
 * "promises a field" rather than keeping three:
 *
 *   - [[agentOutputReads]]  — every `<nodeId>.output.<field>` a graph reads.
 *   - [[promisedAgentFields]] — the fields a node's config actually promises.
 *
 * Zero dependencies on purpose (it is reachable from the DSL barrel, which rides the
 * deterministic Temporal workflow bundle — Tier-1 rule 2).
 */
import { type AgentHandoff, handoffOutputSchema } from "./handoff";
import type { GraphDef, NodeDef } from "./types";
import type { TemplateWarning } from "./template";

/** One `<from>.output.<field>` read, and where in the graph it was written. */
export interface AgentOutputRead {
  /** The node whose output is read — the agent that must promise `field`. */
  from: string;
  /** The field after `output.`, e.g. "flagged". */
  field: string;
  /**
   * Where the read lives, for a human-readable message: an edge condition (`edge <from>→<to>
   * condition`) or a node's binding (`<nodeId>.argumentBindings.<key>`). Never used for
   * matching — only for explaining.
   */
  where: string;
}

/**
 * Every `(nodeId, field)` a graph reads out of another node's output.
 *
 * Two shapes, because the DSL has two ways to point at an upstream output:
 *   - edge conditions — `condition.path = "<id>.output.<field>"`;
 *   - structured bindings — `config.argumentBindings.<key> = { from: "<id>", path: "output.<field>" }`
 *     (mcpTool's arguments, and anything else that uses the same binding shape).
 *
 * `[\w-]` not `\w`: node ids may contain hyphens, and a guard against silent skipping that
 * silently skipped `check-content.output.flagged` would be its own punchline.
 *
 * `output.text` IS collected — callers decide whether to care. A schema-less agent genuinely
 * promises `text`, so [[promisedAgentFields]] is what makes that read legitimate, not an
 * exclusion here.
 */
export function agentOutputReads(graph: GraphDef): AgentOutputRead[] {
  const out: AgentOutputRead[] = [];
  for (const e of graph.edges ?? []) {
    const path = e.condition?.path;
    const m =
      typeof path === "string"
        ? /^([\w-]+)\.output\.([\w-]+)/.exec(path)
        : null;
    if (m) {
      out.push({
        from: m[1],
        field: m[2],
        where: `edge ${e.from}→${e.to} condition`,
      });
    }
  }
  for (const n of graph.nodes ?? []) {
    const bindings = (
      n.config as
        | {
            argumentBindings?: Record<string, { from?: string; path?: string }>;
          }
        | undefined
    )?.argumentBindings;
    for (const [key, b] of Object.entries(bindings ?? {})) {
      const bm =
        typeof b?.path === "string" ? /^output\.([\w-]+)/.exec(b.path) : null;
      if (bm && b.from) {
        out.push({
          from: b.from,
          field: bm[1],
          where: `${n.id}.argumentBindings.${key}`,
        });
      }
    }
  }
  return out;
}

/**
 * The schema the RUNTIME will actually use for this node — the one place that decides whether an
 * agent is structured, mirroring `agent.ts` line for line:
 *
 *   const effectiveOutputSchema = cfg.handoff ? handoffOutputSchema(cfg.handoff) : cfg.outputSchema;
 *   const wantStructured = effectiveOutputSchema !== undefined;
 *
 * Two things this must NOT get wrong, both of which it originally did:
 *
 *  - **`!== undefined`, not "has properties".** An explicit `outputSchema: {}` turns structured
 *    mode ON. Treating it as schema-less models a different agent than the one that runs — and
 *    `{}` is not hypothetical: it is exactly the shape that made Anthropic reject
 *    structured-output requests, so real graphs carry it.
 *  - **`handoff` derives a REAL schema**, not one magic field. `handoffOutputSchema` declares
 *    `target`, `payload`, and `reason` unless `explain: false`. Calling it here rather than
 *    re-listing those is what stops this drifting from the activity — the same reason its own
 *    docstring gives for being shared with the save gate.
 *
 * Never throws: it runs over half-authored canvas graphs, where `handoff.targets` may not be an
 * array yet. A malformed handoff falls back to "structured, promising nothing", which pushes the
 * migration toward SKIPPING ([[matchFailingOpenFork]] clause 3) — the safe direction.
 */
function effectiveOutputSchema(
  node: NodeDef,
): Record<string, unknown> | undefined {
  const cfg = node.config as
    { outputSchema?: unknown; handoff?: unknown } | undefined;
  if (cfg?.handoff !== undefined && cfg.handoff !== null) {
    const handoff = cfg.handoff as AgentHandoff;
    if (!Array.isArray(handoff?.targets)) return {};
    try {
      return handoffOutputSchema(handoff);
    } catch {
      // A half-authored handoff (a target with no `to`, say). It is still STRUCTURED at run
      // time — the fact that matters here — we just cannot name its fields.
      return {};
    }
  }
  return cfg?.outputSchema as Record<string, unknown> | undefined;
}

/**
 * The fields a node actually PROMISES.
 *
 * Structured ⇒ exactly the properties its effective schema declares, and **no `text`**: the
 * activity returns either the structured object or `{ text }`, never both. Not structured ⇒
 * exactly `text`.
 */
export function promisedAgentFields(node: NodeDef): Set<string> {
  const schema = effectiveOutputSchema(node);
  if (schema === undefined) return new Set(["text"]);
  const properties = (schema as { properties?: Record<string, unknown> })
    .properties;
  return new Set(Object.keys(properties ?? {}));
}

/** Whether this node runs in the activity's STRUCTURED mode. See [[effectiveOutputSchema]]. */
export function hasStructuredOutput(node: NodeDef): boolean {
  return effectiveOutputSchema(node) !== undefined;
}

/**
 * Does this prompt ASK the model for JSON?
 *
 * Deliberately liberal — this feeds a WARNING, never an edit and never a save rejection. A
 * mention of JSON is the cheapest available signal that the author expected structured output,
 * and #1016's decision is explicit that the broad shape gets NOTIFIED rather than rewritten:
 * "a free-text agent whose prompt happens to mention JSON is a legitimate authoring choice."
 *
 * The one narrowing: a bare mention is not enough on its own — some directive to PRODUCE it has
 * to be nearby, so "Summarize the JSON payload you are given" (JSON as INPUT) doesn't warn.
 */
const JSON_DIRECTIVE =
  /\b(respond|reply|return|answer|output|emit|produce|format(?:ted)?|give|send|write|as|only|valid|object|schema)\b[^.!?\n]{0,80}\bjson\b|\bjson\b[^.!?\n]{0,80}\b(only|object|format|schema|response|output)\b/i;

export function promptRequestsJson(systemPrompt: unknown): boolean {
  return typeof systemPrompt === "string" && JSON_DIRECTIVE.test(systemPrompt);
}

/**
 * NON-BLOCKING lint: agent nodes whose output is treated as structured but which declare no
 * `outputSchema` (#1016, the NOTIFY half).
 *
 * This never edits and never rejects a save. It is the same channel the canvas already uses for
 * unknown-node references — an author-time warning next to the node that needs the fix, which is
 * the right place for a judgement the tool is not confident enough to make on the author's
 * behalf. Two reasons, strongest first:
 *
 *   1. A CROSS-NODE READ of a field the agent never promised. Guaranteed `undefined` at run
 *      time — this is the same check the shipped-template drift guard runs, pointed at
 *      tenant-authored graphs. Not a heuristic.
 *   2. The prompt ASKS for JSON and the node declares no schema. A heuristic, and knowingly so:
 *      a free-text agent may legitimately mention JSON. It costs a dismissible warning row and
 *      it is how the author of a graph too customized to migrate still finds out.
 *
 * Reported AGAINST THE AGENT NODE, not the reader: the schema is what's missing, and the agent
 * is where it goes. Clicking the row lands on the node you have to edit.
 */
export function lintAgentOutputContract(graph: GraphDef): TemplateWarning[] {
  const byId = new Map((graph.nodes ?? []).map((n) => [n.id, n]));
  const warnings: TemplateWarning[] = [];
  const flagged = new Set<string>();
  // One row per (node, FIELD), not per read site. `moderationGraph` reads `classify.output.
  // flagged` from BOTH of its outgoing edges; two identical rows in the panel would be noise,
  // and the fix is one edit either way. Distinct missing fields still get distinct rows —
  // `jiraTicketGraph` is missing four, and naming each is the point.
  const seen = new Set<string>();

  for (const read of agentOutputReads(graph)) {
    const node = byId.get(read.from);
    // Only agents carry an outputSchema contract; every other node type's output shape is
    // defined by what the node does, not by a schema the author may have forgotten.
    if (node?.type !== "agent") continue;
    if (promisedAgentFields(node).has(read.field)) continue;
    const key = JSON.stringify([node.id, read.field]);
    if (seen.has(key)) continue;
    seen.add(key);
    flagged.add(node.id);
    warnings.push({
      nodeId: node.id,
      field: "outputSchema",
      ref: `${read.from}.output.${read.field}`,
      message:
        `declares no output field "${read.field}", but ${read.where} reads it — an agent ` +
        "returns structured fields ONLY when its config carries an outputSchema, so this " +
        "is undefined at run time. Add the field to this node's Output schema.",
    });
  }

  for (const node of graph.nodes ?? []) {
    if (node.type !== "agent" || flagged.has(node.id)) continue;
    if (hasStructuredOutput(node)) continue;
    const cfg = node.config as { systemPrompt?: unknown } | undefined;
    if (!promptRequestsJson(cfg?.systemPrompt)) continue;
    warnings.push({
      nodeId: node.id,
      field: "outputSchema",
      ref: "systemPrompt",
      message:
        "the prompt asks for JSON but this node declares no outputSchema, so it returns free " +
        "text as `text` and any structured field read from it is undefined. Add an Output " +
        "schema if downstream nodes expect fields — a prompt is a request, the schema is the " +
        "contract.",
    });
  }

  return warnings;
}
