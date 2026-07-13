/**
 * The CodeMirror-6 implementation behind <ExpressionField> — imported LAZILY (it pulls in the CM
 * core) so it never weighs on initial load. Two behaviours over a normal input:
 *   1. `{{ … }}` tokens are syntax-highlighted (via @naary/dsl's `templateTokens`, so the colored
 *      spans are EXACTLY what the runtime resolves — no drift).
 *   2. Autocomplete inside `{{ }}`: after `{{ ` → referenceable node ids; after `.` → that node's
 *      keys (from its pinned sample). Tab or Enter accepts; typing `.` re-triggers.
 */
import {
  acceptCompletion,
  type CompletionContext,
  type CompletionResult,
  autocompletion,
  completionKeymap,
} from "@codemirror/autocomplete";
import { RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  keymap,
} from "@codemirror/view";
import { templateTokens } from "@naary/dsl";
import CodeMirror from "@uiw/react-codemirror";
import { useMemo } from "react";
import type { ExpressionRefs } from "../lib/expression-refs";

const exprTokenMark = Decoration.mark({ class: "cm-expr-token" });

/** Color every `{{ path }}` span, rebuilt on each edit (fields are short → whole-doc is cheap). */
function buildDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const doc = view.state.doc.toString();
  for (const t of templateTokens(doc))
    builder.add(t.start, t.end, exprTokenMark);
  return builder.finish();
}

const highlightTokens = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged) this.decorations = buildDecorations(u.view);
    }
  },
  { decorations: (v) => v.decorations },
);

/** Look — matches the app's input styling; only the `{{ }}` token gets a color. */
const exprTheme = EditorView.theme({
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
    fontFamily: "var(--font-sans)",
    caretColor: "var(--ink)",
  },
  ".cm-line": { padding: "0" },
  ".cm-expr-token": { color: "var(--brand)", fontWeight: "600" },
  ".cm-tooltip-autocomplete": {
    background: "var(--card)",
    border: "1px solid var(--line-2)",
    borderRadius: "var(--radius-sm)",
    fontSize: "var(--text-sm)",
  },
});

/** Autocomplete inside an open `{{ … }}`: node ids before the first dot, keys after. */
function exprCompletionSource(refs: ExpressionRefs) {
  return (ctx: CompletionContext): CompletionResult | null => {
    const before = ctx.state.sliceDoc(0, ctx.pos);
    const open = before.lastIndexOf("{{");
    if (open === -1) return null; // not inside a token
    if (before.indexOf("}}", open) !== -1) return null; // token already closed before the cursor
    const inner = before.slice(open + 2).replace(/^\s+/, ""); // "hook.repo" | "h"
    if (!/^[\w.$]*$/.test(inner)) return null; // only simple dotted refs
    const dot = inner.lastIndexOf(".");
    if (dot === -1) {
      // Completing a node id.
      return {
        from: ctx.pos - inner.length,
        options: refs.nodeIds.map((id) => ({ label: id, type: "variable" })),
        validFor: /^[\w$]*$/,
      };
    }
    // Completing a key under the dotted base.
    const base = inner.slice(0, dot);
    const seg = inner.slice(dot + 1);
    return {
      from: ctx.pos - seg.length,
      options: refs.keysAt(base).map((k) => ({ label: k, type: "property" })),
      validFor: /^[\w$]*$/,
    };
  };
}

const basicSetup = {
  lineNumbers: false,
  foldGutter: false,
  highlightActiveLine: false,
  highlightActiveLineGutter: false,
  autocompletion: false, // we add our own (below) so the source is the expression refs
  bracketMatching: false,
} as const;

export interface ExpressionEditorProps {
  value: string;
  onChange: (v: string) => void;
  refs: ExpressionRefs;
  /** Multi-line (textarea-like) vs single-line (input-like, Enter/newlines stripped). */
  multiline?: boolean;
  placeholder?: string;
  /** Min height for the multiline variant (e.g. "7em"). */
  minHeight?: string;
}

export default function ExpressionEditor({
  value,
  onChange,
  refs,
  multiline,
  placeholder,
  minHeight,
}: ExpressionEditorProps) {
  const extensions = useMemo(
    () => [
      highlightTokens,
      exprTheme,
      autocompletion({
        override: [exprCompletionSource(refs)],
        activateOnTyping: true, // re-open as you type, incl. right after "."
        icons: false,
      }),
      // Tab (what the user asked for) AND Enter accept the highlighted completion.
      keymap.of([{ key: "Tab", run: acceptCompletion }, ...completionKeymap]),
      ...(multiline ? [EditorView.lineWrapping] : []),
    ],
    [refs, multiline],
  );

  return (
    <CodeMirror
      value={value}
      onChange={(v) => onChange(multiline ? v : v.replace(/\n/g, ""))}
      extensions={extensions}
      basicSetup={basicSetup}
      placeholder={placeholder}
      minHeight={multiline ? (minHeight ?? "6em") : undefined}
      indentWithTab={false} // Tab is for accepting completions, not indenting
    />
  );
}
