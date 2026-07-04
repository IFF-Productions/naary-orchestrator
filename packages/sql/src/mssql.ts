import { ConnectionPool, Request, Transaction } from "mssql";
import type { SqlEngineAdapter } from "./types";

/**
 * Augment an MSSQL ADO connection string (`Key=Value;…`) for a read-only query:
 *  - `ApplicationIntent=ReadOnly` routes to a readable secondary in an Availability
 *    Group (best effort; ignored on a standalone server).
 *  - `Request Timeout=<ms>` bounds the query (mssql parses this key — base/
 *    connection-pool.js), the SQL-Server analogue of Postgres `statement_timeout`.
 * Each is only added when absent, so a DSN that already sets them wins.
 */
export function augmentMssqlDsn(dsn: string, timeoutMs: number): string {
  let out = dsn.trim();
  const sep = () => (out.endsWith(";") ? "" : ";");
  if (!/applicationintent=/i.test(out)) {
    out = `${out}${sep()}ApplicationIntent=ReadOnly`;
  }
  if (!/request timeout=/i.test(out)) {
    out = `${out}${sep()}Request Timeout=${timeoutMs}`;
  }
  return out;
}

/** Test seam: the pool constructor, swappable so adapter tests need no live DB. */
export const __mssqlDeps = {
  createPool: (dsn: string, timeoutMs: number): ConnectionPool =>
    new ConnectionPool(augmentMssqlDsn(dsn, timeoutMs)),
};

/**
 * MSSQL read-only adapter. SQL Server has NO transaction-level READ ONLY mode, so
 * the guarantee is "nothing persists": run inside a transaction and ALWAYS
 * `ROLLBACK`, so even a write that executes never commits. Binds positional params
 * as `@p1..@pn` (the user writes `@p1` in their SQL). The pool is always closed in
 * `finally`. (For HARD rejection of writes, use a read-only DB login, operator-side.)
 */
export const mssqlAdapter: SqlEngineAdapter = {
  engine: "mssql",
  async runReadOnly(dsn, sql, params, opts) {
    const pool = __mssqlDeps.createPool(dsn, opts.timeoutMs);
    await pool.connect();
    try {
      const tx = new Transaction(pool);
      await tx.begin();
      const request = new Request(tx);
      params.forEach((p, i) => request.input(`p${i + 1}`, p));
      const result = await request.query(sql);
      await tx.rollback();
      const rows = (result.recordset ?? []) as unknown[];
      return { rows, rowCount: rows.length };
    } finally {
      await pool.close();
    }
  },
  async runWrite(dsn, sql, params, opts) {
    const pool = __mssqlDeps.createPool(dsn, opts.timeoutMs);
    await pool.connect();
    try {
      const tx = new Transaction(pool);
      await tx.begin();
      const request = new Request(tx);
      params.forEach((p, i) => request.input(`p${i + 1}`, p));
      try {
        const result = await request.query(sql);
        await tx.commit();
        return { rowsAffected: result.rowsAffected?.[0] ?? 0 };
      } catch (e) {
        await tx.rollback().catch(() => undefined);
        throw e;
      }
    } finally {
      await pool.close();
    }
  },
};
