import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BlockedEgressError,
  MissingConnectionTokenError,
  resolvePinnedHost,
} from "@naary/connections";
import {
  __setObjectStore,
  MemoryObjectStore,
  isClaimCheck,
  resolveClaimChecks,
} from "@naary/storage";
import {
  __sqlDeps,
  type SqlExecConfig,
  type SqlQueryConfig,
  callSqlExec,
  callSqlQuery,
  dsnHost,
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
  // Allow the egress host check by default (db.internal doesn't resolve in tests) and hand
  // back a pin, as the real resolver does; the S-3 tests below use the REAL guard with a
  // literal internal IP.
  __sqlDeps.resolvePinnedHost = vi
    .fn()
    .mockResolvedValue("93.184.216.34") as never;
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
    // DSN + sql + params reach the adapter; default 30s timeout applied, and the
    // validated address is handed down as the connect PIN (#597) — the adapter aims the
    // driver's socket at it instead of letting the driver re-resolve db.internal.
    expect(runReadOnly).toHaveBeenCalledWith(
      "postgres://user:secret@db.internal:5432/app",
      "SELECT * FROM users WHERE id = $1",
      [7],
      { timeoutMs: 30_000, pinnedHost: "93.184.216.34" },
    );
  });

  it("clamps an over-large statement timeout to the hard cap", async () => {
    runReadOnly.mockResolvedValue({ rows: [], rowCount: 0 });
    await callSqlQuery({ ...CFG, statementTimeoutMs: 999_999 }, {}, META);
    expect(runReadOnly.mock.calls[0][3]).toEqual({
      timeoutMs: 120_000,
      pinnedHost: "93.184.216.34",
    });
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

  it("S-3: a DSN pointing at an internal IP → EGRESS_BLOCKED, never connects", async () => {
    // Use the REAL egress guard; 10.0.0.5 is an IP literal → blocked without DNS.
    __sqlDeps.resolvePinnedHost = resolvePinnedHost as never;
    resolveDbConnection.mockResolvedValue({
      engine: "postgres",
      dsn: "postgres://u:p@10.0.0.5:5432/app",
    });
    const err = await callSqlQuery(CFG, {}, META).catch((e) => e);
    expect(err.nonRetryable).toBe(true);
    expect(err.type).toBe("EGRESS_BLOCKED");
    expect(runReadOnly).not.toHaveBeenCalled();
    // the DSN (with password) never leaks into the error
    expect(JSON.stringify(err)).not.toContain("10.0.0.5");
  });
});

describe("dsnHost", () => {
  it("parses a postgres URL DSN", () => {
    expect(dsnHost("postgres://u:p@db.example.com:5432/app")).toBe(
      "db.example.com",
    );
  });
  it("parses an mssql key=value connection string", () => {
    expect(
      dsnHost("Server=tcp:sql.example.com,1433;Database=app;User Id=x;"),
    ).toBe("sql.example.com");
    expect(dsnHost("Data Source=10.0.0.9\\SQLEXPRESS;Database=app")).toBe(
      "10.0.0.9",
    );
  });
  it("returns null for an unparseable DSN", () => {
    expect(dsnHost("not a dsn")).toBeNull();
  });
});

describe("callSqlExec activity (write)", () => {
  const EXEC: SqlExecConfig = {
    connectionId: "db-1",
    sql: "UPDATE users SET seen = true WHERE id = $1",
    params: [7],
  };
  const runWrite = vi.fn();

  beforeEach(() => {
    runWrite.mockReset();
    __sqlDeps.getAdapter = (() => ({ engine: "postgres", runWrite })) as never;
  });

  it("runs the write and returns rowsAffected", async () => {
    runWrite.mockResolvedValue({ rowsAffected: 3 });

    const result = await callSqlExec(EXEC, {}, META);

    expect(result).toEqual({ status: "ok", rowsAffected: 3, costUsd: 0 });
    expect(runWrite).toHaveBeenCalledWith(
      "postgres://user:secret@db.internal:5432/app",
      "UPDATE users SET seen = true WHERE id = $1",
      [7],
      { timeoutMs: 30_000, pinnedHost: "93.184.216.34" },
    );
  });

  it("maps a DB error to a NON-retryable failure (writes are at-most-once, never looped)", async () => {
    runWrite.mockRejectedValue(Object.assign(new Error("boom"), { code: "23505" }));

    await expect(callSqlExec(EXEC, {}, META)).rejects.toMatchObject({
      nonRetryable: true,
      type: "SQL_EXEC_ERROR",
    });
  });

  it("rejects an internal DSN host before connecting (SSRF S-3) and never writes", async () => {
    resolveDbConnection.mockResolvedValue({
      engine: "postgres",
      dsn: "postgres://u:p@10.0.0.5:5432/app",
    });
    __sqlDeps.resolvePinnedHost = resolvePinnedHost as never; // real guard

    await expect(callSqlExec(EXEC, {}, META)).rejects.toMatchObject({
      type: "EGRESS_BLOCKED",
      nonRetryable: true,
    });
    expect(runWrite).not.toHaveBeenCalled();
  });
});
