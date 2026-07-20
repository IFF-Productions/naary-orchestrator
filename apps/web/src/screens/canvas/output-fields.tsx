/**
 * Draggable output/input field rows for the inspector dock (redesign: Canvas
 * Authoring Loop). `flattenOutput` turns a node's REAL output (test result or
 * pinned sample) into per-field rows; `FieldRow` renders one as a drag source —
 * dropping it into an expression input in the Parameters section inserts
 * `{{ node.path }}` (the app's existing expression syntax) at the cursor.
 */
import type { CSSProperties, DragEvent } from "react";

export interface OutputFieldRow {
  /** Dotted path from the node output root (e.g. "company.name"). */
  path: string;
  /** Short printable preview of the value. */
  preview: string;
  /** Value type chip: string / number / boolean / null / array(n) / object. */
  type: string;
}

/** Flatten a node output into per-field rows (depth + count capped so a huge
 *  payload doesn't explode the panel). Arrays recurse into their first item. */
export function flattenOutput(
  value: unknown,
  prefix = "",
  depth = 0,
  out: OutputFieldRow[] = [],
  cap = 60,
): OutputFieldRow[] {
  if (out.length >= cap || depth > 4) return out;
  const push = (path: string, v: unknown) => {
    if (out.length >= cap) return;
    if (v === null) out.push({ path, preview: "null", type: "null" });
    else if (Array.isArray(v)) {
      out.push({
        path,
        preview: preview(v),
        type: `array(${v.length})`,
      });
      if (v.length > 0 && depth < 4)
        flattenOutput(v[0], `${path}.0`, depth + 1, out, cap);
    } else if (typeof v === "object") {
      flattenOutput(v, path, depth + 1, out, cap);
    } else {
      out.push({ path, preview: preview(v), type: typeof v });
    }
  };
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const path = prefix ? `${prefix}.${k}` : k;
      push(path, v);
      if (out.length >= cap) break;
    }
  } else if (prefix === "") {
    // Non-object root (a string/number/array output) — one row for the whole value.
    push("output", value);
  }
  return out;
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
