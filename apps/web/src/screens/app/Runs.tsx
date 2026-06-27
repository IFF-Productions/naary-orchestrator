import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button, Icon, StatusPill } from "../../components";
import { api, type RunSummary, UnauthorizedError } from "../../lib/api";
import { isFailure, runStatusUi } from "../../lib/run-status";

const COLS = "1.5fr 1fr 0.9fr 0.7fr 0.7fr 0.4fr";

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
  { label: "Awaiting", match: (s) => s === "awaiting_approval" },
  { label: "Running", match: (s) => s === "running" },
  { label: "Completed", match: (s) => s === "completed" },
  { label: "Failed", match: isFailure },
];

export function Runs() {
  const navigate = useNavigate();
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("All");
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      setRuns(await api.listRuns());
      setError(null);
    } catch (e) {
      setError(
        e instanceof UnauthorizedError
          ? "Not authenticated — sign in (or set an API token) to see runs."
          : "Could not reach the control plane (apps/api on :3000).",
      );
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const activeFilter = FILTERS.find((f) => f.label === filter) ?? FILTERS[0];
  const rows = (runs ?? [])
    .filter((r) => activeFilter.match(r.status))
    .filter(
      (r) =>
        !query ||
        r.workflowId.includes(query) ||
        (r.workflowKey ?? "").includes(query),
    );

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
    <div style={{ padding: "22px 28px 40px" }}>
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
            style={{ fontSize: 21, fontWeight: 700, letterSpacing: "-0.01em" }}
          >
            Runs
          </div>
          <div style={{ fontSize: 12.5, color: "var(--ink-2)", marginTop: 2 }}>
            Durable execution log{runs ? ` · ${runs.length} recent` : ""}
          </div>
        </div>
        <div style={{ display: "flex", gap: 9 }}>
          <Button icon="play" onClick={startRun} disabled={starting}>
            {starting ? "Starting…" : "Start test run"}
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
            padding: "9px 12px",
            borderRadius: 8,
            background: "var(--error-soft)",
            border:
              "1px solid color-mix(in srgb, var(--state-error) 40%, transparent)",
            color: "var(--state-error)",
            fontSize: 12,
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
            borderRadius: 8,
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
                  fontSize: 12,
                  fontWeight: active ? 600 : 400,
                  color: active ? "var(--ink)" : "var(--ink-2)",
                  background: active ? "var(--card-2)" : "transparent",
                  padding: "5px 12px",
                  borderRadius: 6,
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
            style={{ height: 32, fontSize: 11.5 }}
            placeholder="run id or workflow…"
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
            fontSize: 9.5,
            fontWeight: 600,
            letterSpacing: "0.08em",
            color: "var(--ink-3)",
            textTransform: "uppercase",
          }}
        >
          <span>Run</span>
          <span>Workflow</span>
          <span>Status</span>
          <span>Cost</span>
          <span>Started</span>
          <span />
        </div>

        {runs === null && !error && (
          <div
            style={{ padding: "18px", fontSize: 12.5, color: "var(--ink-3)" }}
          >
            Loading…
          </div>
        )}
        {runs?.length === 0 && (
          <div
            style={{ padding: "18px", fontSize: 12.5, color: "var(--ink-2)" }}
          >
            No runs yet — start one from the canvas or “Start test run”.
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
                fontSize: 11.5,
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
              style={{ fontSize: 11, color: "var(--ink-2)" }}
            >
              {r.workflowKey ?? "—"}
            </span>
            <span>
              <StatusPill {...runStatusUi(r.status)} />
            </span>
            <span
              className="mono"
              style={{ fontSize: 11, color: "var(--ink-2)" }}
            >
              {r.costUsd === null ? "—" : `$${r.costUsd.toFixed(4)}`}
            </span>
            <span
              className="mono"
              style={{ fontSize: 11, color: "var(--ink-3)" }}
            >
              {ago(r.startedAt)}
            </span>
            <span style={{ textAlign: "right" }}>
              <Icon
                name="chevron-right"
                size={14}
                style={{ color: "var(--ink-3)" }}
              />
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
