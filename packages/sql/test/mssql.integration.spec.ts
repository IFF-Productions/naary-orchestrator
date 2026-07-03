import { ConnectionPool } from "mssql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mssqlAdapter } from "../src/mssql";

/**
 * Live integration test for the MSSQL adapter against a REAL SQL Server. SKIPPED
 * unless `MSSQL_TEST_DSN` is set, so the normal `vitest run` / CI need no database.
 *
 * To run it locally (azure-sql-edge is the ARM/Apple-Silicon SQL Server image; on
 * x86, mcr.microsoft.com/mssql/server works identically):
 *
 *   docker run -d --name naary-mssql-test -e ACCEPT_EULA=Y \
 *     -e MSSQL_SA_PASSWORD=Naary_Test_Pass123 -p 1433:1433 \
 *     mcr.microsoft.com/azure-sql-edge:latest
 *
 *   MSSQL_TEST_DSN='Server=localhost,1433;Database=master;User Id=sa;Password=Naary_Test_Pass123;Encrypt=false' \
 *     pnpm --filter @naary/sql exec vitest run mssql.integration
 *
 * Verifies the two things unit tests (mocked driver) can't: that a standalone
 * connection survives the adapter's appended `ApplicationIntent=ReadOnly`, and that
 * the always-rollback read-only guarantee actually prevents a write from persisting.
 */
const DSN = process.env.MSSQL_TEST_DSN;

describe.skipIf(!DSN)("mssqlAdapter — live SQL Server", () => {
  let pool: ConnectionPool;

  beforeAll(async () => {
    pool = await new ConnectionPool(DSN as string).connect();
    await pool.request().query(`
      IF OBJECT_ID('dbo.naary_test') IS NOT NULL DROP TABLE dbo.naary_test;
      CREATE TABLE dbo.naary_test (id INT PRIMARY KEY, name NVARCHAR(50));
      INSERT INTO dbo.naary_test (id, name) VALUES (1, 'alice'), (2, 'bob');
    `);
  }, 60_000);

  afterAll(async () => {
    if (!pool) return;
    await pool
      .request()
      .query(
        "IF OBJECT_ID('dbo.naary_test') IS NOT NULL DROP TABLE dbo.naary_test",
      );
    await pool.close();
  });

  it("runs a parameterized SELECT (@p1) and returns the matching row", async () => {
    const r = await mssqlAdapter.runReadOnly(
      DSN as string,
      "SELECT id, name FROM dbo.naary_test WHERE id = @p1",
      [2],
      { timeoutMs: 10_000 },
    );
    expect(r.rowCount).toBe(1);
    expect((r.rows[0] as { name: string }).name).toBe("bob");
  });

  it("does NOT persist a write (always-rollback read-only guarantee)", async () => {
    // Runs without throwing, but the row must not survive the adapter's ROLLBACK.
    await mssqlAdapter.runReadOnly(
      DSN as string,
      "INSERT INTO dbo.naary_test (id, name) VALUES (3, 'carol')",
      [],
      { timeoutMs: 10_000 },
    );
    const after = await pool
      .request()
      .query("SELECT COUNT(*) AS n FROM dbo.naary_test");
    expect((after.recordset[0] as { n: number }).n).toBe(2);
  });
});
