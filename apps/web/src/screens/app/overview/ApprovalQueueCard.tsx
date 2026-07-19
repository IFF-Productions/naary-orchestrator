/**
 * "Top of the approval queue" — the first few runs paused for a human, with the
 * approval prompt title, workflow, a waiting-age chip (tone by age), and
 * decide-in-place Approve + View. Data: GET /executions/awaiting.
 */
import { useNavigate } from "react-router-dom";
import { Link } from "react-router-dom";
import { Icon } from "../../../components";
import type { AwaitingApproval } from "../../../lib/api";
import { ageMs, ageTone, formatAge } from "./overview-model";

const TONE_CHIP = {
  bad: {
    color: "var(--state-error)",
    border: "color-mix(in srgb, var(--state-error) 50%, var(--line))",
    bg: "var(--error-soft)",
  },
  warn: {
    color: "var(--state-paused)",
    border: "color-mix(in srgb, var(--state-paused) 50%, var(--line))",
    bg: "var(--paused-soft)",
  },
  neutral: {
    color: "var(--ink-2)",
    border: "var(--line-2)",
    bg: "var(--card-2)",
  },
} as const;

export function ApprovalQueueCard({
  loading,
  errored,
  items,
  busyId,
  onApprove,
  max = 4,
}: {
  loading: boolean;
  errored: boolean;
  items: AwaitingApproval[];
  /** workflowId of the approval currently being decided (locks its buttons). */
  busyId: string | null;
  onApprove: (item: AwaitingApproval) => void;
  max?: number;
}) {
  const navigate = useNavigate();
  const now = Date.now();
  const shown = items.slice(0, max);

  return (
    <div
      style={{
        border: "1px solid var(--line-mid)",
        background: "var(--card)",
        borderRadius: 14,
        overflow: "hidden",
        boxShadow: "var(--shadow-card)",
        alignSelf: "start",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          padding: "15px 18px",
          borderBottom: "1px solid var(--line)",
        }}
      >
        <div
          style={{
            fontSize: "var(--text-body)",
            fontWeight: "var(--weight-bold)",
            color: "var(--ink)",
          }}
        >
          Top of the approval queue
        </div>
        <Link
          to="/app/approvals"
          style={{
            marginLeft: "auto",
            fontSize: "var(--text-sm)",
            color: "var(--brand)",
            fontWeight: "var(--weight-semibold)",
            textDecoration: "none",
          }}
        >
          Open inbox →
        </Link>
      </div>

      {shown.length === 0 ? (
        <div
          style={{
            padding: "26px 18px",
            fontSize: "var(--text-body)",
            color: "var(--ink-3)",
            textAlign: "center",
          }}
        >
          {loading
            ? "Loading…"
            : errored
              ? "—"
              : "Nothing waiting on a human right now."}
        </div>
      ) : (
        shown.map((q, i) => {
          const ms = ageMs(q.createdAt, now);
          const chip = TONE_CHIP[ageTone(ms)];
          const busy = busyId !== null;
          return (
            <div
              key={q.workflowId}
              className="run-row"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 13,
                padding: "13px 18px",
                borderBottom:
                  i === shown.length - 1 ? "none" : "1px solid var(--line)",
                cursor: "pointer",
              }}
              onClick={() => navigate(`/app/runs/${q.workflowId}`)}
            >
              <span
                style={{
                  width: 34,
                  height: 34,
                  flex: "none",
                  borderRadius: 9,
                  border:
                    "1px solid color-mix(in srgb, var(--node-approval) 60%, var(--line))",
                  color: "var(--node-approval)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Icon name="approval" size={16} strokeWidth={1.7} />
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    fontSize: "var(--text-body)",
                    fontWeight: "var(--weight-semibold)",
                    color: "var(--ink)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {q.title}
                </div>
                <div
                  className="mono"
                  style={{
                    fontSize: "var(--text-xs)",
                    color: "var(--ink-3)",
                    marginTop: 1,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {q.workflowKey ?? q.workflowId}
                </div>
              </div>
              <span
                className="mono"
                title={`waiting since ${new Date(q.createdAt).toLocaleString()}`}
                style={{
                  flex: "none",
                  fontSize: "var(--text-2xs)",
                  fontWeight: "var(--weight-semibold)",
                  color: chip.color,
                  border: `1px solid ${chip.border}`,
                  background: chip.bg,
                  borderRadius: "var(--radius-pill)",
                  padding: "3px 9px",
                }}
              >
                {formatAge(ms)}
              </span>
              <div style={{ display: "flex", gap: 7, flex: "none" }}>
                <button
                  type="button"
                  disabled={busy}
                  onClick={(e) => {
                    e.stopPropagation();
                    onApprove(q);
                  }}
                  style={{
                    height: 30,
                    padding: "0 12px",
                    borderRadius: 8,
                    border:
                      "1px solid color-mix(in srgb, var(--state-done) 50%, var(--line))",
                    background: "var(--done-soft)",
                    color: "var(--state-done)",
                    fontSize: "var(--text-xs)",
                    fontWeight: "var(--weight-bold)",
                    cursor: busy ? "default" : "pointer",
                    opacity: busy && busyId !== q.workflowId ? 0.55 : 1,
                    fontFamily: "var(--font-sans)",
                  }}
                >
                  {busyId === q.workflowId ? "…" : "Approve"}
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    navigate(`/app/runs/${q.workflowId}`);
                  }}
                  style={{
                    height: 30,
                    padding: "0 11px",
                    borderRadius: 8,
                    border: "1px solid var(--line-2)",
                    background: "var(--card-2)",
                    color: "var(--ink-faint)",
                    fontSize: "var(--text-xs)",
                    cursor: "pointer",
                    fontFamily: "var(--font-sans)",
                  }}
                >
                  View
                </button>
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}
