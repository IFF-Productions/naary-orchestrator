/**
 * Output inspector (redesign: Canvas Authoring Loop): a floating side drawer over
 * the canvas (absolute overlay — never pushes canvas content) that shows the
 * selected node's REAL output — the last single-node test result, or the pinned
 * authoring sample. Per-field rows (name · value · type) are draggable: dropping
 * one into an expression input in the config panel inserts `{{ node.path }}`
 * (the app's existing expression syntax) at the cursor.
 */
import type { CSSProperties, DragEvent } from "react";
import { Icon } from "../../components/Icon";

export interface OutputFieldRow {
  /** Dotted path from the node output root (e.g. "company.name"). */
  path: string;
  /** Short printable preview of the value. */
  preview: string;
  /** Value type chip: string / number / boolean / null / array(n) / object. */
  type: string;
}

/** Flatten a node output into per-field rows (depth + count capped so a huge
 *  payload doesn't explode the drawer). Arrays recurse into their first item. */
export function flattenOutput(
  value: unknown,
  prefix = "",
  depth = 0,
  out: OutputFieldRow[] = [],
): OutputFieldRow[] {
  if (out.length >= 60 || depth > 4) return out;
  const push = (path: string, v: unknown) => {
    if (out.length >= 60) return;
    if (v === null) out.push({ path, preview: "null", type: "null" });
    else if (Array.isArray(v)) {
      out.push({
        path,
        preview: preview(v),
        type: `array(${v.length})`,
      });
      if (v.length > 0 && depth < 4)
        flattenOutput(v[0], `${path}.0`, depth + 1, out);
    } else if (typeof v === "object") {
      flattenOutput(v, path, depth + 1, out);
    } else {
      out.push({ path, preview: preview(v), type: typeof v });
    }
  };
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const path = prefix ? `${prefix}.${k}` : k;
      push(path, v);
      if (out.length >= 60) break;
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

const monoLabel: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-2xs)",
  fontWeight: "var(--weight-semibold)",
  letterSpacing: "var(--tracking-label)",
  textTransform: "uppercase",
};

export function OutputInspector({
  nodeId,
  title,
  output,
  source,
  runMs,
  stale,
  canPin,
  isPinned,
  onPin,
  onClose,
}: {
  nodeId: string;
  title: string;
  output: unknown;
  /** Where this output came from — a test run or the pinned authoring sample. */
  source: "test" | "pin";
  /** Measured wall-clock of the test call (client-side; omitted when unknown). */
  runMs?: number;
  /** Upstream/config changed since this output was produced. */
  stale?: boolean;
  canPin?: boolean;
  isPinned?: boolean;
  onPin?: () => void;
  onClose: () => void;
}) {
  const rows = flattenOutput(output);

  const startDrag = (e: DragEvent, path: string) => {
    const token = `{{ ${nodeId}.${path} }}`;
    e.dataTransfer.effectAllowed = "copy";
    e.dataTransfer.setData("text/plain", token);
    // Global flag → canvas.css highlights eligible expression inputs while dragging.
    document.body.classList.add("naary-dragging");
  };
  const endDrag = () => document.body.classList.remove("naary-dragging");

  return (
    <aside
      aria-label={`Output of ${title}`}
      className="naary-output-drawer"
      style={{
        position: "absolute",
        // Bottom-right, content-sized: a full-height overlay would block clicking
        // the nodes beneath it (the drag-to-map loop needs the canvas usable).
        right: 14,
        bottom: 14,
        maxHeight: "min(520px, calc(100% - 72px))",
        width: 336,
        maxWidth: "calc(100% - 28px)",
        zIndex: 6,
        display: "flex",
        flexDirection: "column",
        borderRadius: 12,
        border: "1px solid var(--line-mid)",
        background: "var(--panel)",
        boxShadow: "var(--shadow-raised)",
        overflow: "hidden",
        animation: "naaryFadeUp .28s ease both",
      }}
    >
      {/* header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 9,
          padding: "11px 14px",
          borderBottom: "1px solid var(--line)",
          background:
            source === "test" && !stale
              ? "color-mix(in srgb, var(--state-done) 6%, var(--panel))"
              : "var(--panel)",
          flex: "none",
        }}
      >
        <span
          aria-hidden
          style={{
            width: 15,
            height: 15,
            borderRadius: "50%",
            flex: "none",
            background: stale ? "var(--state-paused)" : "var(--state-done)",
            color: "#04120b",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Icon name="check" size={9} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: "var(--text-sm)",
              fontWeight: "var(--weight-semibold)",
              color: stale ? "var(--state-paused)" : "var(--state-done)",
            }}
          >
            {source === "pin" ? "Pinned sample" : "Output ready"}
          </div>
          <div
            className="mono"
            style={{
              fontSize: "var(--text-2xs)",
              color: "var(--ink-3)",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {title}
          </div>
        </div>
        {runMs !== undefined && (
          <span
            className="mono"
            style={{
              fontSize: "var(--text-xs)",
              color: "var(--ink-3)",
              flex: "none",
            }}
          >
            {runMs < 1000 ? `${runMs}ms` : `${(runMs / 1000).toFixed(2)}s`}
          </span>
        )}
        <button
          type="button"
          aria-label="Close output inspector"
          onClick={onClose}
          style={{
            width: 26,
            height: 26,
            flex: "none",
            borderRadius: 7,
            border: "1px solid var(--line-2)",
            background: "var(--card)",
            color: "var(--ink-2)",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 0,
          }}
        >
          <Icon name="x" size={12} />
        </button>
      </div>

      {stale && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 7,
            padding: "8px 14px",
            fontSize: "var(--text-xs)",
            color: "var(--state-paused)",
            background: "var(--paused-soft)",
            borderBottom: "1px solid var(--line)",
            flex: "none",
          }}
        >
          <Icon name="alert" size={12} />
          Inputs changed — re-run this step to refresh its output.
        </div>
      )}

      {/* field rows */}
      <div
        style={{
          flex: "0 1 auto",
          minHeight: 0,
          overflowY: "auto",
          padding: 6,
        }}
      >
        {rows.length === 0 ? (
          <div
            style={{
              padding: "18px 12px",
              fontSize: "var(--text-sm)",
              color: "var(--ink-3)",
              textAlign: "center",
            }}
          >
            Empty output.
          </div>
        ) : (
          rows.map((f) => (
            <div
              key={f.path}
              draggable
              onDragStart={(e) => startDrag(e, f.path)}
              onDragEnd={endDrag}
              className="naary-output-row"
              title={`Drag into a field to insert {{ ${nodeId}.${f.path} }}`}
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 8,
                borderRadius: 7,
                padding: "7px 8px",
                cursor: "grab",
              }}
            >
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
              <span
                className="mono"
                style={{
                  fontSize: "var(--text-xs)",
                  color: "var(--state-done)",
                  flex: "none",
                  minWidth: 86,
                  maxWidth: 140,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {f.path}
              </span>
              <span
                className="mono"
                style={{
                  fontSize: "var(--text-xs)",
                  color: "var(--ink-soft)",
                  lineHeight: 1.5,
                  flex: 1,
                  minWidth: 0,
                  wordBreak: "break-word",
                }}
              >
                {f.preview}
              </span>
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
                {f.type}
              </span>
            </div>
          ))
        )}
      </div>

      {/* footer */}
      <div
        style={{
          padding: "8px 14px",
          borderTop: "1px solid var(--line)",
          display: "flex",
          alignItems: "center",
          gap: 8,
          flex: "none",
        }}
      >
        <span
          style={{
            fontSize: "var(--text-2xs)",
            color: "var(--ink-3)",
            flex: 1,
            lineHeight: 1.4,
          }}
        >
          Drag any field into a downstream node's parameters.
        </span>
        {source === "test" && canPin && !isPinned && onPin && (
          <button
            type="button"
            onClick={onPin}
            style={{
              ...monoLabel,
              flex: "none",
              padding: "4px 9px",
              borderRadius: 7,
              border: "1px solid var(--line-2)",
              background: "var(--card)",
              color: "var(--ink-2)",
              cursor: "pointer",
            }}
          >
            Pin output
          </button>
        )}
      </div>
    </aside>
  );
}
