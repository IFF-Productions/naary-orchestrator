/**
 * Observe › Runs & logs — the design's runs table over the same /executions
 * list the Runs screen uses. Columns: run id (mono) · workflow · status (glow
 * dot + state color) · cost · duration · when. Duration is the worker-stamped
 * finishedAt − createdAt (Slice 2); runs without one (in-flight / pre-feature)
 * render "—" — never faked. Row click opens the run detail (with its full log
 * view).
 */
import type { RunSummary } from "../../../lib/api";
import { runStatusUi } from "../../../lib/run-status";
import { fmtDurMs } from "../run-detail/run-view-model";
import { fmtCost, relTime } from "./observe-model";
import { CardEmpty, panelCard } from "./ui";

const GRID = "1.2fr 1.6fr 1.1fr 0.8fr 0.7fr 0.7fr";
// The 6-col table stays this wide and scrolls horizontally inside its card on phones
// rather than crushing columns (responsive pattern #3).
const TABLE_MIN_WIDTH = 640;

const STATE_COLOR: Record<string, string> = {
  done: "var(--state-done)",
  paused: "var(--state-paused)",
  error: "var(--state-error)",
  running: "var(--brand)",
  idle: "var(--ink-3)",
};

export function RunsTab({
  runs,
  now,
  onOpen,
}: {
  runs: RunSummary[] | null;
  now: number;
  onOpen: (workflowId: string) => void;
}) {
  return (
    <div style={{ animation: "naaryFadeUp .25s ease" }}>
      <div style={{ ...panelCard, overflow: "hidden" }}>
        <div style={{ overflowX: "auto" }}>
          <div style={{ minWidth: TABLE_MIN_WIDTH }}>
            {/* header */}
            <div
              className="mono"
              style={{
                display: "grid",
                gridTemplateColumns: GRID,
                padding: "11px 18px",
                borderBottom: "1px solid var(--line)",
                background: "var(--card-2)",
                fontSize: 10.5,
                letterSpacing: ".08em",
                textTransform: "uppercase",
                color: "var(--ink-faint)",
              }}
            >
              <span>Run</span>
              <span>Workflow</span>
              <span>Status</span>
              <span>Cost</span>
              <span>Duration</span>
              <span style={{ textAlign: "right" }}>When</span>
            </div>

            {runs === null && <CardEmpty height={120}>Loading runs…</CardEmpty>}
            {runs?.length === 0 && (
              <CardEmpty height={120}>
                No runs yet — start one from a workflow.
              </CardEmpty>
            )}

            {(runs ?? []).map((r, i, arr) => {
              const ui = runStatusUi(r.status);
              const color = STATE_COLOR[ui.state] ?? "var(--ink-3)";
              return (
                <div
                  key={r.workflowId}
                  className="run-row"
                  onClick={() => onOpen(r.workflowId)}
                  role="link"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") onOpen(r.workflowId);
                  }}
                  style={{
                    display: "grid",
                    gridTemplateColumns: GRID,
                    alignItems: "center",
                    padding: "12px 18px",
                    borderBottom:
                      i < arr.length - 1 ? "1px solid var(--line)" : undefined,
                    cursor: "pointer",
                  }}
                >
                  <span
                    className="mono"
                    style={{
                      fontSize: "var(--text-sm)",
                      color: "var(--ink-2)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      paddingRight: 10,
                    }}
                    title={r.workflowId}
                  >
                    {r.workflowId}
                  </span>
                  <span
                    style={{
                      fontSize: 12.5,
                      color: "var(--ink)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      paddingRight: 10,
                    }}
                  >
                    {r.workflowKey ?? "—"}
                  </span>
                  <span
                    style={{ display: "flex", alignItems: "center", gap: 7 }}
                  >
                    <span
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: "50%",
                        flex: "none",
                        background: color,
                        boxShadow: `0 0 7px ${color}`,
                      }}
                    />
                    <span
                      style={{
                        fontSize: "var(--text-sm)",
                        color,
                        fontWeight: "var(--weight-medium)",
                      }}
                    >
                      {ui.label}
                    </span>
                  </span>
                  <span
                    className="mono"
                    style={{
                      fontSize: "var(--text-sm)",
                      color: "var(--ink-2)",
                    }}
                  >
                    {fmtCost(r.costUsd)}
                  </span>
                  <span
                    className="mono"
                    style={{
                      fontSize: "var(--text-sm)",
                      color: "var(--ink-2)",
                    }}
                  >
                    {r.durationMs === null ? "—" : fmtDurMs(r.durationMs)}
                  </span>
                  <span
                    className="mono"
                    title={new Date(r.createdAt).toLocaleString()}
                    style={{
                      textAlign: "right",
                      fontSize: 11.5,
                      color: "var(--ink-3)",
                    }}
                  >
                    {relTime(r.createdAt, now)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
