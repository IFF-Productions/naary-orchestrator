import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button, Card, Icon, SearchInput, StatusPill } from "../../components";
import { api, type GraphSummary, type RunSummary } from "../../lib/api";
import { runStatusUi, successRate } from "../../lib/run-status";

/**
 * Workflows — the tenant's saved graphs (from POST /graphs via the canvas), each
 * with REAL recent-run stats derived from the runs list (run count, success rate,
 * last status). Open one to edit it on the canvas, or create a new one.
 */
const GRID = "2.2fr 1fr 0.8fr 1fr 90px";

interface Row {
  graph: GraphSummary;
  runs: number;
  success: number | null;
  lastStatus: string | null;
}

export function Workflows() {
  const navigate = useNavigate();
  const [graphs, setGraphs] = useState<GraphSummary[] | null>(null);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [query, setQuery] = useState("");
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    Promise.all([api.listGraphs(), api.listRuns().catch(() => [])])
      .then(([gs, rs]) => {
        if (!live) return;
        setGraphs(gs);
        setRuns(rs);
      })
      .catch((e) => live && setErr(e instanceof Error ? e.message : "failed"));
    return () => {
      live = false;
    };
  }, []);

  // Per-workflow stats from the runs list (newest-first), keyed by workflowKey.
  const rows = useMemo<Row[]>(() => {
    const byKey = new Map<string, RunSummary[]>();
    for (const r of runs) {
      if (!r.workflowKey) continue;
      const arr = byKey.get(r.workflowKey) ?? [];
      arr.push(r);
      byKey.set(r.workflowKey, arr);
    }
    return (graphs ?? []).map((g) => {
      const wr = byKey.get(g.workflowKey) ?? [];
      return {
        graph: g,
        runs: wr.length,
        success: successRate(wr.map((r) => r.status)),
        lastStatus: wr[0]?.status ?? null,
      };
    });
  }, [graphs, runs]);

  const filtered = rows.filter(
    (r) =>
      !query ||
      r.graph.name.toLowerCase().includes(query.toLowerCase()) ||
      r.graph.workflowKey.includes(query),
  );

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
            Workflows
          </div>
          <div style={{ fontSize: 12.5, color: "var(--ink-2)", marginTop: 2 }}>
            {graphs ? `${graphs.length} saved` : "…"}
            {runs.length ? ` · ${runs.length} recent runs` : ""}
          </div>
        </div>
        <Button
          variant="primary"
          icon="plus"
          onClick={() => navigate("/app/canvas")}
        >
          New workflow
        </Button>
      </div>

      <div style={{ marginBottom: 14 }}>
        <SearchInput
          placeholder="Filter by name…"
          kbd=""
          value={query}
          onChange={setQuery}
          style={{ width: 240 }}
        />
      </div>

      <Card pad={false} style={{ overflow: "hidden" }}>
        <div
          className="mono"
          style={{
            display: "grid",
            gridTemplateColumns: GRID,
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
          <span>Workflow</span>
          <span>Last run</span>
          <span>Runs</span>
          <span>Success</span>
          <span />
        </div>

        {err && (
          <div style={{ padding: 18, fontSize: 12.5, color: "var(--ink-2)" }}>
            Sign in to see your saved workflows.
          </div>
        )}
        {!err && graphs === null && (
          <div style={{ padding: 18, fontSize: 12.5, color: "var(--ink-3)" }}>
            Loading…
          </div>
        )}
        {!err && graphs?.length === 0 && (
          <div style={{ padding: 18, fontSize: 12.5, color: "var(--ink-2)" }}>
            No saved workflows yet — create one on the canvas.
          </div>
        )}

        {filtered.map((r) => (
          <div
            key={r.graph.workflowKey}
            onClick={() =>
              navigate(
                `/app/workflows/${encodeURIComponent(r.graph.workflowKey)}`,
              )
            }
            className="run-row"
            style={{
              display: "grid",
              gridTemplateColumns: GRID,
              gap: 10,
              padding: "13px 18px",
              borderBottom: "1px solid var(--line)",
              alignItems: "center",
              cursor: "pointer",
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div
                style={{ fontSize: 13, fontWeight: 600, color: "var(--ink)" }}
              >
                {r.graph.name}
              </div>
              <div
                className="mono"
                style={{ fontSize: 11, color: "var(--ink-3)" }}
              >
                {r.graph.workflowKey} · v{r.graph.version}
              </div>
            </div>
            <span>
              {r.lastStatus ? (
                <StatusPill {...runStatusUi(r.lastStatus)} />
              ) : (
                <span style={{ fontSize: 11.5, color: "var(--ink-3)" }}>
                  No runs
                </span>
              )}
            </span>
            <span
              className="mono"
              style={{ fontSize: 12, color: "var(--ink)" }}
            >
              {r.runs}
            </span>
            <span
              className="mono"
              style={{ fontSize: 11.5, color: "var(--ink-2)" }}
            >
              {r.success === null ? "—" : `${Math.round(r.success)}%`}
            </span>
            <span style={{ textAlign: "right" }}>
              <Button
                variant="secondary"
                onClick={(e) => {
                  e.stopPropagation();
                  navigate(
                    `/app/canvas?key=${encodeURIComponent(r.graph.workflowKey)}`,
                  );
                }}
              >
                Open
              </Button>
            </span>
          </div>
        ))}
      </Card>

      <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 10 }}>
        <Icon
          name="info"
          size={12}
          style={{ verticalAlign: "-2px", marginRight: 5 }}
        />
        Run stats are computed from the {runs.length} most recent runs.
      </div>
    </div>
  );
}
