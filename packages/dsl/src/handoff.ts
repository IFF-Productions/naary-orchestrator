/**
 * Agent handoff (#580 Phase 1) — an agent routes to ONE of N named downstream agent
 * nodes with a typed payload.
 *
 * Deliberately NOT a new engine primitive (Tier-1 rule 1). A handoff is a thin,
 * declarative layer over two things that already exist:
 *
 *   1. the agent node's structured output (`outputSchema` → `Output.object`), and
 *   2. edge conditions (`{ path, op, value }` → `evaluateCondition` / `nextNodes`).
 *
 * The agent activity turns `handoff.targets` into the output schema, so the model must
 * pick one of the declared target NAMES (a JSON-Schema `enum` — it cannot invent a
 * route), and each outgoing edge carries an `eq` condition on that chosen name. The
 * interpreter is untouched: it walks the same conditional edges it always has, and the
 * choice is produced inside an activity — so replay stays deterministic and no
 * `workflow.patched()` is needed.
 *
 * This module is zod-free ON PURPOSE: it is imported by `validateGraph` (branch.ts) and
 * therefore ends up in the deterministic Temporal workflow bundle, which must not pull
 * zod in. The zod mirror of these shapes lives in registry.ts (`CONFIG_SCHEMAS.agent`).
 */
import type { EdgeDef, NodeDef } from "./types";

/**
 * The field the derived output schema puts the chosen target NAME in, and therefore the
 * leaf of every handoff edge condition's path. Exported so the canvas/tests never
 * hardcode the string.
 */
export const HANDOFF_TARGET_FIELD = "target";

/** One agent a supervisor may hand off to. */
export interface HandoffTarget {
  /** The downstream node id that runs when this target is chosen. */
  to: string;
  /**
   * The name the MODEL chooses by (the enum value + the edge condition's value).
   * Defaults to `to`. Give a human/model-legible name ("refund_specialist") when the
   * node id is terse.
   */
  name?: string;
  /** What this specialist handles — the model reads this to decide. */
  description?: string;
}

/** `agent.config.handoff` — declares the routing choice this agent must make. */
export interface AgentHandoff {
  targets: HandoffTarget[];
  /**
   * JSON Schema for the `payload` the supervisor passes to the chosen specialist.
   * Omitted ⇒ an open object. The specialist reads it at `<supervisorId>.output.payload`.
   */
  payloadSchema?: Record<string, unknown>;
  /**
   * Require the model to explain the routing choice (adds a `reason` string to the
   * derived schema, and to the run's audit trail). Default true — a one-line reason is
   * cheap and makes a mis-route diagnosable from the run detail page.
   */
  explain?: boolean;
}

/** The name the model picks this target by. */
export function handoffTargetName(t: HandoffTarget): string {
  const n = t.name?.trim();
  return n ? n : t.to;
}

/**
 * The ctx path a handoff edge condition reads: `<agentId>.output.target`. Same
 * `<nodeId>.output.<field>` shape every other structured-output condition uses, so the
 * existing `getByPath` walk resolves it with no special-casing.
 */
export function handoffConditionPath(agentNodeId: string): string {
  return `${agentNodeId}.output.${HANDOFF_TARGET_FIELD}`;
}

/**
 * The agent's structured-output schema, derived from its declared targets. The `enum`
 * is what makes an invalid route impossible: the provider constrains generation to the
 * declared names, so the graph can never take an edge that doesn't exist.
 *
 * Used by BOTH the agent activity (to build `Output.object`) and the tests, so the
 * runtime contract and the save-gate can't drift.
 */
export function handoffOutputSchema(
  handoff: AgentHandoff,
): Record<string, unknown> {
  const names = handoff.targets.map(handoffTargetName);
  const properties: Record<string, unknown> = {
    [HANDOFF_TARGET_FIELD]: {
      type: "string",
      enum: names,
      description:
        "The one specialist to hand this off to. Choose exactly one of the listed names.",
    },
  };
  const required: string[] = [HANDOFF_TARGET_FIELD];

  if (handoff.explain !== false) {
    properties.reason = {
      type: "string",
      description: "One sentence on why this specialist is the right one.",
    };
    required.push("reason");
  }

  properties.payload = handoff.payloadSchema ?? {
    type: "object",
    description: "The typed payload to pass to the chosen specialist.",
    additionalProperties: true,
  };

  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}

/**
 * The canonical edges a handoff needs — one conditional edge per target, reading the
 * chosen name off the supervisor's output. Template authors (and, later, the canvas)
 * call this instead of hand-writing N conditions, which is exactly the mis-wiring
 * `validateHandoffs` below refuses to save.
 */
export function handoffEdges(
  agentNodeId: string,
  handoff: AgentHandoff,
): EdgeDef[] {
  const path = handoffConditionPath(agentNodeId);
  return handoff.targets.map((t) => ({
    from: agentNodeId,
    to: t.to,
    condition: { path, op: "eq" as const, value: handoffTargetName(t) },
  }));
}

/** Reads `config.handoff` off a node, or null when the node declares no handoff. */
export function readHandoff(node: NodeDef): AgentHandoff | null {
  const raw = (node.config as { handoff?: unknown } | undefined)?.handoff;
  if (!raw || typeof raw !== "object") return null;
  const targets = (raw as { targets?: unknown }).targets;
  if (!Array.isArray(targets)) return null;
  return raw as AgentHandoff;
}

/**
 * Save-gate rules for handoff, checked by `validateGraph`. Returns the first error
 * message, or null.
 *
 * This fires ONLY for nodes that carry a `handoff` — a brand-new field — so no graph
 * already in the wild can newly fail to save. What it catches, all of which would
 * otherwise surface as a broken RUN rather than a rejected save:
 *
 *  - a target pointing at a node that doesn't exist (typo'd id);
 *  - a declared target with no edge to it (the model picks it, the run dead-ends);
 *  - an UNCONDITIONAL edge from the supervisor to a target — the killer, because
 *    `nextNodes` returns *every* passing edge, so one missing condition silently fans
 *    out to that specialist on every single run regardless of the choice;
 *  - duplicate target names (two enum entries, ambiguous routing);
 *  - `handoff` together with an explicit `outputSchema` (two schemas, one call).
 */
export function validateHandoffs(graph: {
  nodes: NodeDef[];
  edges: EdgeDef[];
}): string | null {
  const ids = new Set(graph.nodes.map((n) => n.id));

  for (const node of graph.nodes) {
    const handoff = readHandoff(node);
    if (!handoff) continue;

    if (node.type !== "agent") {
      return `node '${node.id}' declares a handoff but is a '${node.type}' — handoff is an agent capability`;
    }
    if (handoff.targets.length === 0) {
      return `agent '${node.id}' declares a handoff with no targets`;
    }
    if (
      (node.config as { outputSchema?: unknown }).outputSchema !== undefined
    ) {
      return `agent '${node.id}' sets both 'handoff' and 'outputSchema' — the handoff derives the schema, so drop one`;
    }

    const seen = new Set<string>();
    const path = handoffConditionPath(node.id);
    const outgoing = graph.edges.filter((e) => e.from === node.id);

    for (const t of handoff.targets) {
      const name = handoffTargetName(t);
      if (seen.has(name)) {
        return `agent '${node.id}' has duplicate handoff target name '${name}'`;
      }
      seen.add(name);

      if (!ids.has(t.to)) {
        return `agent '${node.id}' hands off to unknown node '${t.to}'`;
      }
      const edge = outgoing.find((e) => e.to === t.to);
      if (!edge) {
        return `agent '${node.id}' hands off to '${t.to}' but has no edge to it`;
      }
      if (!edge.condition) {
        return `the edge '${node.id}' → '${t.to}' is unconditional, so it would run on every handoff — give it the condition ${path} eq '${name}'`;
      }
      if (edge.condition.path !== path) {
        return `the edge '${node.id}' → '${t.to}' must route on ${path} (found '${edge.condition.path}')`;
      }
      if (edge.condition.op !== "eq" || edge.condition.value !== name) {
        return `the edge '${node.id}' → '${t.to}' must be ${path} eq '${name}'`;
      }
    }
  }

  return null;
}
