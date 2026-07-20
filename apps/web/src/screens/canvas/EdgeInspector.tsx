/**
 * Edge ("Connection") inspector — overlays the inspector dock (absolute inset,
 * z-6, per the design comp) when a canvas edge is selected. Wires the comp's
 * layout to the REAL edge capabilities: the branch-condition editor
 * (EdgeConfigPanel) and edge deletion (red confirm card).
 */
import { Icon } from "../../components";
import type { EdgeConditionDraft } from "../../lib/graph-model";
import { EdgeConfigPanel } from "./EdgeConfigPanel";

export function EdgeInspector({
  sourceLabel,
  targetLabel,
  condition,
  onChange,
  onClear,
  onDelete,
  onClose,
}: {
  sourceLabel: string;
  targetLabel: string;
  condition?: EdgeConditionDraft;
  onChange: (patch: Partial<EdgeConditionDraft>) => void;
  onClear: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const hasCondition = Boolean(condition?.path?.trim());
  return (
    <div
      role="region"
      aria-label="Connection"
      style={{
        position: "absolute",
        inset: 0,
        minHeight: "100%",
        zIndex: 6,
        background: "var(--panel)",
        display: "flex",
        flexDirection: "column",
        overflowY: "auto",
      }}
    >
      {/* header */}
      <div
        style={{
          padding: "16px 20px",
          borderBottom: "1px solid var(--line)",
          display: "flex",
          alignItems: "center",
          gap: 11,
          flex: "none",
        }}
      >
        <span
          style={{
            width: 34,
            height: 34,
            flex: "none",
            borderRadius: 9,
            border: "1px solid var(--brand)",
            color: "var(--brand)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden
          >
            <path
              d="M5 12h14M13 6l6 6-6 6"
              stroke="currentColor"
              strokeWidth="1.9"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 14.5,
              fontWeight: "var(--weight-bold)",
              color: "var(--ink)",
            }}
          >
            Connection
          </div>
          <div
            className="mono"
            style={{
              fontSize: "var(--text-2xs)",
              color: "var(--ink-faint)",
              marginTop: 1,
            }}
          >
            edge
          </div>
        </div>
        <button
          type="button"
          aria-label="Close connection inspector"
          onClick={onClose}
          style={{
            width: 32,
            height: 32,
            flex: "none",
            borderRadius: 8,
            border: "1px solid var(--line-2)",
            background: "var(--card)",
            color: "var(--ink-2)",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Icon name="x" size={14} />
        </button>
      </div>

      <div
        style={{
          padding: "18px 20px",
          display: "flex",
          flexDirection: "column",
          gap: 16,
        }}
      >
        {/* edge title card */}
        <div
          style={{
            border: "1px solid var(--line-mid)",
            background: "var(--card)",
            borderRadius: 11,
            padding: 14,
            fontSize: "var(--text-body)",
            fontWeight: "var(--weight-semibold)",
            textAlign: "center",
            overflowWrap: "anywhere",
          }}
        >
          {sourceLabel}
          <span style={{ color: "var(--ink-3)", padding: "0 10px" }}>→</span>
          {targetLabel}
        </div>

        {/* condition — the REAL branch-condition editor */}
        <div>
          <div
            className="mono"
            style={{
              fontSize: "var(--text-2xs)",
              letterSpacing: "0.1em",
              textTransform: "uppercase",
              color: "var(--ink-faint)",
              fontWeight: "var(--weight-semibold)",
              marginBottom: 7,
            }}
          >
            Condition
          </div>
          <div
            style={{
              border: "1px solid var(--line-2)",
              background: "var(--card)",
              borderRadius: 9,
              padding: "11px 13px",
            }}
          >
            <EdgeConfigPanel
              condition={condition}
              onChange={onChange}
              onClear={onClear}
              hideHeader
            />
          </div>
          <div
            style={{
              fontSize: "var(--text-xs)",
              color: "var(--ink-faint)",
              marginTop: 7,
              lineHeight: 1.5,
            }}
          >
            {hasCondition
              ? "This edge only fires when the condition matches. Editing it changes which branch a run takes."
              : "always (unconditional) — set a path to make this edge a branch."}
          </div>
        </div>

        {/* delete-edge confirm card */}
        <div
          style={{
            border:
              "1px solid color-mix(in srgb, var(--state-error) 45%, transparent)",
            background:
              "var(--error-soft, color-mix(in srgb, var(--state-error) 7%, var(--card)))",
            borderRadius: 11,
            padding: 14,
          }}
        >
          <div
            style={{
              fontSize: "var(--text-sm)",
              fontWeight: "var(--weight-semibold)",
              color: "var(--state-error)",
              marginBottom: 5,
            }}
          >
            Delete this connection?
          </div>
          <div
            style={{
              fontSize: "var(--text-xs)",
              color: "var(--ink-2)",
              lineHeight: 1.5,
              marginBottom: 11,
            }}
          >
            The downstream node loses its input and can't run until you connect
            a new edge into it.
          </div>
          <button
            type="button"
            onClick={onDelete}
            style={{
              height: 36,
              padding: "0 15px",
              borderRadius: 9,
              border:
                "1px solid color-mix(in srgb, var(--state-error) 45%, transparent)",
              background: "transparent",
              color: "var(--state-error)",
              fontSize: "var(--text-sm)",
              fontWeight: "var(--weight-semibold)",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: 7,
            }}
          >
            <Icon name="trash" size={13} />
            Delete edge
          </button>
        </div>

        <div
          style={{
            fontSize: "var(--text-xs)",
            color: "var(--ink-faint)",
            lineHeight: 1.5,
          }}
        >
          Tip: click any connection line on the canvas to inspect or remove it.
        </div>
      </div>
    </div>
  );
}
