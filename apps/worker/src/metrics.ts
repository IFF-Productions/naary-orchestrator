import {
  type Counter,
  type Histogram,
  counter,
  histogram,
} from "@naary/metrics";

/**
 * Worker (activity) metrics. Labels are low-cardinality — activity name + outcome
 * — never tenant/run ids or prompt content.
 */
export const activityRuns: Counter<"activity" | "outcome"> = counter({
  name: "naary_activity_executions_total",
  help: "Activity executions by outcome",
  labelNames: ["activity", "outcome"],
});

export const activityDuration: Histogram<"activity"> = histogram({
  name: "naary_activity_duration_seconds",
  help: "Activity execution duration",
  labelNames: ["activity"],
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60],
});

export const agentTokens: Counter<"kind"> = counter({
  name: "naary_agent_tokens_total",
  help: "LLM tokens billed (input/output)",
  labelNames: ["kind"],
});

export const runCostUsd: Counter<string> = counter({
  name: "naary_run_cost_usd_total",
  help: "Accumulated agent + tool cost in USD",
});

/** Seconds elapsed since a process.hrtime.bigint() start mark. */
export function secondsSince(start: bigint): number {
  return Number(process.hrtime.bigint() - start) / 1e9;
}
