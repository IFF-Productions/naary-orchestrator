import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button, Icon, StatusPill } from "../../components";
import { api } from "../../lib/api";
import { runs as mockRuns, type RunRow } from "../../lib/mock";

const COLS = ".9fr 1.7fr 1fr .8fr .8fr .8fr";
type FilterKey = "all" | "awaiting" | "running" | "failed";

const FILTERS: { key: FilterKey; label: string; color?: string }[] = [
  { key: "all", label: "All" },
  { key: "awaiting", label: "Awaiting 7", color: "var(--state-paused)" },
  { key: "running", label: "Running 4" },
  { key: "failed", label: "Failed" },
];

export function Runs() {
  const navigate = useNavigate();
  const [filter, setFilter] = useState<FilterKey>("all");
  const [query, setQuery] = useState("");
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Live runs started from the browser via POST /executions get prepended.
  const [liveRuns, setLiveRuns] = useState<RunRow[]>([]);

  const all = [...liveRuns, ...mockRuns];
  const rows = all.filter((r) => {
    if (
      query &&
      !r.id.includes(query) &&
      !r.wf.toLowerCase().includes(query.toLowerCase())
    )
      return false;
    if (filter === "awaiting") return r.awaiting;
    if (filter === "running") return r.statusState === "running";
    if (filter === "failed") return r.statusState === "error";
    return true;
  });

  async function startRun() {
    setStarting(true);
    setError(null);
    try {
      const { workflowId } = await api.startExecution("t-123");
      setLiveRuns((prev) => [
        {
          id: workflowId,
          wf: "Live execution",
          status: "Running",
          statusState: "running",
          awaiting: false,
          steps: "—",
          cost: "—",
          started: "now",
        },
        ...prev,
      ]);
      navigate(`/app/runs/${encodeURIComponent(workflowId)}`);
    } catch (e) {
      setError(
        "Could not reach the control plane. Start it with `pnpm start` (apps/api) on :3000.",
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
            Durable execution log · 7 awaiting approval
          </div>
        </div>
        <div style={{ display: "flex", gap: 9 }}>
          <Button icon="play" onClick={startRun} disabled={starting}>
            {starting ? "Starting…" : "Start test run"}
          </Button>
          <Button icon="external">Export</Button>
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

      {/* filter pills + id search */}
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
            const active = filter === f.key;
            return (
              <button
                key={f.key}
                onClick={() => setFilter(f.key)}
                style={{
                  fontSize: 12,
                  fontWeight: active ? 600 : 500,
                  color: active ? "var(--ink)" : (f.color ?? "var(--ink-2)"),
                  background: active ? "var(--card-2)" : "transparent",
                  padding: "5px 12px",
                  borderRadius: 6,
                  border: "none",
                  cursor: "pointer",
                }}
              >
                {f.label}
              </button>
            );
          })}
        </div>
        <div
          className="input-wrap"
          style={{ width: 230, height: 34, padding: "0 11px" }}
        >
          <Icon name="search" size={14} style={{ color: "var(--ink-3)" }} />
          <input
            className="bare mono"
            style={{ height: 32, fontSize: 11.5 }}
            placeholder="run id…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </div>

      {/* table */}
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
          <span>Steps</span>
          <span>Cost</span>
          <span>Started</span>
        </div>
        {rows.map((r) => (
          <div
            key={r.id}
            onClick={() => navigate(`/app/runs/${encodeURIComponent(r.id)}`)}
            className="run-row"
            style={{
              display: "grid",
              gridTemplateColumns: COLS,
              gap: 10,
              padding: "12px 18px",
              borderBottom: "1px solid var(--line)",
              alignItems: "center",
              cursor: "pointer",
              background: r.awaiting ? "var(--paused-soft)" : undefined,
            }}
          >
            <span
              className="mono"
              style={{ fontSize: 11.5, color: "var(--brand)" }}
            >
              {r.id}
            </span>
            <span
              style={{
                fontSize: 12.5,
                color: "var(--ink)",
                fontWeight: 500,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {r.wf}
            </span>
            <span>
              <StatusPill state={r.statusState} label={r.status} />
            </span>
            <span
              className="mono"
              style={{ fontSize: 11.5, color: "var(--ink-2)" }}
            >
              {r.steps}
            </span>
            <span
              className="mono"
              style={{ fontSize: 11.5, color: "var(--ink-2)" }}
            >
              {r.cost}
            </span>
            <span
              className="mono"
              style={{ fontSize: 11, color: "var(--ink-3)" }}
            >
              {r.started}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
