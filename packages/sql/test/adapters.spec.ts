import { afterEach, describe, expect, it, vi } from "vitest";

// Shared call log; declared via vi.hoisted so the hoisted vi.mock factory can use it.
const { events } = vi.hoisted(() => ({ events: [] as string[] }));

// Fake the mssql driver so the adapter's transaction flow is observable without a
// live SQL Server. (Postgres uses an injectable seam instead — no mock needed.)
vi.mock("mssql", () => {
  class FakePool {
    constructor(public dsn: string) {}
    async connect() {
      events.push("connect");
    }
    async close() {
      events.push("close");
    }
  }
  class FakeTransaction {
    constructor(public pool: unknown) {}
    async begin() {
      events.push("begin");
    }
    async rollback() {
      events.push("rollback");
    }
  }
  class FakeRequest {
    constructor(public tx: unknown) {}
    input(name: string, value: unknown) {
      events.push(`input:${name}=${String(value)}`);
    }
    async query(sql: string) {
      events.push(`query:${sql}`);
      return { recordset: [{ id: 1 }] };
    }
  }
  return {
    ConnectionPool: FakePool,
    Transaction: FakeTransaction,
    Request: FakeRequest,
  };
});

import { __mssqlDeps, augmentMssqlDsn, mssqlAdapter } from "../src/mssql";
import { __mysqlDeps, mysqlAdapter } from "../src/mysql";
import { __pgDeps, postgresAdapter } from "../src/postgres";

afterEach(() => {
  events.length = 0;
});

describe("postgresAdapter", () => {
  it("runs the query inside a READ ONLY transaction, rolls back, and closes", async () => {
    const calls: string[] = [];
    __pgDeps.createClient = () => ({
      connect: async () => undefined,
      query: async (text: string) => {
        calls.push(text);
        return text.startsWith("SELECT")
          ? { rows: [{ id: 1 }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      },
      end: async () => {
        calls.push("END");
      },
    });
    const res = await postgresAdapter.runReadOnly("dsn", "SELECT 1", [], {
      timeoutMs: 1000,
    });
    expect(res).toEqual({ rows: [{ id: 1 }], rowCount: 1 });
    expect(calls).toEqual([
      "BEGIN TRANSACTION READ ONLY",
      "SELECT 1",
      "ROLLBACK",
      "END",
    ]);
  });

  it("closes the client even when the query throws (no leaked connection)", async () => {
    let ended = false;
    __pgDeps.createClient = () => ({
      connect: async () => undefined,
      query: async (text: string) => {
        if (text === "SELECT bad") throw new Error("boom");
        return { rows: [], rowCount: 0 };
      },
      end: async () => {
        ended = true;
      },
    });
    await expect(
      postgresAdapter.runReadOnly("dsn", "SELECT bad", [], { timeoutMs: 1000 }),
    ).rejects.toThrow("boom");
    expect(ended).toBe(true);
  });
});

describe("augmentMssqlDsn", () => {
  it("appends ApplicationIntent + Request Timeout when absent", () => {
    expect(augmentMssqlDsn("Server=db;Database=app", 5000)).toBe(
      "Server=db;Database=app;ApplicationIntent=ReadOnly;Request Timeout=5000",
    );
  });

  it("does not duplicate values the DSN already sets", () => {
    const dsn = "Server=db;ApplicationIntent=ReadOnly;Request Timeout=10";
    expect(augmentMssqlDsn(dsn, 5000)).toBe(dsn);
  });
});

describe("mssqlAdapter", () => {
  it("binds @p params, runs in a transaction that is ALWAYS rolled back, closes pool", async () => {
    const res = await mssqlAdapter.runReadOnly(
      "Server=db;",
      "SELECT @p1",
      ["x"],
      {
        timeoutMs: 1000,
      },
    );
    expect(res).toEqual({ rows: [{ id: 1 }], rowCount: 1 });
    expect(events).toEqual([
      "connect",
      "begin",
      "input:p1=x",
      "query:SELECT @p1",
      "rollback",
      "close",
    ]);
  });
});

describe("postgresAdapter.runWrite", () => {
  it("runs the write in a txn that COMMITs, returns rowsAffected, closes", async () => {
    const calls: string[] = [];
    __pgDeps.createClient = () => ({
      connect: async () => undefined,
      query: async (text: string) => {
        calls.push(text);
        return text.startsWith("UPDATE")
          ? { rows: [], rowCount: 2 }
          : { rows: [], rowCount: 0 };
      },
      end: async () => {
        calls.push("END");
      },
    });
    const res = await postgresAdapter.runWrite("dsn", "UPDATE t SET x=1", [], {
      timeoutMs: 1000,
    });
    expect(res).toEqual({ rowsAffected: 2 });
    expect(calls).toEqual(["BEGIN", "UPDATE t SET x=1", "COMMIT", "END"]);
  });

  it("ROLLBACKs and rethrows when the write fails (nothing persists)", async () => {
    const calls: string[] = [];
    __pgDeps.createClient = () => ({
      connect: async () => undefined,
      query: async (text: string) => {
        calls.push(text);
        if (text.startsWith("UPDATE")) throw new Error("constraint");
        return { rows: [], rowCount: 0 };
      },
      end: async () => {
        calls.push("END");
      },
    });
    await expect(
      postgresAdapter.runWrite("dsn", "UPDATE t SET x=1", [], {
        timeoutMs: 1000,
      }),
    ).rejects.toThrow("constraint");
    expect(calls).toContain("ROLLBACK");
    expect(calls).toContain("END"); // still closed
  });
});

describe("mysqlAdapter", () => {
  function fakeConn(rowsOrResult: unknown, log: string[]) {
    return {
      query: async (sql: string) => {
        log.push(sql);
        return [rowsOrResult, []] as [unknown, unknown];
      },
      end: async () => {
        log.push("end");
      },
    };
  }

  it("reads inside a READ ONLY transaction and rolls back", async () => {
    const log: string[] = [];
    __mysqlDeps.createConnection = async () => fakeConn([{ id: 1 }], log);
    const res = await mysqlAdapter.runReadOnly("mysql://x", "SELECT 1", [], {
      timeoutMs: 1000,
    });
    expect(res).toEqual({ rows: [{ id: 1 }], rowCount: 1 });
    expect(log).toContain("START TRANSACTION READ ONLY");
    expect(log).toContain("ROLLBACK");
    expect(log).toContain("end");
  });

  it("writes inside a transaction that COMMITs and returns affectedRows", async () => {
    const log: string[] = [];
    __mysqlDeps.createConnection = async () =>
      fakeConn({ affectedRows: 4 }, log);
    const res = await mysqlAdapter.runWrite("mysql://x", "DELETE FROM t", [], {
      timeoutMs: 1000,
    });
    expect(res).toEqual({ rowsAffected: 4 });
    expect(log).toContain("START TRANSACTION");
    expect(log).toContain("COMMIT");
  });
});

describe("connect-pinning is forwarded to every driver seam (#597)", () => {
  // The pin only helps if it actually reaches the driver factory — pin.spec proves each
  // factory then dials it; this proves the adapters pass it down (all three engines).
  it("pg / mysql / mssql each receive opts.pinnedHost", async () => {
    const pinned: (string | undefined)[] = [];
    __pgDeps.createClient = ((_dsn: string, _t: number, pin?: string) => {
      pinned.push(pin);
      return {
        connect: async () => undefined,
        query: async () => ({ rows: [], rowCount: 0 }),
        end: async () => undefined,
      };
    }) as never;
    __mysqlDeps.createConnection = (async (
      _dsn: string,
      _t: number,
      pin?: string,
    ) => {
      pinned.push(pin);
      return {
        query: async () => [[], []] as [unknown, unknown],
        end: async () => undefined,
      };
    }) as never;
    __mssqlDeps.createPool = ((_dsn: string, _t: number, pin?: string) => {
      pinned.push(pin);
      return {
        connect: async () => undefined,
        close: async () => undefined,
      };
    }) as never;

    const opts = { timeoutMs: 1000, pinnedHost: "93.184.216.34" };
    await postgresAdapter.runReadOnly("dsn", "SELECT 1", [], opts);
    await mysqlAdapter.runReadOnly("mysql://x", "SELECT 1", [], opts);
    await mssqlAdapter.runReadOnly("Server=db;", "SELECT 1", [], opts);
    expect(pinned).toEqual(["93.184.216.34", "93.184.216.34", "93.184.216.34"]);
  });
});
