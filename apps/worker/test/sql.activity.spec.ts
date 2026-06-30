import { beforeEach, describe, expect, it, vi } from "vitest";
import { MissingConnectionTokenError } from "@naary/connections";
import {
  __setObjectStore,
  MemoryObjectStore,
  isClaimCheck,
  resolveClaimChecks,
} from "@naary/storage";
import {
  __sqlDeps,
  type SqlQueryConfig,
  callSqlQuery,
} from "../src/temporal/activities";

const META = { tenantId: "t1", executionId: "exec-1", nodeId: "sql" };
const CFG: SqlQueryConfig = {
  connectionId: "db-1",
  sql: "SELECT * FROM users WHERE id = $1",
  params: [7],
};

const resolveDbConnection = vi.fn();
const runReadOnly = vi.fn();
let store: MemoryObjectStore;

beforeEach(() => {
  resolveDbConnection.mockReset();
  runReadOnly.mockReset();
  resolveDbConnection.mockResolvedValue({
    engine: "postgres",
    dsn: "postgres://user:secret@db.internal:5432/app",
  });
  __sqlDeps.resolveDbConnection = resolveDbConnection as never;
  __sqlDeps.getAdapter = (() => ({ engine: "postgres", runReadOnly })) as never;
  store = new MemoryObjectStore();
  __setObjectStore(store);
});

describe("callSqlQuery activity", () => {
  it("resolves the connection, runs the query read-only, and returns rows", async () => {
    runReadOnly.mockResolvedValue({ rows: [{ id: 7 }], rowCount: 1 });

    const result = await callSqlQuery(CFG, {}, META);

    expect(result).toMatchObject({
      status: "ok",
      rows: [{ id: 7 }],
      rowCount: 1,
      costUsd: 0,
    });
    expect(resolveDbConnection).toHaveBeenCalledWith("t1", "db-1");
    // DSN + sql + params reach the adapter; default 30s timeout applied.
    expect(runReadOnly).toHaveBeenCalledWith(
      "postgres://user:secret@db.internal:5432/app",
      "SELECT * FROM users WHERE id = $1",
      [7],
      { timeoutMs: 30_000 },
    );
  });

  it("clamps an over-large statement timeout to the hard cap", async () => {
    runReadOnly.mockResolvedValue({ rows: [], rowCount: 0 });
    await callSqlQuery({ ...CFG, statementTimeoutMs: 999_999 }, {}, META);
    expect(runReadOnly.mock.calls[0][3]).toEqual({ timeoutMs: 120_000 });
  });

  it("claim-checks a large result set to object storage (Arch§4.6)", async () => {
    const big = [{ blob: "z".repeat(1_100_000) }];
    runReadOnly.mockResolvedValue({ rows: big, rowCount: 1 });

    const result = await callSqlQuery(CFG, {}, META);

    expect(isClaimCheck(result.rows)).toBe(true);
    expect(result.rowCount).toBe(1); // rowCount stays inline
    expect(await resolveClaimChecks(result.rows, store)).toEqual(big);
  });

  it("maps a missing DSN / needs-reauth connection to a non-retryable failure", async () => {
    resolveDbConnection.mockRejectedValue(
      new MissingConnectionTokenError("db-1"),
    );
    await expect(callSqlQuery(CFG, {}, META)).rejects.toMatchObject({
      nonRetryable: true,
      type: "CONNECTION_REAUTH",
    });
    expect(runReadOnly).not.toHaveBeenCalled();
  });

  it("maps a DB query error (SQLSTATE) to a non-retryable failure, surfacing only the code", async () => {
    runReadOnly.mockRejectedValue(
      Object.assign(new Error("syntax error at or near"), { code: "42601" }),
    );
    await expect(callSqlQuery(CFG, {}, META)).rejects.toMatchObject({
      nonRetryable: true,
      type: "SQL_QUERY_ERROR",
    });
  });

  it("maps a connection error to a sanitized RETRYABLE failure (no DSN/host leak)", async () => {
    runReadOnly.mockRejectedValue(
      Object.assign(new Error("connect ECONNREFUSED db.internal:5432"), {
        code: "ECONNREFUSED",
      }),
    );
    const err = await callSqlQuery(CFG, {}, META).catch((e) => e);
    expect(err).toMatchObject({ nonRetryable: false, type: "SQL_TRANSIENT" });
    // the original driver message (with the host) must NOT be propagated
    expect(JSON.stringify(err)).not.toContain("db.internal");
  });

  // MSSQL/tedious codes aren't 5-char SQLSTATEs — classify them explicitly so a
  // timed-out or bad-credential mssql query isn't retried 3× like a transient.
  it("maps an mssql query error (EREQUEST) to non-retryable SQL_QUERY_ERROR", async () => {
    runReadOnly.mockRejectedValue(
      Object.assign(new Error("Invalid column name"), { code: "EREQUEST" }),
    );
    await expect(callSqlQuery(CFG, {}, META)).rejects.toMatchObject({
      nonRetryable: true,
      type: "SQL_QUERY_ERROR",
    });
  });

  it("maps an mssql request timeout (ETIMEOUT) to non-retryable (don't re-run an expensive query)", async () => {
    runReadOnly.mockRejectedValue(
      Object.assign(new Error("Timeout: Request failed"), { code: "ETIMEOUT" }),
    );
    await expect(callSqlQuery(CFG, {}, META)).rejects.toMatchObject({
      nonRetryable: true,
      type: "SQL_QUERY_ERROR",
    });
  });

  it("maps an mssql bad login (ELOGIN) to non-retryable CONNECTION_REAUTH", async () => {
    runReadOnly.mockRejectedValue(
      Object.assign(new Error("Login failed for user 'sa'"), {
        code: "ELOGIN",
      }),
    );
    await expect(callSqlQuery(CFG, {}, META)).rejects.toMatchObject({
      nonRetryable: true,
      type: "CONNECTION_REAUTH",
    });
  });
});
