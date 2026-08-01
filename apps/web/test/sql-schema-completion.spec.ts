/**
 * SQL autocomplete over an introspected schema (#1004) — the pure half, which is where all the
 * behaviour that can be wrong lives. (The other half is CodeMirror wiring, tested by using it.)
 *
 * The cases that matter are the ones where a naive implementation is confidently WRONG: treating
 * `WHERE` as a table alias, completing inside a string literal, or offering columns of a table the
 * query never mentions.
 */
import { describe, expect, it } from "vitest";
import type { SqlSchemaSummary } from "@naary/dsl";
import {
  collectTableAliases,
  describeSqlSchema,
  sqlCompletions,
} from "../src/canvas/sql-schema";

const SCHEMA: SqlSchemaSummary = {
  truncated: false,
  droppedTables: 0,
  tables: [
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
      columns: [
        { name: "id", type: "integer", nullable: false },
        { name: "user_id", type: "integer", nullable: false },
      ],
    },
    {
      schema: "billing",
      name: "invoices",
      columns: [{ name: "total", type: "numeric", nullable: true }],
    },
  ],
};

/** `doc` is the text BEFORE the caret; `full` the whole query when the caret is mid-document. */
const labels = (doc: string, full?: string) =>
  (sqlCompletions(SCHEMA, doc, full)?.options ?? []).map((o) => o.label);

describe("collectTableAliases", () => {
  it("maps both the alias and the bare table name", () => {
    expect(collectTableAliases("SELECT * FROM public.users u")).toEqual({
      users: "public.users",
      u: "public.users",
    });
  });

  it("handles AS, and multiple joins", () => {
    expect(
      collectTableAliases(
        "SELECT * FROM users AS u JOIN orders o ON o.id = u.id",
      ),
    ).toMatchObject({
      u: "users",
      o: "orders",
      users: "users",
      orders: "orders",
    });
  });

  it("does not mistake a following KEYWORD for an alias", () => {
    // Without the keyword guard, `w.` would then complete users' columns — confidently wrong.
    const aliases = collectTableAliases("SELECT * FROM users WHERE id = $1");
    expect(aliases).toEqual({ users: "users" });
    expect(aliases.where).toBeUndefined();
  });
});

describe("sqlCompletions", () => {
  it("offers tables straight after FROM", () => {
    expect(labels("SELECT * FROM ")).toContain("users");
    expect(labels("SELECT * FROM ")).toContain("orders");
    // A non-default schema is also offered qualified, since a bare name may be ambiguous.
    expect(labels("SELECT * FROM ")).toContain("billing.invoices");
    // …but `public` isn't noise-prefixed onto everything.
    expect(labels("SELECT * FROM ")).not.toContain("public.users");
  });

  it("offers tables after JOIN / UPDATE / INSERT INTO", () => {
    expect(labels("SELECT * FROM users JOIN ")).toContain("orders");
    expect(labels("UPDATE ")).toContain("users");
    expect(labels("INSERT INTO ")).toContain("users");
  });

  it("completes a table's columns through its alias", () => {
    expect(labels("SELECT * FROM users u WHERE u.")).toEqual(["id", "email"]);
  });

  it("reads the alias from the FROM clause to the RIGHT of the caret", () => {
    // The single most common place a person wants a column: back in the SELECT list, with the
    // FROM already written. Aliases must come from the WHOLE statement, not just what precedes.
    expect(labels("SELECT u.", "SELECT u. FROM users u")).toEqual([
      "id",
      "email",
    ]);
  });

  it("completes columns through the bare table name too", () => {
    expect(labels("SELECT * FROM users WHERE users.")).toEqual(["id", "email"]);
  });

  it("completes columns through a schema-qualified name", () => {
    expect(
      labels("SELECT * FROM billing.invoices WHERE billing.invoices."),
    ).toEqual(["total"]);
  });

  it("treats a bare schema qualifier as 'tables in that schema'", () => {
    expect(labels("SELECT * FROM billing.")).toEqual(["invoices"]);
  });

  it("prefers the in-scope table's columns in a SELECT list", () => {
    const out = labels("SELECT  FROM orders o".slice(0, "SELECT ".length));
    // With no FROM parsed yet there is nothing in scope — every table is offered instead.
    expect(out).toContain("users");
  });

  it("puts the columns of the tables the query names first", () => {
    const out = labels("SELECT * FROM orders o WHERE ");
    expect(out.slice(0, 2)).toEqual(["id", "user_id"]);
  });

  it("carries the column type as the completion detail", () => {
    const opts =
      sqlCompletions(SCHEMA, "SELECT u. FROM users u")?.options ?? [];
    expect(opts[0]).toEqual({
      label: "id",
      type: "property",
      detail: "integer not null",
    });
  });

  it("marks the replacement range at the start of the typed word", () => {
    const doc = "SELECT * FROM us";
    expect(sqlCompletions(SCHEMA, doc)?.from).toBe(doc.length - 2);
  });

  it("offers nothing inside a string literal", () => {
    expect(
      sqlCompletions(SCHEMA, "SELECT * FROM users WHERE email = 'us"),
    ).toBeNull();
  });

  it("offers nothing for an unknown qualifier", () => {
    expect(sqlCompletions(SCHEMA, "SELECT nope.")).toBeNull();
  });

  it("is inert when the schema is missing or empty — never blocks authoring", () => {
    expect(sqlCompletions(null, "SELECT * FROM ")).toBeNull();
    expect(
      sqlCompletions(
        { tables: [], truncated: false, droppedTables: 0 },
        "SELECT * FROM ",
      ),
    ).toBeNull();
  });
});

describe("describeSqlSchema", () => {
  it("counts tables and columns", () => {
    expect(describeSqlSchema(SCHEMA)).toBe("3 tables, 5 columns");
  });

  it("surfaces the truncation note rather than hiding it", () => {
    expect(
      describeSqlSchema({
        ...SCHEMA,
        truncated: true,
        note: "2 more were not included.",
      }),
    ).toContain("2 more were not included.");
  });
});
