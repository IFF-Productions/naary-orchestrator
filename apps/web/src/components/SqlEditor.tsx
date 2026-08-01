/**
 * The CodeMirror-6 implementation behind <SqlField> — imported LAZILY (it pulls in the CM core) so
 * it never weighs on initial load. Same shape as ExpressionEditor, deliberately: this reuses the
 * CodeMirror that is already a dependency, so schema autocomplete costs no new package.
 *
 * It is NOT ExpressionField, because a SQL node's text has no `{{ }}` semantics — bindings fill
 * positional params and the SQL string is passed to the driver verbatim (see
 * packages/dsl/src/sql-query.ts). Highlighting `{{ }}` here would advertise a feature that does not
 * exist and invite someone to build a query by string interpolation, which is the injection we
 * designed out.
 */
import {
  acceptCompletion,
  autocompletion,
  completionKeymap,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import { EditorView, keymap } from "@codemirror/view";
import type { SqlSchemaSummary } from "@naary/dsl";
import CodeMirror from "@uiw/react-codemirror";
import { useMemo } from "react";
import { sqlCompletions } from "../canvas/sql-schema";

/** Look — matches ExpressionEditor's, which matches the app's inputs (incl. the caret fix). */
const sqlTheme = EditorView.theme({
  "&": {
    fontSize: "var(--text-body)",
    border: "1px solid var(--line-2)",
    borderRadius: "var(--radius-sm)",
    background: "var(--card)",
    color: "var(--ink)",
  },
  "&.cm-focused": { outline: "none", borderColor: "var(--brand)" },
  ".cm-content": {
    padding: "7px 9px",
    fontFamily: "var(--font-mono, monospace)",
    caretColor: "var(--ink)",
  },
  ".cm-line": { padding: "0" },
  // drawSelection hides the native caret and draws `.cm-cursor` instead — without an explicit
  // colour it renders black, i.e. invisible in dark mode. (Same bug fixed in ExpressionEditor.)
  ".cm-cursor, .cm-dropCursor": {
    borderLeftColor: "var(--ink)",
    borderLeftWidth: "2px",
  },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
    background: "color-mix(in srgb, var(--brand) 26%, transparent)",
  },
  ".cm-tooltip-autocomplete": {
    background: "var(--card)",
    border: "1px solid var(--line-2)",
    borderRadius: "var(--radius-sm)",
    fontSize: "var(--text-sm)",
  },
});

/** Adapt the pure completion logic to CodeMirror. All the interesting behaviour is in
 *  `sqlCompletions`, which is unit-tested without an editor. */
function completionSource(schema: SqlSchemaSummary | null) {
  return (ctx: CompletionContext): CompletionResult | null => {
    const before = ctx.state.sliceDoc(0, ctx.pos);
    // The WHOLE document too: aliases live in the FROM clause, which is to the right of the caret
    // whenever someone goes back to edit their SELECT list.
    const result = sqlCompletions(schema, before, ctx.state.doc.toString());
    if (!result || result.options.length === 0) return null;
    return {
      from: result.from,
      options: result.options,
      // Re-filter in place while the user keeps typing word characters instead of re-querying.
      validFor: /^[\w$]*$/,
    };
  };
}

const basicSetup = {
  lineNumbers: false,
  foldGutter: false,
  highlightActiveLine: false,
  highlightActiveLineGutter: false,
  autocompletion: false, // ours (below) is driven by the introspected schema
  bracketMatching: false,
} as const;

export interface SqlEditorProps {
  value: string;
  onChange: (v: string) => void;
  /** The introspected schema, or null while it loads / when introspection failed. Autocomplete is
   *  simply absent in that case — never an error, never a blocked field. */
  schema: SqlSchemaSummary | null;
  placeholder?: string;
  minHeight?: string;
}

export default function SqlEditor({
  value,
  onChange,
  schema,
  placeholder,
  minHeight,
}: SqlEditorProps) {
  const extensions = useMemo(
    () => [
      sqlTheme,
      autocompletion({
        override: [completionSource(schema)],
        activateOnTyping: true,
        icons: false,
      }),
      keymap.of([{ key: "Tab", run: acceptCompletion }, ...completionKeymap]),
      EditorView.lineWrapping,
    ],
    [schema],
  );

  return (
    <CodeMirror
      value={value}
      onChange={onChange}
      extensions={extensions}
      basicSetup={basicSetup}
      // theme="none" disables @uiw's built-in LIGHT theme, which would otherwise win and make the
      // field unreadable in dark mode; sqlTheme drives the look via theme-aware CSS vars.
      theme="none"
      placeholder={placeholder}
      minHeight={minHeight ?? "7em"}
      indentWithTab={false} // Tab accepts a completion
    />
  );
}
