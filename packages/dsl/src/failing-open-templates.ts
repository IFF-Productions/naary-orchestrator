/**
 * FORKS OF THE TEMPLATES THAT FAILED OPEN (#1016).
 *
 * #1015 fixed three shipped templates that told an agent to "respond with ONLY a JSON object"
 * and then read `output.<field>` downstream, with no `outputSchema` to make those fields exist:
 *
 *   - `moderation`           — `flagged` undefined ⇒ `eq true` never matched and `neq true`
 *                              ALWAYS did. The moderation gate failed OPEN: every submission
 *                              auto-accepted, the human-review branch unreachable.
 *   - `github-issue-triage`  — the triage comment posted an empty body; no labels were applied.
 *   - `jira-ticket`          — `create_issue` called with empty required arguments, AFTER a
 *                              human had approved a ticket the run could not create.
 *
 * A template is COPIED at instantiation, so fixing the template does nothing for the graphs a
 * tenant already forked from it. They still carry the schema-less agent, they still fail in the
 * quiet direction, and they will not self-heal. This module is the other half: it recognises a
 * fork and produces the corrected graph.
 *
 * ## The confidence bar
 *
 * This is tenant-authored data. A false positive here silently rewrites somebody's production
 * workflow, which is strictly worse than the bug — so the predicate is deliberately narrow, and
 * anything it declines falls through to the NOTIFY half ([[lintAgentOutputContract]]), which
 * warns without editing. "We don't know what they meant" is answered by telling the author, not
 * by guessing.
 *
 * [[matchFailingOpenFork]] states the full predicate. In short: the agent node must carry the
 * shipped template's VERBATIM legacy prompt, declare no output contract, sit in the template's
 * node/edge topology with the template's exact edge conditions, and every `output.<field>` the
 * graph reads from it must be a field the replacement schema declares.
 *
 * ## What the fix is
 *
 * ONLY the missing `outputSchema`, added to one node — exactly the schema the template carries
 * today, and nothing else. The prompt is NOT rewritten even though #1015 also tidied it: the
 * schema is what makes the graph correct, and every further edit is another change to a
 * workflow its author wrote.
 *
 * Zero dependencies beyond sibling DSL modules — this is reachable from the barrel, which rides
 * the deterministic Temporal workflow bundle (Tier-1 rule 2).
 */
import { agentOutputReads, hasStructuredOutput } from "./agent-output-contract";
import {
  githubIssueTriageGraph,
  jiraTicketGraph,
  moderationGraph,
} from "./templates";
import type { EdgeCondition, EdgeDef, GraphDef, NodeDef } from "./types";

/** Everything needed to recognise one legacy fork and correct it. */
export interface FailingOpenFingerprint {
  /** The shipped template's key, e.g. "moderation" — for the migration log, not for matching
   *  (the workflowKey a fork is saved under is chosen by the user and tells us nothing). */
  templateKey: string;
  /** The agent node that is missing its contract. */
  agentNodeId: string;
  /** The template's systemPrompt AS IT SHIPPED BEFORE #1015 — the string a fork carries. */
  legacySystemPrompt: string;
  /** The `outputSchema` the template carries today; undefined only if the template lost it
   *  (a drift the spec catches — a fingerprint with no schema never matches). */
  outputSchema: Record<string, unknown> | undefined;
  /** The template's entry node id. */
  startNodeId: string;
  /** Every node the template declares: id + type. */
  nodes: { id: string; type: string }[];
  /** Every edge the template declares, conditions included. */
  edges: EdgeDef[];
  /** What went wrong at run time, in one line — used in the migration log and the version note. */
  symptom: string;
}

/** The `outputSchema` a shipped template's agent node declares. */
function schemaOf(
  graph: GraphDef,
  nodeId: string,
): Record<string, unknown> | undefined {
  const cfg = graph.nodes.find((n) => n.id === nodeId)?.config as
    { outputSchema?: Record<string, unknown> } | undefined;
  return cfg?.outputSchema;
}

/**
 * Build a fingerprint from the SHIPPED template plus the one thing #1015 replaced — the legacy
 * prompt. Topology and the replacement schema are read from the live template rather than
 * copied, so this cannot drift out of sync with what a fresh instantiation gets today (which is
 * the whole definition of the fix: "exactly the schema the template now carries"). The
 * spec pins the derived result against a frozen pre-#1015 fixture, so a future template
 * redesign fails a test rather than silently narrowing the match.
 */
function fingerprint(
  templateKey: string,
  graph: GraphDef,
  agentNodeId: string,
  legacySystemPrompt: string,
  symptom: string,
): FailingOpenFingerprint {
  return {
    templateKey,
    agentNodeId,
    legacySystemPrompt,
    outputSchema: schemaOf(graph, agentNodeId),
    startNodeId: graph.startNodeId,
    nodes: graph.nodes.map((n) => ({ id: n.id, type: n.type })),
    edges: graph.edges.map((e) => ({
      from: e.from,
      to: e.to,
      ...(e.condition ? { condition: e.condition } : {}),
    })),
    symptom,
  };
}

/**
 * The three forks worth migrating. Nothing else: these are the graphs where we know precisely
 * what the node was supposed to be, because we shipped it.
 */
export const FAILING_OPEN_FINGERPRINTS: FailingOpenFingerprint[] = [
  fingerprint(
    "moderation",
    moderationGraph,
    "classify",
    'Classify the submitted content for policy violations. Respond with a JSON object: { "flagged": boolean, "reason": string }. Flag anything unsafe, spammy, or abusive.',
    "the moderation gate fails OPEN — every submission is auto-accepted and the human-review branch is unreachable",
  ),
  fingerprint(
    "github-issue-triage",
    githubIssueTriageGraph,
    "triage",
    'A GitHub issue was just opened. Read its title and body and respond with ONLY a JSON object: { "summary": string (a one-line triage note), "labels": string[] (from: "bug", "enhancement", "question", "documentation"), "priority": "low" | "medium" | "high" }. Be decisive.',
    "the triage comment posts an empty body and no labels are applied",
  ),
  fingerprint(
    "jira-ticket",
    jiraTicketGraph,
    "structure",
    'You turn an inbound request (a bug report, feature ask, or support message) into a Jira ticket. Respond with ONLY a JSON object: { "summary": string (a concise issue title), "description": string (clear, actionable detail), "issueType": "Bug" | "Task" | "Story", "priority": "Low" | "Medium" | "High" }.',
    "create_issue is called with empty required arguments, after a human approved a ticket the run cannot create",
  ),
];

/** Structural equality for two edge conditions. Conditions are small, flat, JSON-only data. */
function sameCondition(a?: EdgeCondition, b?: EdgeCondition): boolean {
  if (!a || !b) return !a && !b;
  if (a.path !== b.path || a.op !== b.op) return false;
  return JSON.stringify(a.value ?? null) === JSON.stringify(b.value ?? null);
}

/** Every distinct `<nodeId>.output.<field>` the graph mentions ANYWHERE — edge conditions and
 *  structured bindings (via [[agentOutputReads]]) plus any `{{ … }}` token or raw string in any
 *  node's config. The serialized sweep is deliberately over-broad: its only job is to make the
 *  migration REFUSE when a fork reads something the replacement schema doesn't cover, and
 *  over-detecting there costs a skipped migration, which is the safe direction. */
function outputFieldsReadFrom(graph: GraphDef, nodeId: string): Set<string> {
  const fields = new Set<string>();
  for (const read of agentOutputReads(graph)) {
    if (read.from === nodeId) fields.add(read.field);
  }
  // `[\w-]` for hyphenated node ids; the id is escaped because it is data, not a pattern.
  const escaped = nodeId.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
  const re = new RegExp(`${escaped}\\.output\\.([\\w-]+)`, "g");
  const serialized = JSON.stringify(graph.nodes.map((n) => n.config ?? {}));
  for (const m of serialized.matchAll(re)) fields.add(m[1]);
  return fields;
}

/**
 * Is this graph a fork of a template that failed open? Returns the fingerprint it matched, or
 * null.
 *
 * EVERY clause must hold. Each one on its own would be too weak; together they describe a graph
 * that could not plausibly have been authored deliberately:
 *
 *  1. The agent node exists under the template's id and is an `agent`.
 *  2. Its `systemPrompt` is the template's legacy prompt BYTE-FOR-BYTE. This is the anchor: a
 *     150–290 character piece of our prose, including its punctuation and its inline JSON
 *     sketch. Editing the prompt at all is the clearest possible signal that the author took
 *     ownership of this node — and it drops the graph to the notify half, which is correct.
 *  3. It declares NO output contract — no `outputSchema`, no `handoff`. A node that already has
 *     one is either already migrated or deliberately authored; either way we do not touch it.
 *     (This clause alone makes the migration idempotent.)
 *  4. `startNodeId` is the template's.
 *  5. Every node the template declares is present, with the same id AND the same type.
 *  6. Every edge the template declares is present, with an identical condition — including the
 *     two that read `classify.output.flagged`, the ones that made the gate fail open.
 *  7. Every `<agent>.output.<field>` the graph reads anywhere is a field the replacement schema
 *     DECLARES. This is what protects an author who worked AROUND the bug: a fork that reads
 *     `classify.output.text` is relying on the free-text shape, and giving it a schema would
 *     break something that works today. It does not match, and gets a warning instead.
 *
 * EXTRA nodes and edges are allowed. A fork with an added logging step is still the same broken
 * gate, we still know exactly what the agent was meant to promise, and clause 7 independently
 * guarantees nothing in the graph depends on the free-text shape.
 *
 * What it CANNOT fire on: a graph that satisfies all seven without being a fork would have to
 * have independently reproduced our prose verbatim, laid out our node ids and types, wired our
 * exact edge conditions against a field that can never exist, and then read only the fields our
 * schema happens to name. The failure mode of a MISS, by contrast, is benign — it falls through
 * to the notify half, which is the right answer for a graph we cannot read confidently.
 */
export function matchFailingOpenFork(
  graph: GraphDef,
): FailingOpenFingerprint | null {
  if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
    return null;
  }
  for (const fp of FAILING_OPEN_FINGERPRINTS) {
    if (!fp.outputSchema) continue; // template drift — never guess (see the spec's drift test)
    if (graph.startNodeId !== fp.startNodeId) continue;

    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    const agent = byId.get(fp.agentNodeId);
    if (!agent || agent.type !== "agent") continue;

    const cfg = agent.config as { systemPrompt?: unknown } | undefined;
    if (cfg?.systemPrompt !== fp.legacySystemPrompt) continue;
    if (hasStructuredOutput(agent)) continue;

    if (fp.nodes.some((n) => byId.get(n.id)?.type !== n.type)) continue;

    const hasEdge = (want: EdgeDef): boolean =>
      graph.edges.some(
        (e) =>
          e.from === want.from &&
          e.to === want.to &&
          sameCondition(e.condition, want.condition),
      );
    if (!fp.edges.every(hasEdge)) continue;

    const declared = new Set(
      Object.keys(
        (fp.outputSchema.properties as Record<string, unknown> | undefined) ??
          {},
      ),
    );
    const read = outputFieldsReadFrom(graph, fp.agentNodeId);
    if ([...read].some((f) => !declared.has(f))) continue;

    return fp;
  }
  return null;
}

/** A graph that matched, and the corrected graph to save as its next version. */
export interface FailingOpenMigration {
  fingerprint: FailingOpenFingerprint;
  /** The input graph with ONE change: the agent node gains the template's `outputSchema`. */
  graph: GraphDef;
}

/**
 * The corrected graph for a fork, or null if this graph is not one.
 *
 * PURE — the input is never mutated. The only edit is `outputSchema` on one node's config;
 * node order, every other config key (including canvas display metadata a re-saved graph
 * carries), every edge and the entry node are untouched, so the diff a tenant sees in version
 * history is exactly one added field.
 *
 * Idempotent by construction: the result carries an `outputSchema`, so clause 3 of
 * [[matchFailingOpenFork]] rejects it on a second pass and no second version is ever minted.
 */
export function migrateFailingOpenFork(
  graph: GraphDef,
): FailingOpenMigration | null {
  const fp = matchFailingOpenFork(graph);
  if (!fp?.outputSchema) return null;
  const schema = JSON.parse(JSON.stringify(fp.outputSchema)) as Record<
    string,
    unknown
  >;
  const nodes: NodeDef[] = graph.nodes.map((n) =>
    n.id === fp.agentNodeId
      ? { ...n, config: { ...(n.config ?? {}), outputSchema: schema } }
      : n,
  );
  return { fingerprint: fp, graph: { ...graph, nodes } };
}
