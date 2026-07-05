import { getByPath } from "./mcp-args";
import type { ArgBinding, NumberNodeConfig } from "./types";

/** Resolve one operand: an upstream binding wins over the static value; coerced to number. */
function operand(
  staticVal: number | undefined,
  binding: ArgBinding | undefined,
  ctx: Record<string, unknown>,
): number {
  const v = binding ? getByPath(ctx[binding.from], binding.path) : staticVal;
  return Number(v);
}

/**
 * Resolve a `number` node → `{ result }`. PURE + deterministic (plain arithmetic, no I/O).
 * Non-numeric operands coerce to NaN (which propagates — the graph can guard downstream);
 * divide-by-zero yields ±Infinity, per JS. Runs in the interpreter like the other pure nodes.
 */
export function resolveNumber(
  config: NumberNodeConfig,
  ctx: Record<string, unknown>,
): { result: number } {
  const a = operand(config.a, config.aBinding, ctx);
  const b = operand(config.b, config.bBinding, ctx);
  const p = config.precision ?? 0;
  let result: number;
  switch (config.operation) {
    case "add":
      result = a + b;
      break;
    case "subtract":
      result = a - b;
      break;
    case "multiply":
      result = a * b;
      break;
    case "divide":
      result = a / b;
      break;
    case "modulo":
      result = a % b;
      break;
    case "power":
      result = a ** b;
      break;
    case "round": {
      const f = 10 ** p;
      result = Math.round(a * f) / f;
      break;
    }
    case "floor":
      result = Math.floor(a);
      break;
    case "ceil":
      result = Math.ceil(a);
      break;
    case "abs":
      result = Math.abs(a);
      break;
    default:
      result = a;
  }
  return { result };
}
