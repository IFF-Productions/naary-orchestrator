/**
 * The SQL box in the sqlQuery / sqlExec inspector, plus the schema status row under it (#1004).
 *
 * A component rather than inline JSX in `config-data.tsx` because it owns a hook (`useSqlSchema`)
 * and that section renders conditionally — a hook there would break the rules of hooks the first
 * time a user selected a non-SQL node.
 *
 * The status row is where "what we could NOT see" is stated out loud: a truncated schema, a
 * credential that can see nothing, or a failed introspection. All three still leave a fully usable
 * editor — introspection is an autocomplete convenience, never a gate on authoring.
 */
import type { CSSProperties } from "react";
import { SqlField } from "../../components/SqlField";
import { describeSqlSchema } from "../../canvas/sql-schema";
import { useSqlSchema } from "../../canvas/use-sql-schema";

const hintStyle: CSSProperties = {
  fontSize: "var(--text-xs)",
  color: "var(--ink-3)",
  marginTop: 4,
  display: "flex",
  gap: 8,
  alignItems: "baseline",
  flexWrap: "wrap",
};

const linkButtonStyle: CSSProperties = {
  background: "none",
  border: "none",
  padding: 0,
  color: "var(--brand)",
  cursor: "pointer",
  font: "inherit",
  textDecoration: "underline",
};

export interface SqlEditorFieldProps {
  value: string;
  onChange: (sql: string) => void;
  /** The node's selected connection. Empty ⇒ nothing to introspect yet. */
  connectionId: string;
  placeholder?: string;
}

export function SqlEditorField({
  value,
  onChange,
  connectionId,
  placeholder,
}: SqlEditorFieldProps) {
  const { schema, loading, error, refresh } = useSqlSchema(connectionId);

  return (
    <>
      <SqlField
        value={value}
        onChange={onChange}
        schema={schema}
        placeholder={placeholder}
        minHeight="7em"
      />
      <div style={hintStyle}>
        {!connectionId && (
          <span>Pick a connection to autocomplete tables and columns.</span>
        )}
        {connectionId && loading && <span>Reading the database schema…</span>}
        {connectionId && !loading && error && (
          // Deliberately a hint, not an error banner: the field still works.
          <span>Schema autocomplete unavailable — {error}</span>
        )}
        {connectionId && !loading && !error && schema && (
          <span>
            Autocomplete: {describeSqlSchema(schema)}
            {schema.truncated ? "" : "."} Press Ctrl-Space for suggestions.
          </span>
        )}
        {connectionId && !loading && (
          <button type="button" onClick={refresh} style={linkButtonStyle}>
            Refresh schema
          </button>
        )}
      </div>
    </>
  );
}
