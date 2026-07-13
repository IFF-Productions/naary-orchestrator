/**
 * A config field that understands `{{ node.path }}` expressions: syntax-highlighted + autocompleted
 * (see ExpressionEditor). The heavy CodeMirror editor is loaded LAZILY; while it loads (Suspense) OR
 * if the chunk fails to load (ErrorBoundary) this renders a plain, fully-functional input/textarea
 * bound to the same value, so authoring never breaks or loses data.
 */
import {
  type CSSProperties,
  Component,
  type ReactNode,
  Suspense,
  lazy,
  useMemo,
} from "react";
import {
  type ExpressionRefs,
  type RefEdge,
  buildExpressionRefs,
} from "../lib/expression-refs";

const ExpressionEditor = lazy(() => import("./ExpressionEditor"));

const fieldStyle: CSSProperties = {
  width: "100%",
  padding: "7px 9px",
  borderRadius: "var(--radius-sm)",
  border: "1px solid var(--line-2)",
  background: "var(--card)",
  color: "var(--ink)",
  fontSize: "var(--text-body)",
  fontFamily: "var(--font-sans)",
};

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

export interface ExpressionFieldProps {
  value: string;
  onChange: (v: string) => void;
  /** This node's id — its ancestors become the referenceable `{{ node }}` set. */
  nodeId: string;
  /** Canvas edges (source → target) — for computing ancestors. */
  edges: RefEdge[];
  /** Pinned sample outputs per node — the source for `.`-path autocomplete. */
  pins: Record<string, unknown>;
  /** node id → kind, for the static output-shape autocomplete fallback (unpinned nodes). */
  nodeKinds?: Record<string, string>;
  multiline?: boolean;
  placeholder?: string;
  minHeight?: string;
}

export function ExpressionField({
  value,
  onChange,
  nodeId,
  edges,
  pins,
  nodeKinds,
  multiline,
  placeholder,
  minHeight,
}: ExpressionFieldProps) {
  // Memoized so keystrokes (value changes) don't rebuild refs → don't churn the CodeMirror
  // `extensions` memo (which is keyed on refs identity) on every character typed.
  const refs: ExpressionRefs = useMemo(
    () => buildExpressionRefs(nodeId, edges, pins, nodeKinds),
    [nodeId, edges, pins, nodeKinds],
  );

  const fallback = multiline ? (
    <textarea
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      rows={5}
      style={{ ...fieldStyle, resize: "vertical", minHeight }}
    />
  ) : (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      style={fieldStyle}
    />
  );

  return (
    <EditorErrorBoundary fallback={fallback}>
      <Suspense fallback={fallback}>
        <ExpressionEditor
          value={value}
          onChange={onChange}
          refs={refs}
          multiline={multiline}
          placeholder={placeholder}
          minHeight={minHeight}
        />
      </Suspense>
    </EditorErrorBoundary>
  );
}
