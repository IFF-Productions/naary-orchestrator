import mysql from "mysql2/promise";
import { connectPinned } from "./pin";
import type { SqlEngineAdapter } from "./types";

/** The slice of a mysql2 connection we use — narrowed so tests can supply a fake. */
export interface MysqlConnLike {
  query(sql: string, params?: unknown[]): Promise<[unknown, unknown]>;
  end(): Promise<void>;
}

/** Test seam: the connection factory, swappable so adapter tests need no live DB. */
export const __mysqlDeps = {
  createConnection: async (
    dsn: string,
    timeoutMs: number,
    pinnedHost?: string,
  ): Promise<MysqlConnLike> =>
    (await mysql.createConnection({
      uri: dsn,
      connectTimeout: timeoutMs,
      // Connect-pin: mysql2 would call `Net.connect(config.port, config.host)` itself (a
      // second, unguarded DNS lookup — #597), so supply the socket via its `stream` factory
      // instead. `config.host` stays the DSN hostname, which is what mysql2 uses for the TLS
      // servername. Port comes from the parsed URI (ConnectionConfig defaults it to 3306
      // before the factory runs; kept defensive anyway).
      ...(pinnedHost
        ? {
            stream: (opts: { config: { port?: number } }) =>
              connectPinned(opts.config.port || 3306, pinnedHost),
          }
        : {}),
    })) as unknown as MysqlConnLike,
};

/**
 * MySQL adapter. Reads run in a `START TRANSACTION READ ONLY` (MySQL 5.6+) that is
 * always ROLLBACK'd, so the engine rejects writes AND nothing persists. Writes run in
 * a transaction that COMMITs on success and ROLLBACKs on error. Placeholders are `?`
 * (positional). The connection is always closed in `finally`.
 */
export const mysqlAdapter: SqlEngineAdapter = {
  engine: "mysql",
  async runReadOnly(dsn, sql, params, opts) {
    const conn = await __mysqlDeps.createConnection(
      dsn,
      opts.timeoutMs,
      opts.pinnedHost,
    );
    try {
      // Bound SELECT runtime too (ms; MySQL 5.7+, best-effort — ignored if unsupported).
      await conn
        .query(`SET SESSION max_execution_time = ${Math.floor(opts.timeoutMs)}`)
        .catch(() => undefined);
      await conn.query("START TRANSACTION READ ONLY");
      const [rows] = await conn.query(sql, params);
      await conn.query("ROLLBACK");
      const arr = (Array.isArray(rows) ? rows : []) as unknown[];
      return { rows: arr, rowCount: arr.length };
    } finally {
      await conn.end();
    }
  },
  async runWrite(dsn, sql, params, opts) {
    const conn = await __mysqlDeps.createConnection(
      dsn,
      opts.timeoutMs,
      opts.pinnedHost,
    );
    try {
      await conn.query("START TRANSACTION");
      const [result] = await conn.query(sql, params);
      await conn.query("COMMIT");
      const affected = (result as { affectedRows?: number })?.affectedRows ?? 0;
      return { rowsAffected: affected };
    } catch (e) {
      await conn.query("ROLLBACK").catch(() => undefined);
      throw e;
    } finally {
      await conn.end();
    }
  },
};
