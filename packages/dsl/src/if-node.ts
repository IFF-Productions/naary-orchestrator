import { evaluateCondition } from "./branch";
import type { IfNodeConfig } from "./types";

/**
 * Resolve an `if` node's output from the run context: combine its predicates with AND/OR →
 * `{ result: boolean }`. PURE + deterministic (reuses `evaluateCondition`, no eval). Empty
 * conditions ⇒ false (a gate with nothing to test doesn't pass). Downstream edges branch on
 * `<ifId>.result` with `eq true` / `eq false`.
 */
export function resolveIf(
  config: IfNodeConfig,
  ctx: Record<string, unknown>,
): { result: boolean } {
  const conditions = config.conditions ?? [];
  if (conditions.length === 0) return { result: false };
  const test = (c: (typeof conditions)[number]) => evaluateCondition(c, ctx);
  const result =
    config.combine === "or" ? conditions.some(test) : conditions.every(test);
  return { result };
}
