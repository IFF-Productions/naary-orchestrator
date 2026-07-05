import { evaluateCondition } from "./branch";
import type { SwitchNodeConfig } from "./types";

/**
 * Resolve a `switch` node's output from the run context. Evaluates the rules IN ORDER and
 * returns `{ matched }` = the first matching rule's `name`, else `fallback` (default
 * "default"). PURE + deterministic — reuses `evaluateCondition` (structured predicate, no
 * eval), so it runs in the interpreter like the other branching logic. Downstream edges
 * branch on `<switchId>.matched` with an `eq` condition.
 */
export function resolveSwitch(
  config: SwitchNodeConfig,
  ctx: Record<string, unknown>,
): { matched: string } {
  for (const rule of config.rules ?? []) {
    if (evaluateCondition(rule.condition, ctx)) {
      return { matched: rule.name };
    }
  }
  return { matched: config.fallback ?? "default" };
}
