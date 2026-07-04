import { getByPath } from "./mcp-args";
import type { SqlExecNodeConfig, SqlQueryNodeConfig } from "./types";

/**
 * A sqlQuery node's concrete query after binding resolution — the plain object the
 * `callSqlQuery` activity receives. The `sql` text is carried VERBATIM; bindings
 * only populate `params` (positional values), never the query string.
 */
export interface ResolvedSqlQuery {
  connectionId: string;
  sql: string;
  params: unknown[];
  statementTimeoutMs?: number;
  costUsd?: number;
}

/**
 * Resolve a sqlQuery node's params from the run context (the map of node id → that
 * node's output). Static `params` are the base; each `paramBindings[i]` overrides
 * position `i` (1-based) with the upstream value via `getByPath`. The `sql` string
 * is passed through untouched — a binding can NEVER alter the query text (that
 * would be SQL injection). Pure + deterministic, so it runs in the interpreter.
 */
export function resolveSqlQuery(
  config: SqlQueryNodeConfig,
  ctx: Record<string, unknown>,
): ResolvedSqlQuery {
  const params: unknown[] = [...(config.params ?? [])];
  for (const [index, binding] of Object.entries(config.paramBindings ?? {})) {
    const pos = Number(index) - 1; // 1-based in config → 0-based array
    if (pos < 0) continue;
    params[pos] = getByPath(ctx[binding.from], binding.path);
  }
  return {
    connectionId: config.connectionId,
    sql: config.sql,
    params,
    statementTimeoutMs: config.statementTimeoutMs,
    costUsd: config.costUsd,
  };
}

/**
 * A sqlExec node's concrete write after binding resolution. Same shape + rules as
 * ResolvedSqlQuery (bindings only fill positional params, never the SQL text).
 */
export type ResolvedSqlExec = ResolvedSqlQuery;

/** Resolve a sqlExec node's params — identical binding rules to resolveSqlQuery
 *  (positional params only; the SQL text is passed through untouched). */
export function resolveSqlExec(
  config: SqlExecNodeConfig,
  ctx: Record<string, unknown>,
): ResolvedSqlExec {
  return resolveSqlQuery(config as SqlQueryNodeConfig, ctx);
}
