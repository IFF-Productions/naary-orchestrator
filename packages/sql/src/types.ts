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
    opts: SqlRunOptions,
  ): Promise<SqlQueryRows>;
  runWrite(
    dsn: string,
    sql: string,
    params: unknown[],
    opts: SqlRunOptions,
  ): Promise<SqlWriteResult>;
}

export interface SqlRunOptions {
  timeoutMs: number;
  /**
   * The already-validated IP address to CONNECT to (SSRF connect-pinning, #597). The caller
   * resolves the DSN host once, checks the address, and passes it here; the adapter aims the
   * driver's socket at it while leaving the DSN's hostname in place for TLS. Omit to let the
   * driver resolve the DSN host itself (no pinning) — e.g. a unix-socket DSN. See pin.ts.
   */
  pinnedHost?: string;
}
