import { evaluateCondition } from "./branch";
import { getByPath } from "./mcp-args";
import type {
  AggregateNodeConfig,
  FilterNodeConfig,
  ListOpsNodeConfig,
} from "./types";

/** Read the array an array-node operates on from ctx (non-array → []). */
function readArray(
  from: string,
  path: string | undefined,
  ctx: Record<string, unknown>,
): unknown[] {
  const v = getByPath(ctx[from], path);
  return Array.isArray(v) ? v : [];
}

/**
 * Filter node — keep the array items whose per-item predicate holds. Pure,
 * deterministic (ctx path-read + structured predicate, no I/O). The `EdgeCondition`
 * is evaluated with the ITEM as the context, so `condition.path` is item-relative.
 */
export function resolveFilter(
  config: FilterNodeConfig,
  ctx: Record<string, unknown>,
): unknown[] {
  return readArray(config.from, config.path, ctx).filter((item) =>
    evaluateCondition(
      config.condition,
      (item !== null && typeof item === "object"
        ? (item as Record<string, unknown>)
        : {}) as Record<string, unknown>,
    ),
  );
}

/**
 * Aggregate node — collapse an upstream array into `{ result }`. Pure + total: an
 * empty/non-array source yields the operation's identity ([]/0/undefined).
 */
export function resolveAggregate(
  config: AggregateNodeConfig,
  ctx: Record<string, unknown>,
): { result: unknown } {
  const arr = readArray(config.from, config.path, ctx);
  const pick = (item: unknown): unknown =>
    config.field ? getByPath(item, config.field) : item;

  switch (config.operation) {
    case "count":
      return { result: arr.length };
    case "collect":
      return { result: arr.map(pick) };
    case "sum":
      return {
        result: arr.reduce<number>((acc, item) => {
          const n = Number(pick(item));
          return acc + (Number.isFinite(n) ? n : 0);
        }, 0),
      };
    case "first":
      return { result: arr.length ? pick(arr[0]) : undefined };
    case "last":
      return { result: arr.length ? pick(arr[arr.length - 1]) : undefined };
    default:
      return { result: undefined };
  }
}

/**
 * List Ops node — sort / limit / dedupe an upstream array → array. Pure + total
 * (non-array source → []). Sort/dedupe use `field` (item-relative) or the whole
 * item; sort compares numbers numerically, otherwise as strings.
 */
export function resolveListOps(
  config: ListOpsNodeConfig,
  ctx: Record<string, unknown>,
): unknown[] {
  const arr = readArray(config.from, config.path, ctx);
  const pick = (item: unknown): unknown =>
    config.field ? getByPath(item, config.field) : item;

  switch (config.operation) {
    case "limit": {
      const n = config.count && config.count > 0 ? config.count : 0;
      return arr.slice(0, n);
    }
    case "dedupe": {
      const seen = new Set<string>();
      const out: unknown[] = [];
      for (const item of arr) {
        const key = JSON.stringify(pick(item) ?? null);
        if (!seen.has(key)) {
          seen.add(key);
          out.push(item);
        }
      }
      return out;
    }
    case "sort": {
      const dir = config.order === "desc" ? -1 : 1;
      return [...arr].sort((a, b) => {
        const av = pick(a);
        const bv = pick(b);
        if (typeof av === "number" && typeof bv === "number") {
          return (av - bv) * dir;
        }
        return String(av).localeCompare(String(bv)) * dir;
      });
    }
    default:
      return arr;
  }
}
