/**
 * SQL autocomplete over an introspected schema (#1004) — the PURE half.
 *
 * Kept out of the editor component (the house pattern — cf. `openapi-import.ts` and
 * `graphql-introspect.ts`) so the interesting cases are unit-testable under the repo's `node`
 * vitest environment, with no CodeMirror and no DOM. `SqlEditor.tsx` wraps `sqlCompletions` into a
 * CodeMirror `CompletionSource`; nothing here knows CodeMirror exists.
 *
 * This is a deliberately small parser, not a SQL grammar. It answers three questions from the text
 * to the LEFT of the cursor, which is all autocomplete needs:
 *   1. Is the word being typed qualified (`u.` / `public.`)? → columns of that table, or tables of
 *      that schema.
 *   2. Are we right after FROM/JOIN/UPDATE/INTO? → tables only.
 *   3. Otherwise → columns of the tables already named in this statement, then every table.
 */
import type { SqlSchemaSummary, SqlTableInfo } from "@naary/dsl";

export interface SqlCompletionOption {
  label: string;
  /** CodeMirror completion `type` — drives the icon/colour. */
  type: "class" | "property";
  /** Secondary text: the schema for a table, the column type for a column. */
  detail?: string;
}

export interface SqlCompletionResult {
  /** Offset in the source text where the replacement starts (the start of the typed word). */
  from: number;
  options: SqlCompletionOption[];
}

/** Schemas whose name is noise in a picker — every Postgres/SQL Server database has one. */
const DEFAULT_SCHEMAS = new Set(["public", "dbo", ""]);

/**
 * Words that can follow a table name but are NOT an alias. Without this, `FROM users WHERE` would
 * register `where` as an alias for `users`, and `w.` would then complete columns — confidently wrong.
 */
const NOT_AN_ALIAS = new Set([
  "as",
  "on",
  "using",
  "where",
  "group",
  "order",
  "having",
  "limit",
  "offset",
  "join",
  "inner",
  "left",
  "right",
  "full",
  "outer",
  "cross",
  "natural",
  "lateral",
  "union",
  "set",
  "values",
  "select",
  "and",
  "or",
  "returning",
  "for",
  "into",
  "with",
  "window",
  "fetch",
]);

/** Keywords after which only a TABLE can appear. */
const TABLE_CONTEXT = /\b(from|join|update|into|table)\s+[\w$."]*$/i;

const IDENT = "[A-Za-z_][A-Za-z0-9_$]*";

/**
 * Map every alias (and bare table name) used in `sql` to the table it refers to.
 *
 * Both directions matter: `FROM public.users u` must make `u.` complete users' columns AND
 * `users.` do the same, because people write both.
 */
export function collectTableAliases(sql: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = new RegExp(
    `\\b(?:from|join|update|into)\\s+(${IDENT}(?:\\.${IDENT})?)(?:\\s+(?:as\\s+)?(${IDENT}))?`,
    "gi",
  );
  for (const m of sql.matchAll(re)) {
    const ref = m[1];
    const bare = ref.includes(".") ? ref.slice(ref.indexOf(".") + 1) : ref;
    out[bare.toLowerCase()] = ref;
    const alias = m[2];
    if (alias && !NOT_AN_ALIAS.has(alias.toLowerCase())) {
      out[alias.toLowerCase()] = ref;
    }
  }
  return out;
}

/** Find the table a qualifier (`u` / `users` / `public.users`) points at, if any. */
function findTable(
  schema: SqlSchemaSummary,
  ref: string,
): SqlTableInfo | undefined {
  const dot = ref.indexOf(".");
  if (dot !== -1) {
    const s = ref.slice(0, dot).toLowerCase();
    const t = ref.slice(dot + 1).toLowerCase();
    return schema.tables.find(
      (x) => x.schema.toLowerCase() === s && x.name.toLowerCase() === t,
    );
  }
  const lower = ref.toLowerCase();
  return schema.tables.find((x) => x.name.toLowerCase() === lower);
}

function tableOption(t: SqlTableInfo, qualified: boolean): SqlCompletionOption {
  return {
    label: qualified && t.schema ? `${t.schema}.${t.name}` : t.name,
    type: "class",
    ...(t.schema ? { detail: t.schema } : {}),
  };
}

function columnOptions(t: SqlTableInfo): SqlCompletionOption[] {
  return t.columns.map((c) => ({
    label: c.name,
    type: "property" as const,
    detail: `${c.type}${c.nullable ? "" : " not null"}`,
  }));
}

/** Every table as an option: the bare name, plus the qualified form for non-default schemas. */
function allTableOptions(schema: SqlSchemaSummary): SqlCompletionOption[] {
  const out: SqlCompletionOption[] = [];
  for (const t of schema.tables) {
    out.push(tableOption(t, false));
    if (!DEFAULT_SCHEMAS.has(t.schema.toLowerCase())) {
      out.push(tableOption(t, true));
    }
  }
  return out;
}

/** First-wins dedupe by label — an alias' columns should outrank the same name from another table. */
function dedupe(options: SqlCompletionOption[]): SqlCompletionOption[] {
  const seen = new Set<string>();
  const out: SqlCompletionOption[] = [];
  for (const o of options) {
    if (seen.has(o.label)) continue;
    seen.add(o.label);
    out.push(o);
  }
  return out;
}

/**
 * Completions for the cursor at the END of `before` (the document text up to the caret).
 *
 * `full` is the WHOLE query when the caller has it, and matters more than it looks: aliases are
 * declared in the FROM clause, which is to the RIGHT of the caret whenever someone goes back to
 * edit their SELECT list. Reading aliases from `before` only would make `SELECT u.|  FROM users u`
 * offer nothing — the single most common place a person actually wants a column name.
 *
 * Returns null when there is nothing useful to offer — an empty schema, or a position that is
 * clearly not an identifier (inside a string literal, say). Never throws: it runs on every
 * keystroke against a half-written query.
 */
export function sqlCompletions(
  schema: SqlSchemaSummary | null | undefined,
  before: string,
  full?: string,
): SqlCompletionResult | null {
  if (!schema || schema.tables.length === 0) return null;
  const statement = full ?? before;

  // Inside a quoted string ('…') there is nothing to complete — an odd number of unescaped single
  // quotes before the caret means we are in one.
  const quotes = (before.match(/'/g) ?? []).length;
  if (quotes % 2 === 1) return null;

  const qualified = before.match(
    new RegExp(`(${IDENT}(?:\\.${IDENT})?)\\.([A-Za-z0-9_$]*)$`),
  );
  if (qualified) {
    const [, ref, word] = qualified;
    const aliases = collectTableAliases(statement);
    const target = aliases[ref.toLowerCase()] ?? ref;
    const table = findTable(schema, target);
    if (table) {
      return {
        from: before.length - word.length,
        options: columnOptions(table),
      };
    }
    // Not a table — maybe it is a SCHEMA, in which case offer its tables (`public.` → users, …).
    const inSchema = schema.tables.filter(
      (t) => t.schema.toLowerCase() === ref.toLowerCase(),
    );
    if (inSchema.length > 0) {
      return {
        from: before.length - word.length,
        options: inSchema.map((t) => tableOption(t, false)),
      };
    }
    return null;
  }

  const wordMatch = before.match(/[A-Za-z0-9_$]*$/);
  const word = wordMatch ? wordMatch[0] : "";
  const from = before.length - word.length;

  // Straight after FROM/JOIN/UPDATE/INTO only a table makes sense.
  if (TABLE_CONTEXT.test(before)) {
    return { from, options: dedupe(allTableOptions(schema)) };
  }

  // Anywhere else: the columns of the tables THIS statement already names come first (that is what
  // a SELECT list or a WHERE clause wants), then every table.
  const aliases = collectTableAliases(statement);
  const inScope = new Set(Object.values(aliases));
  const columns: SqlCompletionOption[] = [];
  for (const ref of inScope) {
    const t = findTable(schema, ref);
    if (t) columns.push(...columnOptions(t));
  }
  const options = dedupe([...columns, ...allTableOptions(schema)]);
  return options.length > 0 ? { from, options } : null;
}

/** One-line summary of an introspection result for the editor's status row. */
export function describeSqlSchema(schema: SqlSchemaSummary): string {
  const tables = schema.tables.length;
  const columns = schema.tables.reduce((n, t) => n + t.columns.length, 0);
  const head = `${tables} table${tables === 1 ? "" : "s"}, ${columns} column${
    columns === 1 ? "" : "s"
  }`;
  return schema.note ? `${head} — ${schema.note}` : head;
}
