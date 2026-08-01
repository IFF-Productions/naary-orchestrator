/**
 * Per-engine catalog query building + row → summary mapping (#1004).
 *
 * These pin the things that differ BETWEEN engines and the things that must not silently degrade:
 * system-schema filtering (a picker full of `pg_catalog` is useless), the size caps (a truncated
 * list must SAY it is truncated), and the "drop whole tables, never half a table" rule.
 */
import { describe, expect, it } from "vitest";
import {
  SQL_SCHEMA_MAX_COLUMNS,
  buildSchemaQuery,
  summarizeSchemaRows,
} from "../src/schema";

const row = (
  schema: string,
  table: string,
  column: string,
  type = "text",
  nullable: unknown = "YES",
) => ({
  table_schema: schema,
  table_name: table,
  column_name: column,
  data_type: type,
  is_nullable: nullable,
});

describe("buildSchemaQuery — per engine", () => {
  it("postgres reads information_schema and excludes the system schemas", () => {
    const sql = buildSchemaQuery("postgres");
    expect(sql).toContain("information_schema.columns");
    expect(sql).toContain("'pg_catalog'");
    expect(sql).toContain("'information_schema'");
    // Prefix-matched schemas can't be listed by name.
    expect(sql).toContain("pg\\_toast%");
    expect(sql).toContain("pg\\_temp\\_%");
    // Enum/composite columns report data_type = 'USER-DEFINED'; the real name comes from udt_name.
    expect(sql).toContain("USER-DEFINED");
    expect(sql).toContain("udt_name");
  });

  it("mysql scopes to the DSN's database, falling back to non-system schemas", () => {
    const sql = buildSchemaQuery("mysql");
    // MySQL has no schema/database split — table_schema IS the database.
    expect(sql).toContain("c.TABLE_SCHEMA = DATABASE()");
    expect(sql).toContain("DATABASE() IS NULL");
    for (const s of ["mysql", "performance_schema", "sys"]) {
      expect(sql).toContain(`'${s}'`);
    }
    // COLUMN_TYPE keeps varchar(255); DATA_TYPE would flatten it to varchar.
    expect(sql).toContain("c.COLUMN_TYPE");
  });

  it("mssql uses the sys catalog views, keeps dbo, and drops the role schemas", () => {
    const sql = buildSchemaQuery("mssql");
    expect(sql).toContain("sys.columns");
    expect(sql).toContain("sys.schemas");
    expect(sql).toContain("sys.types");
    expect(sql).toContain("'sys'");
    expect(sql).toContain("'INFORMATION_SCHEMA'");
    expect(sql).toContain("'db_owner'");
    // `dbo` is the DEFAULT user schema — excluding it would empty the picker on a typical database.
    expect(sql).not.toContain("'dbo'");
    // TOP (n), not LIMIT.
    expect(sql).toContain("TOP (");
    expect(sql).not.toContain("LIMIT");
  });

  it("caps in the DATABASE (limit = cap + 1, the truncation sentinel)", () => {
    expect(buildSchemaQuery("postgres", 10)).toContain("LIMIT 11");
    expect(buildSchemaQuery("mysql", 10)).toContain("LIMIT 11");
    expect(buildSchemaQuery("mssql", 10)).toContain("TOP (11)");
    expect(buildSchemaQuery("postgres")).toContain(
      `LIMIT ${SQL_SCHEMA_MAX_COLUMNS + 1}`,
    );
  });

  it("every engine orders deterministically, so the mapper can group consecutive rows", () => {
    for (const engine of ["postgres", "mysql", "mssql"] as const) {
      expect(buildSchemaQuery(engine)).toMatch(/ORDER BY/);
    }
  });

  it("binds no parameters — three engines, three placeholder dialects", () => {
    for (const engine of ["postgres", "mysql", "mssql"] as const) {
      const sql = buildSchemaQuery(engine);
      expect(sql).not.toContain("$1");
      expect(sql).not.toContain("@p1");
      expect(sql).not.toMatch(/\?/);
    }
  });
});

describe("summarizeSchemaRows", () => {
  it("groups columns under their table", () => {
    const out = summarizeSchemaRows([
      row("public", "users", "id", "integer", "NO"),
      row("public", "users", "email"),
      row("public", "orders", "id", "integer", "NO"),
    ]);
    expect(out.tables).toEqual([
      {
        schema: "public",
        name: "users",
        columns: [
          { name: "id", type: "integer", nullable: false },
          { name: "email", type: "text", nullable: true },
        ],
      },
      {
        schema: "public",
        name: "orders",
        columns: [{ name: "id", type: "integer", nullable: false }],
      },
    ]);
    expect(out.truncated).toBe(false);
    expect(out.note).toBeUndefined();
  });

  it("keeps same-named tables in different schemas apart", () => {
    const out = summarizeSchemaRows([
      row("public", "users", "id"),
      row("audit", "users", "id"),
    ]);
    expect(out.tables).toHaveLength(2);
    expect(out.tables.map((t) => t.schema)).toEqual(["public", "audit"]);
  });

  it("reads mssql's boolean/bit nullability and mysql's uppercase keys", () => {
    const out = summarizeSchemaRows([
      {
        TABLE_SCHEMA: "dbo",
        TABLE_NAME: "t",
        COLUMN_NAME: "a",
        DATA_TYPE: "int",
        IS_NULLABLE: 0,
      },
      {
        table_schema: "dbo",
        table_name: "t",
        column_name: "b",
        data_type: "nvarchar",
        is_nullable: true,
      },
    ]);
    expect(out.tables[0].columns).toEqual([
      { name: "a", type: "int", nullable: false },
      { name: "b", type: "nvarchar", nullable: true },
    ]);
  });

  it("skips malformed rows instead of throwing (arbitrary tenant database)", () => {
    const out = summarizeSchemaRows([
      null,
      "nonsense",
      { table_schema: "public", table_name: "users" }, // no column
      row("public", "users", "id"),
    ]);
    expect(out.tables).toEqual([
      {
        schema: "public",
        name: "users",
        columns: [{ name: "id", type: "text", nullable: true }],
      },
    ]);
  });

  it("an empty catalog (a credential that can see nothing) is a result, not a failure", () => {
    expect(summarizeSchemaRows([])).toEqual({
      tables: [],
      truncated: false,
      droppedTables: 0,
    });
  });

  describe("size bounds", () => {
    it("drops the WHOLE trailing table when the row cap was hit, and says so", () => {
      // cap 3 → the query returns 4 rows; the 4th proves there was more.
      const out = summarizeSchemaRows(
        [
          row("public", "a", "c1"),
          row("public", "a", "c2"),
          row("public", "b", "c1"),
          row("public", "b", "c2"),
        ],
        { maxColumns: 3 },
      );
      // `b` is dropped ENTIRELY: we cannot tell whether we saw all of its columns, and a table
      // shown with columns missing makes autocomplete confidently omit a real column.
      expect(out.tables.map((t) => t.name)).toEqual(["a"]);
      expect(out.tables[0].columns).toHaveLength(2);
      expect(out.truncated).toBe(true);
      expect(out.note).toContain("public.b");
      expect(out.note).toContain("more than 3 columns");
    });

    it("drops trailing tables over the table cap, and counts them exactly", () => {
      const rows = ["a", "b", "c", "d"].map((t) => row("public", t, "id"));
      const out = summarizeSchemaRows(rows, { maxTables: 2 });
      expect(out.tables.map((t) => t.name)).toEqual(["a", "b"]);
      expect(out.truncated).toBe(true);
      expect(out.droppedTables).toBe(2);
      expect(out.note).toContain("2 more");
    });

    it("does not truncate when the row count exactly equals the cap", () => {
      const out = summarizeSchemaRows(
        [row("public", "a", "c1"), row("public", "a", "c2")],
        { maxColumns: 2 },
      );
      expect(out.truncated).toBe(false);
      expect(out.tables).toHaveLength(1);
    });
  });
});
