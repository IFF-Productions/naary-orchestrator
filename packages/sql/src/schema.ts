/**
 * Authoring-time schema introspection for the `sqlQuery` / `sqlExec` nodes (#1004).
 *
 * This module is PURE: it builds the per-engine catalog query and maps the returned rows into a
 * `{ tables: [{ schema, name, columns }] }` summary. It opens no sockets, sees no DSN and holds no
 * state — the caller (the API's IntrospectService) runs the query through the already-audited
 * `SqlEngineAdapter.runReadOnly`, which owns the read-only enforcement, the SSRF connect-pinning
 * and the in-memory-only DSN handling.
 *
 * Why `information_schema`/catalog views instead of `prisma db pull`: Prisma would need its engine
 * binary in the API image and returns a Prisma DSL we would have to parse back into a table/column
 * list — a lossy round trip for what is fundamentally "list tables and columns" (issue #1004).
 *
 * The three engines are NOT interchangeable here, so there is one query per engine rather than one
 * query hoped to work everywhere:
 *  - **postgres** — `information_schema` is scoped to the current database already. `data_type` is
 *    the literal `USER-DEFINED` for enums/composites, so `udt_name` is substituted for those.
 *  - **mysql** — has no schema-vs-database distinction: `table_schema` IS the database. The DSN
 *    normally names one, so we scope to `DATABASE()` and only fall back to "every non-system
 *    database" when the DSN named none (otherwise a server with 200 tenant databases would dump
 *    all of them into an autocomplete list).
 *  - **mssql** — the `sys` catalog views are Microsoft's recommended source and carry the real
 *    type name and a proper boolean nullability. `dbo` is the DEFAULT user schema, not a system
 *    one, so the filter drops only `sys`/`INFORMATION_SCHEMA` and the fixed database-role schemas —
 *    dropping `dbo` would empty the picker on the most common SQL Server layout.
 *
 * Permissions: all three sources are privilege-filtered by the engine (a login only sees metadata
 * for objects it has some permission on), so a partial credential degrades naturally to "fewer
 * tables" instead of an error. That is deliberate — introspection must never block authoring.
 */

import type { SqlColumnInfo, SqlSchemaSummary, SqlTableInfo } from "@naary/dsl";
import type { SqlEngine } from "./types";

// The RESULT shapes live in @naary/dsl, next to `OpenApiSummary`/`GraphQLSchemaSummary`: they are a
// wire contract between the API and the canvas, and the canvas cannot depend on this package (it
// carries pg/mysql2/mssql). The per-engine SQL and the mapper — the parts that know about
// databases — stay here. Re-exported so a server-side caller needs only one import.
export type { SqlColumnInfo, SqlSchemaSummary, SqlTableInfo };

/**
 * Caps. A large warehouse can have hundreds of thousands of columns; shipping those to the browser
 * would be a denial of service on the control plane and on the editor. The ROW cap is applied by
 * the database itself (`LIMIT` / `TOP`), so the rows are never even transferred.
 */
export const SQL_SCHEMA_MAX_COLUMNS = 20_000;
export const SQL_SCHEMA_MAX_TABLES = 1_500;

/** Postgres system schemas. `pg_toast`/`pg_temp_*` are matched by prefix, not by name. */
const PG_SYSTEM_SCHEMAS = ["pg_catalog", "information_schema"];

/** MySQL's four system databases (they are schemas, in MySQL's flat namespace). */
const MYSQL_SYSTEM_SCHEMAS = [
  "mysql",
  "information_schema",
  "performance_schema",
  "sys",
];

/**
 * SQL Server system schemas. NOTE `dbo` is deliberately absent — it is the default schema for user
 * objects, so excluding it would return an empty list on a typical database. The `db_*` entries are
 * the fixed database roles, which own schemas of the same name and never hold user tables.
 */
const MSSQL_SYSTEM_SCHEMAS = [
  "sys",
  "INFORMATION_SCHEMA",
  "guest",
  "db_owner",
  "db_accessadmin",
  "db_securityadmin",
  "db_ddladmin",
  "db_backupoperator",
  "db_datareader",
  "db_datawriter",
  "db_denydatareader",
  "db_denydatawriter",
];

/** Render a string list as a SQL `IN (...)` literal list. Inputs are OUR constants, never user
 *  input — the quote-doubling is belt-and-braces so this can never become an injection seam. */
function inList(values: string[]): string {
  return values.map((v) => `'${v.replace(/'/g, "''")}'`).join(", ");
}

/**
 * The catalog query for `engine`, capped at `maxColumns + 1` rows. The extra row is the truncation
 * sentinel: getting it back means there was more, which is how the caller learns to set `truncated`
 * without a second COUNT round trip.
 *
 * There are NO bind parameters — the three engines use three different placeholder dialects
 * (`$1` / `?` / `@p1`) and every value here is a compile-time constant of ours, so literal text in
 * each per-engine string sidesteps that entirely.
 *
 * Ordering is deterministic (schema, table, ordinal) in every dialect, which is what lets the
 * mapper group consecutive rows and drop only WHOLE trailing tables.
 */
export function buildSchemaQuery(
  engine: SqlEngine,
  maxColumns: number = SQL_SCHEMA_MAX_COLUMNS,
): string {
  const limit = Math.max(1, Math.floor(maxColumns)) + 1;
  switch (engine) {
    case "postgres":
      return [
        "SELECT c.table_schema AS table_schema,",
        "       c.table_name AS table_name,",
        "       c.column_name AS column_name,",
        // `data_type` is the literal string 'USER-DEFINED' for enums/composites/domains, which is
        // useless in a picker — fall back to the underlying type's name for those.
        "       CASE WHEN c.data_type = 'USER-DEFINED' THEN c.udt_name ELSE c.data_type END AS data_type,",
        "       c.is_nullable AS is_nullable",
        "  FROM information_schema.columns c",
        "  JOIN information_schema.tables t",
        "    ON t.table_schema = c.table_schema AND t.table_name = c.table_name",
        ` WHERE c.table_schema NOT IN (${inList(PG_SYSTEM_SCHEMAS)})`,
        "   AND c.table_schema NOT LIKE 'pg\\_toast%'",
        "   AND c.table_schema NOT LIKE 'pg\\_temp\\_%'",
        "   AND t.table_type IN ('BASE TABLE', 'VIEW')",
        " ORDER BY c.table_schema, c.table_name, c.ordinal_position",
        ` LIMIT ${limit}`,
      ].join("\n");

    case "mysql":
      return [
        "SELECT c.TABLE_SCHEMA AS table_schema,",
        "       c.TABLE_NAME AS table_name,",
        "       c.COLUMN_NAME AS column_name,",
        // COLUMN_TYPE keeps the length/enum detail (`varchar(255)`); DATA_TYPE would lose it.
        "       c.COLUMN_TYPE AS data_type,",
        "       c.IS_NULLABLE AS is_nullable",
        "  FROM information_schema.COLUMNS c",
        // MySQL has no schema/database split: scope to the DSN's database when it named one,
        // else every non-system database on the server.
        " WHERE (c.TABLE_SCHEMA = DATABASE()",
        "        OR (DATABASE() IS NULL",
        `            AND c.TABLE_SCHEMA NOT IN (${inList(MYSQL_SYSTEM_SCHEMAS)})))`,
        " ORDER BY c.TABLE_SCHEMA, c.TABLE_NAME, c.ORDINAL_POSITION",
        ` LIMIT ${limit}`,
      ].join("\n");

    case "mssql":
      return [
        // TOP (n) rather than LIMIT, and the sys catalog views rather than INFORMATION_SCHEMA:
        // they give the real type name (INFORMATION_SCHEMA loses it for aliases) and a genuine
        // bit for nullability.
        `SELECT TOP (${limit}) s.name AS table_schema,`,
        "       t.name AS table_name,",
        "       c.name AS column_name,",
        "       ty.name AS data_type,",
        "       c.is_nullable AS is_nullable",
        "  FROM sys.columns c",
        "  JOIN sys.objects t ON t.object_id = c.object_id AND t.type IN ('U', 'V')",
        "  JOIN sys.schemas s ON s.schema_id = t.schema_id",
        "  LEFT JOIN sys.types ty ON ty.user_type_id = c.user_type_id",
        ` WHERE s.name NOT IN (${inList(MSSQL_SYSTEM_SCHEMAS)})`,
        " ORDER BY s.name, t.name, c.column_id",
      ].join("\n");

    default: {
      // Exhaustive: adding an engine to SqlEngine without a query here is a compile error.
      const never: never = engine;
      throw new Error(
        `Unsupported SQL engine for introspection: ${String(never)}`,
      );
    }
  }
}

/** Case-insensitive field read — drivers differ on the case they hand back for the same alias. */
function field(row: Record<string, unknown>, key: string): unknown {
  if (key in row) return row[key];
  const lower = key.toLowerCase();
  for (const k of Object.keys(row)) {
    if (k.toLowerCase() === lower) return row[k];
  }
  return undefined;
}

function asText(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "bigint") return String(v);
  return "";
}

/**
 * Nullability across three dialects: postgres/mysql `information_schema` yield the strings
 * `'YES'`/`'NO'`, mssql `sys.columns.is_nullable` yields a bit that tedious surfaces as a boolean
 * (or, on some driver configs, 0/1). Unknown ⇒ nullable, the safer display default.
 */
function asNullable(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (s === "no" || s === "n" || s === "0" || s === "false") return false;
    return true;
  }
  return true;
}

/**
 * Group catalog rows into the table list, applying both caps.
 *
 * The dropping rule is the important part: whole TRAILING TABLES are dropped, never a table's
 * column list mid-way. A table shown with columns silently missing would make autocomplete
 * confidently omit a real column — strictly worse than the table not being offered at all.
 *
 * `rows` is expected to be the query's output, i.e. up to `maxColumns + 1` rows ordered by
 * (schema, table, ordinal). Rows missing a schema/table/column name are skipped rather than
 * throwing: this is untrusted-ish data from an arbitrary tenant database.
 */
export function summarizeSchemaRows(
  rows: unknown[],
  opts: { maxColumns?: number; maxTables?: number } = {},
): SqlSchemaSummary {
  const maxColumns = opts.maxColumns ?? SQL_SCHEMA_MAX_COLUMNS;
  const maxTables = opts.maxTables ?? SQL_SCHEMA_MAX_TABLES;

  // The sentinel row proves there was more than the cap; keep only the capped prefix.
  const hitRowCap = rows.length > maxColumns;
  const usable = hitRowCap ? rows.slice(0, maxColumns) : rows;

  const tables: SqlTableInfo[] = [];
  let current: SqlTableInfo | undefined;
  for (const raw of usable) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const row = raw as Record<string, unknown>;
    const schema = asText(field(row, "table_schema"));
    const name = asText(field(row, "table_name"));
    const column = asText(field(row, "column_name"));
    if (!name || !column) continue;
    if (!current || current.schema !== schema || current.name !== name) {
      current = { schema, name, columns: [] };
      tables.push(current);
    }
    current.columns.push({
      name: column,
      type: asText(field(row, "data_type")),
      nullable: asNullable(field(row, "is_nullable")),
    });
  }

  const notes: string[] = [];
  let truncated = false;

  // The row cap truncated the stream mid-catalog, so the LAST table we assembled may be missing
  // columns. We cannot tell whether it is complete, so it goes entirely.
  if (hitRowCap && tables.length > 0) {
    const partial = tables.pop()!;
    truncated = true;
    notes.push(
      `This database has more than ${maxColumns} columns, so introspection stopped at ` +
        `"${partial.schema ? `${partial.schema}.` : ""}${partial.name}". Tables from there on ` +
        `are not in this list.`,
    );
  }

  let droppedTables = 0;
  if (tables.length > maxTables) {
    droppedTables = tables.length - maxTables;
    tables.length = maxTables;
    truncated = true;
    notes.push(
      `Showing the first ${maxTables} tables; ${droppedTables} more were not included.`,
    );
  }

  return {
    tables,
    truncated,
    droppedTables,
    ...(notes.length > 0 ? { note: notes.join(" ") } : {}),
  };
}
