import { Client } from "pg";
import { pinnedPgStream } from "./pin";
import type { SqlEngineAdapter } from "./types";

/** The slice of `pg.Client` we use — narrowed so tests can supply a fake. */
export interface PgClientLike {
  connect(): Promise<unknown>;
  query(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: unknown[]; rowCount: number | null }>;
  end(): Promise<void>;
}

/** Test seam: the client constructor, swappable so adapter tests need no live DB. */
export const __pgDeps = {
  createClient: (
    dsn: string,
    statementTimeoutMs: number,
    pinnedHost?: string,
  ): PgClientLike =>
    new Client({
      connectionString: dsn,
      statement_timeout: statementTimeoutMs,
      // Connect-pin: aim pg's socket at the pre-validated address (#597). The connection
      // string keeps its hostname, so pg still sets that as the TLS servername. NOTE the
      // config order matters — an explicit `host` would be overwritten by the parsed
      // connectionString (ConnectionParameters re-parses it last), which is why this pins
      // the socket instead.
      ...(pinnedHost ? { stream: pinnedPgStream(pinnedHost) } : {}),
    }),
};

/**
 * Postgres read-only adapter. Wraps the query in `BEGIN TRANSACTION READ ONLY`
 * so the engine REJECTS any write outright (strong guarantee), then `ROLLBACK`s.
 * Placeholders are `$1..$n`. The client is always closed in `finally` so a
 * connection isn't leaked per node-run.
 */
export const postgresAdapter: SqlEngineAdapter = {
  engine: "postgres",
  async runReadOnly(dsn, sql, params, opts) {
    const client = __pgDeps.createClient(dsn, opts.timeoutMs, opts.pinnedHost);
    await client.connect();
    try {
      await client.query("BEGIN TRANSACTION READ ONLY");
      const res = await client.query(sql, params);
      await client.query("ROLLBACK");
      return { rows: res.rows, rowCount: res.rowCount ?? res.rows.length };
    } finally {
      await client.end();
    }
  },
  async runWrite(dsn, sql, params, opts) {
    const client = __pgDeps.createClient(dsn, opts.timeoutMs, opts.pinnedHost);
    await client.connect();
    try {
      await client.query("BEGIN");
      const res = await client.query(sql, params);
      await client.query("COMMIT");
      return { rowsAffected: res.rowCount ?? 0 };
    } catch (e) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw e;
    } finally {
      await client.end();
    }
  },
};
