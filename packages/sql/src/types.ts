/** Engines the sqlQuery node can talk to. Add a new one with its own adapter +
 *  connection `type` (see the engine backlog). */
export type SqlEngine = "postgres" | "mssql";

export interface SqlQueryRows {
  rows: unknown[];
  rowCount: number;
}

/**
 * One read-only query against a tenant database. Each engine implements its own
 * read-only strategy (see the adapters) and its own placeholder binding, but the
 * rest of the node is engine-agnostic. The DSN is used in-memory only — it is a
 * secret and must never be returned or logged.
 */
export interface SqlEngineAdapter {
  engine: SqlEngine;
  runReadOnly(
    dsn: string,
    sql: string,
    params: unknown[],
    opts: { timeoutMs: number },
  ): Promise<SqlQueryRows>;
}
