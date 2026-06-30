import { describe, expect, it } from "vitest";
import { resolveSqlQuery } from "../src/sql-query";
import type { SqlQueryNodeConfig } from "../src/types";

const ctx = {
  trigger: { userId: "u-7" },
  agent: { output: { limit: 5 } },
};

describe("resolveSqlQuery", () => {
  it("passes sql + static params through unchanged when there are no bindings", () => {
    const config: SqlQueryNodeConfig = {
      connectionId: "db",
      sql: "SELECT 1",
      params: [1, 2],
      statementTimeoutMs: 5000,
      costUsd: 0.001,
    };
    expect(resolveSqlQuery(config, ctx)).toEqual({
      connectionId: "db",
      sql: "SELECT 1",
      params: [1, 2],
      statementTimeoutMs: 5000,
      costUsd: 0.001,
    });
  });

  it("fills positional params from 1-based bindings and leaves the sql untouched", () => {
    const config: SqlQueryNodeConfig = {
      connectionId: "db",
      sql: "SELECT * FROM t WHERE id = $1 LIMIT $2",
      params: [0, 10],
      paramBindings: {
        1: { from: "trigger", path: "userId" },
        2: { from: "agent", path: "output.limit" },
      },
    };
    const r = resolveSqlQuery(config, ctx);
    // a binding can NEVER alter the query text — only the params
    expect(r.sql).toBe("SELECT * FROM t WHERE id = $1 LIMIT $2");
    expect(r.params).toEqual(["u-7", 5]);
  });

  it("does not mutate the source config's params array", () => {
    const params = [1];
    const config: SqlQueryNodeConfig = {
      connectionId: "db",
      sql: "x",
      params,
      paramBindings: { 1: { from: "trigger", path: "userId" } },
    };
    resolveSqlQuery(config, ctx);
    expect(params).toEqual([1]); // original untouched
  });
});
