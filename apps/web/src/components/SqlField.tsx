/**
 * The `sql` field of a sqlQuery / sqlExec node: a SQL box that autocompletes table and column names
 * from the connection's introspected schema (#1004).
 *
 * The heavy CodeMirror editor is loaded LAZILY; while it loads (Suspense) or if the chunk fails
 * (ErrorBoundary) this renders the plain textarea the field used to be, bound to the same value —
 * so authoring never breaks and never loses data. Same contract as <ExpressionField>.
 *
 * Autocomplete is strictly additive: a schema that is still loading, failed to load, or is empty
 * (a credential that can see nothing) leaves a perfectly usable editor. Introspection must never
 * block authoring.
 */
import {
  type CSSProperties,
  Component,
  type ReactNode,
  Suspense,
  lazy,
} from "react";
import type { SqlSchemaSummary } from "@naary/dsl";

const SqlEditor = lazy(() => import("./SqlEditor"));

/** Renders `fallback` if a child throws — here, a failed CodeMirror chunk load. */
class EditorErrorBoundary extends Component<
  { fallback: ReactNode; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

const fallbackStyle: CSSProperties = {
  width: "100%",
  padding: "7px 9px",
  borderRadius: "var(--radius-sm)",
  border: "1px solid var(--line-2)",
  background: "var(--card)",
  color: "var(--ink)",
  fontSize: "var(--text-body)",
  fontFamily: "var(--font-mono, monospace)",
  resize: "vertical",
};

export interface SqlFieldProps {
  value: string;
  onChange: (v: string) => void;
  schema: SqlSchemaSummary | null;
  placeholder?: string;
  minHeight?: string;
}

export function SqlField({
  value,
  onChange,
  schema,
  placeholder,
  minHeight,
}: SqlFieldProps) {
  const fallback = (
    <textarea
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      rows={5}
      style={{ ...fallbackStyle, minHeight }}
    />
  );
  return (
    <EditorErrorBoundary fallback={fallback}>
      <Suspense fallback={fallback}>
        <SqlEditor
          value={value}
          onChange={onChange}
          schema={schema}
          placeholder={placeholder}
          minHeight={minHeight}
        />
      </Suspense>
    </EditorErrorBoundary>
  );
}
