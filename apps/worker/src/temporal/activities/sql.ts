// sqlQuery / sqlExec nodes — tenant-DB reads and at-most-once writes.
import { createLogger } from "@naary/logging";
import { ApplicationFailure } from "@temporalio/activity";
import {
  BlockedEgressError,
  MissingConnectionTokenError,
  NeedsReauthError,
  resolveDbConnection,
  resolvePinnedHost,
} from "@naary/connections";
import { dsnHost, getAdapter } from "@naary/sql";
import {
  getObjectStore,
  maybeOffload,
  resolveClaimChecks,
} from "@naary/storage";
import {
  activityDuration,
  activityRuns,
  runCostUsd,
  secondsSince,
} from "../../metrics";
import { type AgentMeta } from "./shared";

// Activities run in the worker PROCESS (a side-effect zone), so structured
// logging is fine here — unlike workflows.ts, which must stay deterministic.
// Logs carry execution-correlated ids (executionId/nodeId/tenantId) and token/
// cost numbers only — never prompts, completions, or keys (the logger scrubs).
const log = createLogger({ component: "worker" });

const DEFAULT_SQL_TIMEOUT_MS = 30_000;
/** Hard cap on per-query timeout. MUST stay below the callSqlQuery proxy's
 *  startToCloseTimeout so the DB driver — not Temporal — is the deadline. */
const MAX_SQL_TIMEOUT_MS = 120_000;

/** A resolved SQL query (bindings already applied by the interpreter). NO secrets:
 *  the DSN is read from the connection inside the activity. */
export interface SqlQueryConfig {
  connectionId: string;
  sql: string;
  params: unknown[];
  statementTimeoutMs?: number;
  costUsd?: number;
}

export interface SqlQueryResult {
  status: "ok";
  /** Result rows (a claim-check reference if large). The graph branches on rowCount. */
  rows: unknown;
  rowCount: number;
  costUsd: number;
}

/** Test seam: DB resolution + adapter lookup, swappable so tests need no live DB. */
export const __sqlDeps = {
  resolveDbConnection,
  getAdapter,
  resolvePinnedHost,
};

/** Best-effort host extraction from a DSN. MOVED to `@naary/sql` (#1004) so the API's
 *  authoring-time schema introspection SSRF-checks the host with exactly the same parse —
 *  re-exported here because this module is the activity surface the tests import. */
export { dsnHost };

/** mssql/tedious code for a bad login (wrong user/password in the DSN). */
const MSSQL_AUTH_CODE = "ELOGIN";
/** mssql/tedious codes that are deterministic query/timeout failures (NOT transient):
 *  EREQUEST = query error; ETIMEOUT = request timeout (the analogue of Postgres'
 *  57014 statement_timeout — re-running an expensive timed-out query just times out
 *  again, so don't retry). */
const MSSQL_QUERY_CODES = new Set(["EREQUEST", "ETIMEOUT"]);

/** The driver `code` if this is a deterministic DB error — a bad query, read-only
 *  violation, or query/timeout. pg uses a 5-char SQLSTATE; mssql uses EREQUEST/
 *  ETIMEOUT. The code is safe to surface — never the driver message, which can
 *  carry the DSN/host. (Auth + connection/transient codes are handled separately.) */
function sqlErrorCode(e: unknown): string | null {
  const code = (e as { code?: unknown }).code;
  if (typeof code !== "string") return null;
  if (/^[0-9A-Z]{5}$/.test(code)) return code; // pg SQLSTATE
  if (MSSQL_QUERY_CODES.has(code)) return code;
  return null;
}

/**
 * SQL Query node: run ONE read-only query against a tenant database and return its
 * rows so the graph can branch on `.rowCount`. The connection's DSN is resolved +
 * used IN-ACTIVITY (never crosses the workflow boundary). Read-only is enforced per
 * engine by the adapter (Postgres `READ ONLY` txn; MSSQL always-rollback).
 *
 * A query error (bad SQL / read-only violation) is non-retryable — the same query
 * fails the same way. Connection/transient errors retry, but are surfaced GENERICALLY
 * (never the driver message) so the DSN/host can't reach history or logs.
 */
export async function callSqlQuery(
  cfg: SqlQueryConfig,
  input: unknown,
  meta: AgentMeta,
): Promise<SqlQueryResult> {
  void input; // entry-node input flows via bindings, not directly into the query
  const startedAt = process.hrtime.bigint();
  try {
    const store = getObjectStore();
    const { engine, dsn } = await __sqlDeps.resolveDbConnection(
      meta.tenantId,
      cfg.connectionId,
    );
    // SSRF (audit S-3): the DSN host is tenant-supplied — reject an internal/reserved
    // target before connecting (mirrors callSendEmail). Wire protocol, not HTTP, so this
    // bounds internal reach/port-scanning.
    //
    // Resolve ONCE and PIN the validated address (#597): the driver would otherwise
    // re-resolve the hostname itself, so a host that answers public here could answer
    // private at connect time (rebinding TOCTOU). The DSN's hostname is left alone, so TLS
    // still validates the certificate against it — see @naary/sql's pin.ts.
    const dbHost = dsnHost(dsn);
    const pinnedHost = dbHost
      ? await __sqlDeps.resolvePinnedHost(dbHost)
      : undefined;
    // Resolve any claim-checked bound param back to its real value before the call.
    const params = (await resolveClaimChecks(
      cfg.params ?? [],
      store,
    )) as unknown[];
    const timeoutMs = Math.min(
      cfg.statementTimeoutMs ?? DEFAULT_SQL_TIMEOUT_MS,
      MAX_SQL_TIMEOUT_MS,
    );
    const result = await __sqlDeps
      .getAdapter(engine)
      .runReadOnly(dsn, cfg.sql, params, { timeoutMs, pinnedHost });

    // Offload a large result set so it can't blow Temporal's ~2MB payload cap.
    const rows = await maybeOffload(result.rows, store, {
      keyPrefix: `sql/${meta.tenantId}`,
    });
    log.info(
      {
        activity: "callSqlQuery",
        executionId: meta.executionId,
        nodeId: meta.nodeId,
        tenantId: meta.tenantId,
        engine,
        connectionId: cfg.connectionId,
        rowCount: result.rowCount,
        costUsd: cfg.costUsd ?? 0,
      },
      "sql query completed",
    );
    activityRuns.inc({ activity: "callSqlQuery", outcome: "ok" });
    activityDuration.observe(
      { activity: "callSqlQuery" },
      secondsSince(startedAt),
    );
    if ((cfg.costUsd ?? 0) > 0) runCostUsd.inc(cfg.costUsd ?? 0);
    return {
      status: "ok",
      rows,
      rowCount: result.rowCount,
      costUsd: cfg.costUsd ?? 0,
    };
  } catch (e) {
    activityRuns.inc({ activity: "callSqlQuery", outcome: "error" });
    activityDuration.observe(
      { activity: "callSqlQuery" },
      secondsSince(startedAt),
    );
    if (e instanceof ApplicationFailure) throw e;
    // A DSN pointing at an internal/reserved host — the user must fix the connection.
    if (e instanceof BlockedEgressError) {
      throw ApplicationFailure.nonRetryable(e.message, "EGRESS_BLOCKED", {
        connectionId: cfg.connectionId,
      });
    }
    // A missing stored DSN, or an mssql bad-login (wrong user/password in the DSN):
    // the user must fix the connection — non-retryable, don't loop (CLAUDE.md).
    if (
      e instanceof MissingConnectionTokenError ||
      e instanceof NeedsReauthError ||
      (e as { code?: unknown }).code === MSSQL_AUTH_CODE
    ) {
      throw ApplicationFailure.nonRetryable(
        "Connection needs re-authorization",
        "CONNECTION_REAUTH",
        { connectionId: cfg.connectionId },
      );
    }
    // A DB-reported query error is deterministic — don't burn retries. Surface the
    // SQLSTATE/code ONLY (never the driver message — it can carry the DSN/host).
    const code = sqlErrorCode(e);
    if (code) {
      throw ApplicationFailure.nonRetryable(
        `SQL query failed (code ${code})`,
        "SQL_QUERY_ERROR",
        { connectionId: cfg.connectionId, code },
      );
    }
    // Connection/transient (refused, reset, timeout). Generic + retryable — drop the
    // original error entirely so the DSN/host never reaches history or logs.
    throw ApplicationFailure.retryable(
      "Database query failed transiently",
      "SQL_TRANSIENT",
      { connectionId: cfg.connectionId },
    );
  }
}

export interface SqlExecConfig {
  connectionId: string;
  sql: string;
  params: unknown[];
  statementTimeoutMs?: number;
  costUsd?: number;
}

export interface SqlExecResult {
  status: "ok";
  rowsAffected: number;
  costUsd: number;
}

/**
 * SQL Exec node: run ONE write (INSERT/UPDATE/DELETE) against a tenant database inside
 * a transaction (COMMIT on success, ROLLBACK on error) and return the affected row
 * count. Same DSN-in-activity + SSRF guard + binding rules as callSqlQuery.
 *
 * Writes are NOT idempotent, so this activity is registered AT-MOST-ONCE (retry: 1):
 * a partial/ambiguous failure fails the node rather than risk a double-write. Every
 * error is therefore NON-retryable here (surfaced generically so the DSN never leaks).
 */
export async function callSqlExec(
  cfg: SqlExecConfig,
  input: unknown,
  meta: AgentMeta,
): Promise<SqlExecResult> {
  void input;
  const startedAt = process.hrtime.bigint();
  try {
    const store = getObjectStore();
    const { engine, dsn } = await __sqlDeps.resolveDbConnection(
      meta.tenantId,
      cfg.connectionId,
    );
    const dbHost = dsnHost(dsn);
    const pinnedHost = dbHost
      ? await __sqlDeps.resolvePinnedHost(dbHost)
      : undefined;
    const params = (await resolveClaimChecks(
      cfg.params ?? [],
      store,
    )) as unknown[];
    const timeoutMs = Math.min(
      cfg.statementTimeoutMs ?? DEFAULT_SQL_TIMEOUT_MS,
      MAX_SQL_TIMEOUT_MS,
    );
    const result = await __sqlDeps
      .getAdapter(engine)
      .runWrite(dsn, cfg.sql, params, { timeoutMs, pinnedHost });

    log.info(
      {
        activity: "callSqlExec",
        executionId: meta.executionId,
        nodeId: meta.nodeId,
        tenantId: meta.tenantId,
        engine,
        connectionId: cfg.connectionId,
        rowsAffected: result.rowsAffected,
        costUsd: cfg.costUsd ?? 0,
      },
      "sql exec completed",
    );
    activityRuns.inc({ activity: "callSqlExec", outcome: "ok" });
    activityDuration.observe(
      { activity: "callSqlExec" },
      secondsSince(startedAt),
    );
    if ((cfg.costUsd ?? 0) > 0) runCostUsd.inc(cfg.costUsd ?? 0);
    return {
      status: "ok",
      rowsAffected: result.rowsAffected,
      costUsd: cfg.costUsd ?? 0,
    };
  } catch (e) {
    activityRuns.inc({ activity: "callSqlExec", outcome: "error" });
    activityDuration.observe(
      { activity: "callSqlExec" },
      secondsSince(startedAt),
    );
    if (e instanceof ApplicationFailure) throw e;
    if (e instanceof BlockedEgressError) {
      throw ApplicationFailure.nonRetryable(e.message, "EGRESS_BLOCKED", {
        connectionId: cfg.connectionId,
      });
    }
    if (
      e instanceof MissingConnectionTokenError ||
      e instanceof NeedsReauthError ||
      (e as { code?: unknown }).code === MSSQL_AUTH_CODE
    ) {
      throw ApplicationFailure.nonRetryable(
        "Connection needs re-authorization",
        "CONNECTION_REAUTH",
        { connectionId: cfg.connectionId },
      );
    }
    // At-most-once: surface the code if we have one, else a generic failure. NEVER
    // retryable — a retry could double-write. The driver message (DSN/host) is dropped.
    const code = sqlErrorCode(e);
    throw ApplicationFailure.nonRetryable(
      code ? `SQL write failed (code ${code})` : "SQL write failed",
      "SQL_EXEC_ERROR",
      { connectionId: cfg.connectionId, ...(code ? { code } : {}) },
    );
  }
}
