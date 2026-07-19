import type { GraphDef } from "@naary/dsl";
import { computeCost } from "@naary/usage";
import type { GenMeter } from "../graphs/graph-generator.service";

/** A tiny non-zero cost so a turn is NEVER silently free when we can't price it at all (unknown
 *  model). Well below a real turn's cost — it flags "unpriced", it doesn't fabricate a bill. */
const NOMINAL_TURN_COST_USD = 0.0001;

/**
 * USD cost of one builder turn (Tier-1 §6 — never record zero for a real model call).
 * - Real usage → price it via the shared ledger pricing.
 * - No usage (claude-code subprocess always; the AI-SDK v6 usage-undefined bug) → ESTIMATE the
 *   tokens from the produced graph's size (~4 chars/token, input≈output as a rough symmetric
 *   guess) and price that. An approximate charge beats a free call.
 * - Unpriced provider/model → a nominal non-zero floor.
 */
export function estimateTurnCostUsd(meter: GenMeter, graph: GraphDef): number {
  let { inputTokens, outputTokens, cachedInputTokens } = meter.tokens ?? {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
  };
  if (!meter.tokens) {
    const approx = Math.max(1, Math.ceil(JSON.stringify(graph).length / 4));
    outputTokens = approx;
    inputTokens = approx; // prompt (prior graph + catalog) is at least this big — rough but non-zero
    cachedInputTokens = 0;
  }
  try {
    const cost = computeCost({
      provider: meter.provider,
      model: meter.model,
      inputTokens,
      outputTokens,
      cachedInputTokens,
    });
    return cost > 0 ? cost : NOMINAL_TURN_COST_USD;
  } catch {
    return NOMINAL_TURN_COST_USD;
  }
}

/** A short, non-sensitive assistant-turn summary of the change (the model returns a graph, not
 *  prose — we do NOT spend a second model call to summarize). Shape only: node/edge counts. */
export function summarizeChange(name: string, graph: GraphDef): string {
  const n = graph.nodes.length;
  const e = graph.edges.length;
  const label = name?.trim() || "Workflow";
  return `Updated “${label}” — ${n} node${n === 1 ? "" : "s"}, ${e} edge${e === 1 ? "" : "s"}.`;
}

/** Derive a session title from the first user message (trimmed, single line, capped). */
export function deriveTitle(message: string): string {
  return message.trim().replace(/\s+/g, " ").slice(0, 120);
}
