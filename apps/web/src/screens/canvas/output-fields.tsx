/**
 * Draggable output/input field rows for the inspector dock (redesign: Canvas
 * Authoring Loop). `flattenOutput` turns a node's REAL output (test result or
 * pinned sample) into per-field rows; `FieldRow` renders one as a drag source —
 * dropping it into an expression input in the Parameters section inserts
 * `{{ node.path }}` (the app's existing expression syntax) at the cursor.
 *
 * This is the SINGLE path enumerator for the inspector: INPUT DATA / the OUTPUT
 * tab render the rows, and the Parameters "References" chips (`leafPaths`) are a
 * projection of the same rows onto their `path`. They used to be two walks —
 * INPUT DATA descended into `arr[0]`, the chips treated an array as a leaf — so
 * the panel whose job is to hand you a working path could not produce the one the
 * panel beside it was displaying (a user wiring PagerDuty needed
 * `{{ n.body.incidents.0.id }}` and only got `{{ n.body.incidents }}`). Keeping
 * one walk means they cannot drift apart again.
 */
import { isPollutingKey } from "@naary/dsl";
import type { CSSProperties, DragEvent } from "react";

export interface OutputFieldRow {
  /** Dotted path from the node output root (e.g. "company.name"). */
  path: string;
  /** Short printable preview of the value. */
  preview: string;
  /** Value type chip: string / number / boolean / null / array(n) / object. */
  type: string;
}

/** Deepest nesting level walked. Bounds the work on a deeply nested payload. */
const MAX_DEPTH = 4;

/**
 * Flatten a node output into per-field rows (depth + count capped so a huge
 * payload doesn't explode the panel).
 *
 * Arrays emit BOTH a row for the array itself (binding a whole array is
 * legitimate — forEach/splitOut take one) and rows for **index 0 only**:
 * `incidents`, `incidents.0`, `incidents.0.id`. Index 0 and no further, because
 * (a) a 500-element array must not become 500 suggestions, and (b) elements are
 * homogeneous in practice, so index 1..n would repeat index 0's shape with a
 * different number — the author retypes the index, they don't need it offered.
 * The overwhelmingly common authoring case is "the first (often only) item".
 *
 * Paths are DOTTED (`a.0.b`), not bracketed (`a[0].b`). Both resolve — see
 * `getByPath` — but the dotted form takes its documented no-bracket fast path,
 * whereas one `[` forces the whole path through the bracket grammar or it
 * resolves to undefined. Dotted also keeps every surface emitting the identical
 * string.
 *
 * `rootKey` names the synthetic row used when the ROOT value isn't a plain object
 * (a node whose whole output is a string/array). INPUT DATA keeps its "output"
 * label; pass `null` to suppress it — a caller that emits copy-paste-able
 * expressions must not invent a path segment that isn't in the data.
 */
export function flattenOutput(
  value: unknown,
  prefix = "",
  depth = 0,
  out: OutputFieldRow[] = [],
  cap = 60,
  rootKey: string | null = "output",
): OutputFieldRow[] {
  if (out.length >= cap || depth > MAX_DEPTH) return out;
  const push = (path: string, v: unknown, d: number) => {
    if (out.length >= cap || d > MAX_DEPTH) return;
    if (v === null) out.push({ path, preview: "null", type: "null" });
    else if (Array.isArray(v)) {
      out.push({
        path,
        preview: preview(v),
        type: `array(${v.length})`,
      });
      // Index 0 only (see the doc comment). Routed through `push`, not a direct
      // recursion, so an array of SCALARS or an array of arrays enumerates its
      // first element too — not just an array of objects.
      if (v.length > 0) push(`${path}.0`, v[0], d + 1);
    } else if (typeof v === "object") {
      // At the depth budget, emit the object AS a row rather than dropping it: a truncated
      // but real path (`a.b.c.d.e`) is a usable binding, whereas descending would exceed the
      // bound and silently offer nothing at all for a deep payload.
      if (d + 1 > MAX_DEPTH)
        out.push({ path, preview: preview(v), type: "object" });
      else flattenOutput(v, path, d + 1, out, cap, rootKey);
    } else {
      out.push({ path, preview: preview(v), type: typeof v });
    }
  };
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // `JSON.parse` can make `__proto__`/`constructor` an OWN key of a pinned
      // sample; the runtime refuses such a path, so never suggest one.
      if (isPollutingKey(k)) continue;
      const path = prefix ? `${prefix}.${k}` : k;
      push(path, v, depth);
      if (out.length >= cap) break;
    }
  } else if (prefix === "" && rootKey !== null) {
    // Non-object root (a string/number/array output) — one row for the whole value.
    push(rootKey, value, depth);
  }
  return out;
}

/**
 * Dotted paths offered by the Parameters "References" chips — `flattenOutput`
 * projected onto its `path`, so the chips and the INPUT DATA rows beside them are
 * the same set by construction.
 *
 * Capped tighter than the dock's row list (chips wrap inline, rows scroll), and
 * with `rootKey: null`: a node whose entire output is an array/string has no
 * dotted path at all, and the References block already falls back to a bare
 * `{{ node }}` chip when this returns nothing.
 */
export function leafPaths(value: unknown, cap = 24): string[] {
  return flattenOutput(value, "", 0, [], cap, null).map((r) => r.path);
}

function preview(v: unknown): string {
  let s: string;
  try {
    s = JSON.stringify(v) ?? String(v);
  } catch {
    s = String(v);
  }
  return s.length > 120 ? `${s.slice(0, 117)}…` : s;
}

/** Begin dragging an expression token; canvas.css highlights eligible drop targets
 *  (expression inputs) while `naary-dragging` is on the body. */
export function startFieldDrag(e: DragEvent, token: string): void {
  e.dataTransfer.effectAllowed = "copy";
  e.dataTransfer.setData("text/plain", token);
  document.body.classList.add("naary-dragging");
}
export function endFieldDrag(): void {
  document.body.classList.remove("naary-dragging");
}

const grip = (
  <svg
    width="10"
    height="10"
    viewBox="0 0 24 24"
    fill="var(--ink-3)"
    style={{ flex: "none", marginTop: 3 }}
    aria-hidden
  >
    <circle cx="7" cy="6" r="1.6" />
    <circle cx="7" cy="12" r="1.6" />
    <circle cx="7" cy="18" r="1.6" />
    <circle cx="14" cy="6" r="1.6" />
    <circle cx="14" cy="12" r="1.6" />
    <circle cx="14" cy="18" r="1.6" />
  </svg>
);

const mono: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-xs)",
};

/**
 * One draggable field row. `variant`:
 *  - "input"  — INPUT DATA rows: grip dots · mono path · value preview · source tag chip
 *  - "output" — OUTPUT card rows: green mono path · value (per the design comp)
 */
export function FieldRow({
  token,
  path,
  valuePreview,
  typeChip,
  tag,
  variant,
}: {
  /** The `{{ node.path }}` expression inserted on drop. */
  token: string;
  path: string;
  valuePreview: string;
  typeChip?: string;
  /** Source tag chip (the upstream node's name, or "pinned"). */
  tag?: string;
  variant: "input" | "output";
}) {
  return (
    <div
      draggable
      onDragStart={(e) => startFieldDrag(e, token)}
      onDragEnd={endFieldDrag}
      className="naary-output-row"
      title={`Drag into a parameter to insert ${token}`}
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: variant === "input" ? 10 : 9,
        borderRadius: 7,
        padding: variant === "input" ? "8px 11px" : "7px 9px",
        cursor: "grab",
        border: variant === "input" ? "1px solid var(--line-mid)" : undefined,
        background: variant === "input" ? "var(--card-2)" : undefined,
      }}
    >
      {variant === "input" && grip}
      <span
        className="mono"
        style={{
          ...mono,
          color: variant === "output" ? "var(--state-done)" : "var(--ink-soft)",
          flex: "none",
          minWidth: variant === "output" ? 88 : undefined,
          maxWidth: 150,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {path}
      </span>
      <span
        className="mono"
        style={{
          ...mono,
          color: variant === "output" ? "var(--ink-soft)" : "var(--ink-faint)",
          lineHeight: 1.5,
          flex: 1,
          minWidth: 0,
          wordBreak: "break-word",
          ...(variant === "input"
            ? {
                textAlign: "right" as const,
                whiteSpace: "nowrap" as const,
                overflow: "hidden",
                textOverflow: "ellipsis",
                wordBreak: "normal" as const,
              }
            : {}),
        }}
      >
        {valuePreview}
      </span>
      {typeChip && (
        <span
          className="mono"
          style={{
            fontSize: 9,
            color: "var(--ink-3)",
            border: "1px solid var(--line-2)",
            borderRadius: 5,
            padding: "1px 5px",
            flex: "none",
          }}
        >
          {typeChip}
        </span>
      )}
      {tag && (
        <span
          style={{
            fontSize: 9.5,
            color: "var(--ink-3)",
            border: "1px solid var(--line-2)",
            borderRadius: 5,
            padding: "2px 6px",
            flex: "none",
            maxWidth: 92,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {tag}
        </span>
      )}
    </div>
  );
}
