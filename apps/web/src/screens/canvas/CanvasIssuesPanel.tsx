// Canvas issues panel: the collapsible list of lint warnings + missing resources shown
// under the top bar; click a row to jump to its node (extracted verbatim from CanvasPage).

/** One flat, displayable canvas issue — an unknown-source reference or a missing resource. */
export interface CanvasIssue {
  nodeId: string;
  field: string | undefined;
  ref: string | undefined;
  message: string;
  kind: "reference" | "resource";
}

export function CanvasIssuesPanel({
  issues,
  onSelectNode,
}: {
  issues: CanvasIssue[];
  onSelectNode: (id: string) => void;
}) {
  return (
    <div
      style={{
        padding: "10px 16px",
        borderBottom: "1px solid var(--line)",
        background: "var(--surface)",
        maxHeight: 220,
        overflowY: "auto",
      }}
    >
      <div
        style={{
          fontSize: "var(--text-xs)",
          color: "var(--ink-3)",
          marginBottom: 8,
        }}
      >
        {issues.length} issue{issues.length > 1 ? "s" : ""} — click one to jump
        to its node. References point at a source that doesn't exist; resources
        are unmatched connections/config.
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {issues.map((it, i) => (
          <button
            type="button"
            key={`${it.nodeId}.${it.field ?? ""}.${i}`}
            onClick={() => onSelectNode(it.nodeId)}
            style={{
              display: "flex",
              alignItems: "baseline",
              flexWrap: "wrap",
              gap: 6,
              textAlign: "left",
              width: "100%",
              padding: "6px 8px",
              border: "1px solid var(--line)",
              borderRadius: "var(--radius-sm)",
              background: "var(--card)",
              color: "var(--ink)",
              fontSize: "var(--text-body)",
              cursor: "pointer",
            }}
          >
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: "50%",
                flex: "none",
                alignSelf: "center",
                background:
                  it.kind === "resource"
                    ? "var(--state-error)"
                    : "var(--state-paused)",
              }}
            />
            <span
              className="mono"
              style={{ fontWeight: "var(--weight-semibold)" }}
            >
              {it.nodeId}
            </span>
            {it.field && (
              <span className="mono" style={{ color: "var(--ink-2)" }}>
                · {it.field}
              </span>
            )}
            <span style={{ color: "var(--ink-1)" }}>— {it.message}</span>
            {it.ref && (
              <span className="mono" style={{ color: "var(--ink-3)" }}>
                ({it.ref})
              </span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
