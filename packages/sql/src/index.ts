import { mssqlAdapter } from "./mssql";
import { mysqlAdapter } from "./mysql";
import { postgresAdapter } from "./postgres";
import type { SqlEngine, SqlEngineAdapter } from "./types";

export type {
  SqlEngine,
  SqlEngineAdapter,
  SqlQueryRows,
  SqlRunOptions,
  SqlWriteResult,
} from "./types";
export { connectPinned, pinnedPgStream, pinnedTediousConnector } from "./pin";
export { dsnHost } from "./dsn";
export {
  SQL_SCHEMA_MAX_COLUMNS,
  SQL_SCHEMA_MAX_TABLES,
  buildSchemaQuery,
  summarizeSchemaRows,
} from "./schema";
export type { SqlColumnInfo, SqlSchemaSummary, SqlTableInfo } from "./schema";

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
