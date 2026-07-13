import {
  type MouseEvent as ReactMouseEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import { useNavigate } from "react-router-dom";
import { Button, Icon, StatusPill } from "../../components";
import { api, type RunSummary, UnauthorizedError } from "../../lib/api";
import { isFailure, isTerminal, runStatusUi } from "../../lib/run-status";
import { useMode } from "../../mode";

const COLS = "1.5fr 1fr 0.9fr 0.7fr 0.7fr 0.6fr";

/** Compact relative time from an ISO timestamp (no date lib). */
function ago(iso: string): string {
  const then = new Date(iso).getTime();
  const s = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** Filter tabs → which statuses they include (All = everything). */
const FILTERS: { label: string; match: (s: string) => boolean }[] = [
  { label: "All", match: () => true },
  {
    label: "Waiting",
    // Both human-in-the-loop pauses: approval AND wait(webhook) (PR #192).
    match: (s) => s === "awaiting_approval" || s === "awaiting_webhook",
  },
  { label: "Running", match: (s) => s === "running" },
  { label: "Completed", match: (s) => s === "completed" },
  { label: "Failed", match: isFailure },
];

export function Runs() {
  const navigate = useNavigate();
  const { mode } = useMode();
  const simple = mode === "simple";
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("All");
  const [starting, setStarting] = useState(false);
  const [rerunning, setRerunning] = useState<string | null>(null);
  const [archiving, setArchiving] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Monotonic request id: concurrent loads (initial / Refresh / view toggle) can resolve out
  // of order — only the newest is allowed to write `runs`, so a slow earlier request (e.g. the
  // other view) can't clobber the current one.
  const loadSeq = useRef(0);

  async function load(archived = showArchived) {
    const seq = ++loadSeq.current;
    try {
      const rows = await api.listRuns(archived);
      if (seq !== loadSeq.current) return; // superseded by a newer load
      setRuns(rows);
      setError(null);
    } catch (e) {
      if (seq !== loadSeq.current) return;
      setError(
        e instanceof UnauthorizedError
          ? "Not authenticated — sign in (or set an API token) to see runs."
          : "Could not reach the control plane (apps/api on :3000).",
      );
    }
  }

  useEffect(() => {
    void load(false);
  }, []);

  function toggleArchivedView() {
    const next = !showArchived;
    setShowArchived(next);
    setRuns(null);
    void load(next);
  }

  // Archive (active view) or restore (archived view). Either way the run leaves the
  // current list — it moves to the other view — so we drop it optimistically.
  async function toggleArchive(
    id: string,
    archived: boolean,
    e: ReactMouseEvent,
  ) {
    e.stopPropagation();
    setArchiving(id);
    setError(null);
    try {
      await (archived ? api.unarchiveRun(id) : api.archiveRun(id));
      setRuns((prev) => prev?.filter((r) => r.workflowId !== id) ?? null);
    } catch {
      setError(
        archived ? "Could not restore the run." : "Could not archive the run.",
      );
    } finally {
      setArchiving(null);
    }
  }

  const activeFilter = FILTERS.find((f) => f.label === filter) ?? FILTERS[0];
  const rows = (runs ?? [])
    .filter((r) => activeFilter.match(r.status))
    .filter(
      (r) =>
        !query ||
        r.workflowId.includes(query) ||
        (r.workflowKey ?? "").includes(query),
    );

  async function rerun(id: string, e: ReactMouseEvent) {
    e.stopPropagation(); // don't also navigate into the (old) run
    setRerunning(id);
    setError(null);
    try {
      const { workflowId } = await api.rerun(id);
      navigate(`/app/runs/${encodeURIComponent(workflowId)}`);
    } catch {
      setError("Could not re-run (the run may predate re-run support).");
    } finally {
      setRerunning(null);
    }
  }

  async function startRun() {
    setStarting(true);
    setError(null);
    try {
      const { workflowId } = await api.startExecution();
      navigate(`/app/runs/${encodeURIComponent(workflowId)}`);
    } catch (e) {
      setError(
        e instanceof UnauthorizedError
          ? "Not authenticated — sign in (or set an API token) first."
          : "Could not start a run. Is the default graph seeded? (POST /executions)",
      );
    } finally {
      setStarting(false);
    }
  }

  return (
    <div style={{ padding: "24px 28px 40px" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 16,
        }}
      >
        <div>
          <div
            style={{
              fontSize: "var(--text-title)",
              fontWeight: "var(--weight-bold)",
              letterSpacing: "-0.01em",
            }}
          >
            Runs
          </div>
          <div
            style={{
              fontSize: "var(--text-sm)",
              color: "var(--ink-2)",
              marginTop: 2,
            }}
          >
            {showArchived
              ? `Archived runs${runs ? ` · ${runs.length}` : ""}`
              : simple
                ? `Every time your automations ran${runs ? ` · ${runs.length} recent` : ""}`
                : `Durable execution log${runs ? ` · ${runs.length} recent` : ""}`}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {!simple && !showArchived && (
            <Button icon="play" onClick={startRun} disabled={starting}>
              {starting ? "Starting…" : "Start test run"}
            </Button>
          )}
          <Button
            icon="archive"
            variant={showArchived ? "primary" : "secondary"}
            onClick={toggleArchivedView}
          >
            {showArchived ? "Back to runs" : "Archived"}
          </Button>
          <Button icon="refresh" onClick={() => void load()}>
            Refresh
          </Button>
        </div>
      </div>

      {error && (
        <div
          style={{
            marginBottom: 14,
            padding: "8px 12px",
            borderRadius: "var(--radius-sm)",
            background: "var(--error-soft)",
            border:
              "1px solid color-mix(in srgb, var(--state-error) 40%, transparent)",
            color: "var(--state-error)",
            fontSize: "var(--text-sm)",
          }}
        >
          {error}
        </div>
      )}

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          marginBottom: 14,
        }}
      >
        <div
          style={{
            display: "flex",
            background: "var(--surface)",
            border: "1px solid var(--line)",
            borderRadius: "var(--radius-sm)",
            padding: 3,
            gap: 2,
          }}
        >
          {FILTERS.map((f) => {
            const active = f.label === filter;
            const count = (runs ?? []).filter((r) => f.match(r.status)).length;
            return (
              <button
                key={f.label}
                type="button"
                onClick={() => setFilter(f.label)}
                style={{
                  border: "none",
                  cursor: "pointer",
                  fontSize: "var(--text-sm)",
                  fontWeight: active
                    ? "var(--weight-semibold)"
                    : "var(--weight-regular)",
                  color: active ? "var(--ink)" : "var(--ink-2)",
                  background: active ? "var(--card-2)" : "transparent",
                  padding: "5px 12px",
                  borderRadius: "var(--radius-xs)",
                  transition: "background 140ms ease, color 140ms ease",
                }}
              >
                {f.label}
                {runs ? ` ${count}` : ""}
              </button>
            );
          })}
        </div>
        <div
          className="input-wrap"
          style={{ width: 260, height: 34, padding: "0 11px" }}
        >
          <Icon name="search" size={14} style={{ color: "var(--ink-3)" }} />
          <input
            className="bare mono"
            style={{ height: 32, fontSize: "var(--text-xs)" }}
            placeholder={
              simple ? "run id or automation…" : "run id or workflow…"
            }
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </div>

      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        <div
          className="mono"
          style={{
            display: "grid",
            gridTemplateColumns: COLS,
            gap: 10,
            padding: "10px 18px",
            borderBottom: "1px solid var(--line)",
            fontSize: "var(--text-2xs)",
            fontWeight: "var(--weight-semibold)",
            letterSpacing: "0.08em",
            color: "var(--ink-3)",
            textTransform: "uppercase",
          }}
        >
          <span>Run</span>
          <span>{simple ? "Automation" : "Workflow"}</span>
          <span>Status</span>
          <span>Cost</span>
          <span>Started</span>
          <span />
        </div>

        {runs === null && !error && (
          <div
            style={{
              padding: 18,
              fontSize: "var(--text-body)",
              color: "var(--ink-3)",
            }}
          >
            Loading…
          </div>
        )}
        {runs?.length === 0 && (
          <div
            style={{
              padding: 18,
              fontSize: "var(--text-body)",
              color: "var(--ink-3)",
            }}
          >
            {showArchived
              ? "No archived runs — use the archive button on a run to hide it here."
              : simple
                ? "No runs yet — open an automation and press “Run now”."
                : "No runs yet — start one from the canvas or “Start test run”."}
          </div>
        )}

        {rows.map((r) => (
          <div
            key={r.workflowId}
            onClick={() =>
              navigate(`/app/runs/${encodeURIComponent(r.workflowId)}`)
            }
            className="run-row"
            style={{
              display: "grid",
              gridTemplateColumns: COLS,
              gap: 10,
              padding: "12px 18px",
              borderBottom: "1px solid var(--line)",
              alignItems: "center",
              cursor: "pointer",
            }}
          >
            <span
              className="mono"
              style={{
                fontSize: "var(--text-xs)",
                color: "var(--brand)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {r.workflowId}
            </span>
            <span
              className="mono"
              style={{ fontSize: "var(--text-xs)", color: "var(--ink-2)" }}
            >
              {r.workflowKey ?? "—"}
            </span>
            <span>
              <StatusPill {...runStatusUi(r.status)} />
            </span>
            <span
              className="mono"
              style={{ fontSize: "var(--text-xs)", color: "var(--ink-2)" }}
            >
              {r.costUsd === null ? "—" : `$${r.costUsd.toFixed(4)}`}
            </span>
            <span
              className="mono"
              style={{ fontSize: "var(--text-xs)", color: "var(--ink-3)" }}
            >
              {ago(r.startedAt)}
            </span>
            <span
              style={{
                display: "flex",
                justifyContent: "flex-end",
                gap: 6,
              }}
            >
              {isTerminal(r.status) && (
                <Button
                  size="sm"
                  variant="secondary"
                  icon="refresh"
                  iconOnly
                  title="Re-run with the same input"
                  disabled={rerunning === r.workflowId}
                  onClick={(e) => void rerun(r.workflowId, e)}
                />
              )}
              <Button
                size="sm"
                variant="secondary"
                icon={r.archived ? "eye" : "archive"}
                iconOnly
                title={
                  r.archived
                    ? "Restore to the Runs list"
                    : "Archive — hide from this list"
                }
                disabled={archiving === r.workflowId}
                onClick={(e) => void toggleArchive(r.workflowId, r.archived, e)}
              />
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
