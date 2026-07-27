// Canvas issues panel: the collapsible list of lint warnings + missing resources shown
// under the top bar; click a row to jump to its node (extracted verbatim from CanvasPage).

/**
 * One flat, displayable canvas issue — an unknown-source reference, a missing resource, or (#832)
 * a failed dry-run check.
 */
export interface CanvasIssue {
  nodeId: string;
  field: string | undefined;
  ref: string | undefined;
  message: string;
  kind: "reference" | "resource" | "check";
}

export function CanvasIssuesPanel({
  issues,
  note,
  onSelectNode,
}: {
  issues: CanvasIssue[];
  /** Dry-run summary — notably what could NOT be checked. Shown even when there are no issues. */
  note?: string | null;
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
      {note && (
        // The dry-run summary, and the only place the user learns what was NOT verified. Kept
        // visible alongside the rows so "2 issues" is never read as "and everything else is fine".
        <div
          style={{
            fontSize: "var(--text-xs)",
            color: "var(--ink-2)",
            marginBottom: 8,
            padding: "6px 8px",
            border: "1px solid var(--line)",
            borderRadius: "var(--radius-sm)",
            background: "var(--card)",
          }}
        >
          {note}
        </div>
      )}
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
                // A failed dry-run check is a hard error like a missing resource: it is a thing
                // the provider or the catalog already rejected, not a heuristic warning.
                background:
                  it.kind === "reference"
                    ? "var(--state-paused)"
                    : "var(--state-error)",
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
