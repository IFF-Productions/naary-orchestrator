import { mssqlAdapter } from "./mssql";
import { mysqlAdapter } from "./mysql";
import { postgresAdapter } from "./postgres";
import type { SqlEngine, SqlEngineAdapter } from "./types";

export type {
  SqlEngine,
  SqlEngineAdapter,
  SqlQueryRows,
  SqlWriteResult,
} from "./types";

const ADAPTERS: Record<SqlEngine, SqlEngineAdapter> = {
  postgres: postgresAdapter,
  mssql: mssqlAdapter,
  mysql: mysqlAdapter,
};

/** Resolve the adapter (read + write) for an engine. Throws on an unknown engine. */
export function getAdapter(engine: SqlEngine): SqlEngineAdapter {
  const adapter = ADAPTERS[engine];
  if (!adapter) throw new Error(`Unsupported SQL engine: ${engine}`);
  return adapter;
}
