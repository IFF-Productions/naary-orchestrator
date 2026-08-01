/**
 * Authoring-time SQL schema introspection service (#1004).
 *
 * The behaviours worth pinning are the failure and degradation paths, because those are what
 * decide whether a user can keep authoring: a credential with partial rights, a database too big
 * to list, an unreachable host. Plus the one that is invisible until it bites — a driver error
 * message carries the DSN's host, and echoing it would put a credential in a browser console.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { BlockedEgressError } from "@naary/connections";
import {
  SqlSchemaService,
  __sqlIntrospectDeps,
} from "../src/introspect/sql-schema.service";

const DSN = "postgres://app:sup3rs3cret@db.internal.example.com:5432/prod";
const HOST = "db.internal.example.com";

interface Recorder {
  sql: string[];
  dsns: string[];
  calls: number;
}

/** Point the service at a fake database. Returns the service + what the adapter was asked. */
function withFakeDb(opts: {
  rows?: unknown[];
  engine?: "postgres" | "mysql" | "mssql";
  throwOnRun?: unknown;
  throwOnResolve?: unknown;
  now?: () => number;
}): { service: SqlSchemaService; rec: Recorder } {
  const rec: Recorder = { sql: [], dsns: [], calls: 0 };
  __sqlIntrospectDeps.resolveDbConnection = async () => {
    if (opts.throwOnResolve) throw opts.throwOnResolve;
    return { engine: opts.engine ?? "postgres", dsn: DSN };
  };
  __sqlIntrospectDeps.resolvePinnedHost = async () => "93.184.216.34";
  __sqlIntrospectDeps.getAdapter = (() => ({
    engine: opts.engine ?? "postgres",
    runReadOnly: async (dsn: string, sql: string) => {
      rec.calls += 1;
      rec.sql.push(sql);
      rec.dsns.push(dsn);
      if (opts.throwOnRun) throw opts.throwOnRun;
      const rows = opts.rows ?? [];
      return { rows, rowCount: rows.length };
    },
    runWrite: async () => ({ rowsAffected: 0 }),
  })) as never;
  if (opts.now) __sqlIntrospectDeps.now = opts.now;
  return { service: new SqlSchemaService(), rec };
}

const col = (table: string, name: string) => ({
  table_schema: "public",
  table_name: table,
  column_name: name,
  data_type: "text",
  is_nullable: "YES",
});

const REAL = { ...__sqlIntrospectDeps };
beforeEach(() => Object.assign(__sqlIntrospectDeps, REAL));

describe("SqlSchemaService", () => {
  it("returns the tables a connection can see", async () => {
    const { service, rec } = withFakeDb({
      rows: [col("users", "id"), col("users", "email")],
    });
    const out = await service.introspect("t1", "c1");
    expect(out.tables).toEqual([
      {
        schema: "public",
        name: "users",
        columns: [
          { name: "id", type: "text", nullable: true },
          { name: "email", type: "text", nullable: true },
        ],
      },
    ]);
    // It went through runReadOnly with the ENGINE'S query.
    expect(rec.sql[0]).toContain("information_schema.columns");
  });

  it("uses the per-engine query, not one query for all three", async () => {
    const pg = withFakeDb({ engine: "postgres" });
    await pg.service.introspect("t1", "c1");
    const my = withFakeDb({ engine: "mysql" });
    await my.service.introspect("t1", "c1");
    const ms = withFakeDb({ engine: "mssql" });
    await ms.service.introspect("t1", "c1");
    expect(pg.rec.sql[0]).toContain("information_schema.columns");
    expect(my.rec.sql[0]).toContain("DATABASE()");
    expect(ms.rec.sql[0]).toContain("sys.columns");
  });

  describe("degradation — introspection must never block authoring", () => {
    it("a credential that can see nothing yields an empty list with an explanation", async () => {
      const { service } = withFakeDb({ rows: [] });
      const out = await service.introspect("t1", "c1");
      expect(out.tables).toEqual([]);
      expect(out.note).toMatch(/No tables were visible/i);
    });

    it("a partially-visible catalog returns exactly what was visible", async () => {
      // Every engine's catalog is privilege-filtered, so a restricted login simply sees fewer rows.
      const { service } = withFakeDb({ rows: [col("users", "id")] });
      const out = await service.introspect("t1", "c1");
      expect(out.tables.map((t) => t.name)).toEqual(["users"]);
      expect(out.truncated).toBe(false);
    });

    it("an oversized schema is bounded and SAYS what was dropped", async () => {
      // 20_001 rows = the cap + the sentinel row the query fetches to detect truncation.
      const rows = Array.from({ length: 20_001 }, (_, i) =>
        col(`t${String(i).padStart(6, "0")}`, "id"),
      );
      const { service } = withFakeDb({ rows });
      const out = await service.introspect("t1", "c1");
      expect(out.truncated).toBe(true);
      expect(out.note).toBeTruthy();
      expect(out.tables.length).toBeLessThanOrEqual(1_500);
    });

    it("an unreachable database is a clear 503, never the driver's message", async () => {
      // What pg actually throws — note the host and port in the text.
      const driverError = Object.assign(
        new Error(`connect ECONNREFUSED ${HOST}:5432`),
        { code: "ECONNREFUSED" },
      );
      const { service } = withFakeDb({ throwOnRun: driverError });
      await expect(service.introspect("t1", "c1")).rejects.toMatchObject({
        status: 503,
      });
    });
  });

  describe("the DSN never crosses the boundary (Tier-1 §4)", () => {
    const leaky = [
      Object.assign(new Error(`connect ECONNREFUSED ${HOST}:5432`), {
        code: "ECONNREFUSED",
      }),
      new Error(`password authentication failed for user "app" (${DSN})`),
      new Error(`getaddrinfo ENOTFOUND ${HOST}`),
    ];
    for (const [i, err] of leaky.entries()) {
      it(`case ${i + 1}: no host, user or password reaches the response`, async () => {
        const { service } = withFakeDb({ throwOnRun: err });
        const thrown = await service.introspect("t1", "c1").catch((e) => e);
        const text = JSON.stringify({
          message: (thrown as Error).message,
          response: (thrown as { response?: unknown }).response,
        });
        expect(text).not.toContain(HOST);
        expect(text).not.toContain("sup3rs3cret");
        expect(text).not.toContain("app:");
        expect(text).not.toContain("ECONNREFUSED");
      });
    }

    it("an SSRF-blocked host is a 400 that names the policy, not the address", async () => {
      const { service } = withFakeDb({
        throwOnResolve: new BlockedEgressError(
          "host resolves to a private/reserved address",
        ),
      });
      const thrown = await service.introspect("t1", "c1").catch((e) => e);
      expect((thrown as { status?: number }).status).toBe(400);
      expect((thrown as Error).message).toMatch(/private\/reserved/);
    });
  });

  describe("connection errors", () => {
    it("an unknown connection id is a 404", async () => {
      const { service } = withFakeDb({
        throwOnResolve: new Error("Unknown connection 'nope'"),
      });
      await expect(service.introspect("t1", "nope")).rejects.toMatchObject({
        status: 404,
      });
    });

    it("a non-SQL connection is a 400", async () => {
      const { service } = withFakeDb({
        throwOnResolve: new Error(
          "Connection 'c1' is not a SQL database connection",
        ),
      });
      await expect(service.introspect("t1", "c1")).rejects.toMatchObject({
        status: 400,
      });
    });

    it("a missing connectionId is rejected before anything is resolved", async () => {
      const { service, rec } = withFakeDb({});
      await expect(
        service.introspect("t1", "" as string),
      ).rejects.toMatchObject({ status: 400 });
      expect(rec.calls).toBe(0);
    });
  });

  describe("caching", () => {
    it("serves a second read from cache — the editor must not re-introspect per keystroke", async () => {
      const { service, rec } = withFakeDb({ rows: [col("users", "id")] });
      await service.introspect("t1", "c1");
      await service.introspect("t1", "c1");
      await service.introspect("t1", "c1");
      expect(rec.calls).toBe(1);
    });

    it("scopes the cache by tenant AND connection", async () => {
      const { service, rec } = withFakeDb({ rows: [col("users", "id")] });
      await service.introspect("t1", "c1");
      await service.introspect("t2", "c1"); // another tenant — never a shared hit
      await service.introspect("t1", "c2");
      expect(rec.calls).toBe(3);
    });

    it("refresh:true bypasses the cache (a migration just dropped a column)", async () => {
      const { service, rec } = withFakeDb({ rows: [col("users", "id")] });
      await service.introspect("t1", "c1");
      await service.introspect("t1", "c1", { refresh: true });
      expect(rec.calls).toBe(2);
    });

    it("expires after the TTL", async () => {
      let clock = 1_000_000;
      const { service, rec } = withFakeDb({
        rows: [col("users", "id")],
        now: () => clock,
      });
      await service.introspect("t1", "c1");
      clock += 4 * 60_000;
      await service.introspect("t1", "c1");
      expect(rec.calls).toBe(1);
      clock += 2 * 60_000; // now past the 5-minute TTL
      await service.introspect("t1", "c1");
      expect(rec.calls).toBe(2);
    });

    it("does not cache a failure — a transient outage must not stick", async () => {
      const { service, rec } = withFakeDb({
        throwOnRun: new Error("boom"),
      });
      await service.introspect("t1", "c1").catch(() => undefined);
      await service.introspect("t1", "c1").catch(() => undefined);
      expect(rec.calls).toBe(2);
    });
  });
});
