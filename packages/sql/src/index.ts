import { mssqlAdapter } from "./mssql";
import { postgresAdapter } from "./postgres";
import type { SqlEngine, SqlEngineAdapter } from "./types";

export type { SqlEngine, SqlEngineAdapter, SqlQueryRows } from "./types";

const ADAPTERS: Record<SqlEngine, SqlEngineAdapter> = {
  postgres: postgresAdapter,
  mssql: mssqlAdapter,
};

/** Resolve the read-only adapter for an engine. Throws on an unknown engine. */
export function getAdapter(engine: SqlEngine): SqlEngineAdapter {
  const adapter = ADAPTERS[engine];
  if (!adapter) throw new Error(`Unsupported SQL engine: ${engine}`);
  return adapter;
}
