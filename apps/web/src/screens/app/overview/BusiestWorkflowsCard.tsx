/**
 * "Busiest workflows" — the runs list grouped by workflowKey (last 24h), top 4
 * by run count with a proportional accent bar. Click → workflow detail (or the
 * Runs list for key-less legacy runs).
 */
import { Link, useNavigate } from "react-router-dom";
import { Icon } from "../../../components";
import type { BusyWorkflow } from "./overview-model";

/** Accent cycle mirroring the design comp's node-type colors. */
const ACCENTS = [
  "var(--node-agent)",
  "var(--node-trigger)",
  "var(--node-mcp)",
  "var(--node-http)",
];

export function BusiestWorkflowsCard({
  loading,
  errored,
  workflows,
  narrow,
}: {
  loading: boolean;
  errored: boolean;
  workflows: BusyWorkflow[];
  narrow: boolean;
}) {
  const navigate = useNavigate();
  return (
    <div
      style={{
        marginTop: 16,
        border: "1px solid var(--line-mid)",
        background: "var(--card)",
        borderRadius: 14,
        padding: "16px 18px",
        boxShadow: "var(--shadow-card)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", marginBottom: 14 }}>
        <div
          style={{
            fontSize: "var(--text-body)",
            fontWeight: "var(--weight-bold)",
            color: "var(--ink)",
          }}
        >
          Busiest workflows
        </div>
        <Link
          to="/app/workflows"
          style={{
            marginLeft: "auto",
            fontSize: "var(--text-sm)",
            color: "var(--brand)",
            fontWeight: "var(--weight-semibold)",
            textDecoration: "none",
          }}
        >
          All workflows →
        </Link>
      </div>

      {workflows.length === 0 ? (
        <div
          style={{
            fontSize: "var(--text-body)",
            color: "var(--ink-3)",
            padding: "6px 0 4px",
          }}
        >
          {loading
            ? "Loading…"
            : errored
              ? "—"
              : "No runs in the last 24 hours."}
        </div>
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: narrow
              ? "1fr 1fr"
              : `repeat(${Math.max(workflows.length, 2)}, 1fr)`,
            gap: 12,
          }}
        >
          {workflows.map((w, i) => {
            const accent = ACCENTS[i % ACCENTS.length];
            return (
              <button
                key={w.key ?? w.label}
                type="button"
                className="run-row"
                onClick={() =>
                  navigate(
                    w.key
                      ? `/app/workflows/${encodeURIComponent(w.key)}`
                      : "/app/runs",
                  )
                }
                style={{
                  border: "1px solid var(--line-mid)",
                  background: "var(--card-2)",
                  borderRadius: 11,
                  padding: "13px 14px",
                  cursor: "pointer",
                  textAlign: "left",
                  font: "inherit",
                  color: "var(--ink)",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 9,
                    marginBottom: 9,
                  }}
                >
                  <span
                    style={{
                      width: 28,
                      height: 28,
                      flex: "none",
                      borderRadius: 7,
                      border: `1px solid ${accent}`,
                      color: accent,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <Icon name="workflow" size={14} strokeWidth={1.7} />
                  </span>
                  <span
                    style={{
                      fontSize: "var(--text-sm)",
                      fontWeight: "var(--weight-semibold)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {w.label}
                  </span>
                </div>
                <div
                  style={{
                    display: "flex",
                    alignItems: "baseline",
                    gap: 6,
                  }}
                >
                  <span
                    className="mono"
                    style={{
                      fontSize: "var(--text-lg)",
                      fontWeight: "var(--weight-bold)",
                    }}
                  >
                    {w.count.toLocaleString()}
                  </span>
                  <span
                    style={{
                      fontSize: "var(--text-2xs)",
                      color: "var(--ink-3)",
                    }}
                  >
                    runs · 24h
                  </span>
                </div>
                <div
                  style={{
                    height: 5,
                    borderRadius: 3,
                    background: "var(--surface)",
                    overflow: "hidden",
                    marginTop: 9,
                  }}
                >
                  <div
                    style={{
                      height: "100%",
                      width: `${w.pct}%`,
                      background: accent,
                      borderRadius: 3,
                    }}
                  />
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
