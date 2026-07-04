/** Engines the sqlQuery / sqlExec nodes can talk to. Add a new one with its own
 *  adapter + connection `type` (see the engine backlog). */
export type SqlEngine = "postgres" | "mssql" | "mysql";

export interface SqlQueryRows {
  rows: unknown[];
  rowCount: number;
}

/** Result of a write statement (INSERT/UPDATE/DELETE) — the affected row count. */
export interface SqlWriteResult {
  rowsAffected: number;
}

/**
 * A tenant database. `runReadOnly` runs a read-only query (each engine enforces
 * read-only its own way — see the adapters); `runWrite` runs an INSERT/UPDATE/DELETE
 * inside a transaction that COMMITs on success and ROLLBACKs on error. The rest of
 * the node is engine-agnostic. The DSN is used in-memory only — it is a secret and
 * must never be returned or logged.
 */
export interface SqlEngineAdapter {
  engine: SqlEngine;
  runReadOnly(
    dsn: string,
    sql: string,
    params: unknown[],
    opts: { timeoutMs: number },
  ): Promise<SqlQueryRows>;
  runWrite(
    dsn: string,
    sql: string,
    params: unknown[],
    opts: { timeoutMs: number },
  ): Promise<SqlWriteResult>;
}
