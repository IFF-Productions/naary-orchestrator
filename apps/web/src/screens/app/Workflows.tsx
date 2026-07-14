import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  Button,
  Card,
  Icon,
  LoadingBlock,
  SearchInput,
  StatusPill,
  Switch,
} from "../../components";
import { api, type GraphSummary, type RunSummary } from "../../lib/api";
import { runStatusUi, successRate } from "../../lib/run-status";

/**
 * Workflows — the tenant's saved graphs (from POST /graphs via the canvas), each
 * with REAL recent-run stats derived from the runs list (run count, success rate,
 * last status). Open one to edit it on the canvas, or create a new one.
 */
const GRID = "2.2fr 1fr 0.8fr 1fr 84px 90px";

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
  const [tenant, setTenant] = useState<string | null>(null);
  const [toggling, setToggling] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  // Seed the filter from ?q= so the global topbar search lands here pre-filtered.
  const [searchParams] = useSearchParams();
  const [query, setQuery] = useState(searchParams.get("q") ?? "");
  const [err, setErr] = useState<string | null>(null);

  // Re-sync when ?q changes while we're ALREADY on this route — a same-route navigation
  // (searching from the topbar while on Workflows) doesn't remount, so the mount seed alone
  // would leave the list unfiltered.
  useEffect(() => {
    setQuery(searchParams.get("q") ?? "");
  }, [searchParams]);

  useEffect(() => {
    let live = true;
    Promise.all([
      api.listGraphs(),
      api.listRuns().catch(() => []),
      api
        .getMe()
        .then((m) => m.tenantId)
        .catch(() => null),
    ])
      .then(([gs, rs, t]) => {
        if (!live) return;
        setGraphs(gs);
        setRuns(rs);
        setTenant(t);
      })
      .catch((e) => live && setErr(e instanceof Error ? e.message : "failed"));
    return () => {
      live = false;
    };
  }, []);

  async function toggleActive(workflowKey: string, next: boolean) {
    if (!tenant || toggling) return;
    setToggling(workflowKey);
    // Optimistic: flip locally, revert on failure.
    setGraphs(
      (gs) =>
        gs?.map((g) =>
          g.workflowKey === workflowKey ? { ...g, active: next } : g,
        ) ?? gs,
    );
    try {
      await api.setWorkflowActive(tenant, workflowKey, next);
    } catch {
      setGraphs(
        (gs) =>
          gs?.map((g) =>
            g.workflowKey === workflowKey ? { ...g, active: !next } : g,
          ) ?? gs,
      );
      setErr("Could not change activation — try again.");
    } finally {
      setToggling(null);
    }
  }

  async function remove(workflowKey: string, name: string) {
    if (deleting) return;
    if (
      !window.confirm(
        `Delete workflow "${name}"? This removes the workflow and its webhooks, forms, chats, and schedules. Run history is kept. This can't be undone.`,
      )
    ) {
      return;
    }
    setDeleting(workflowKey);
    setErr(null);
    try {
      await api.deleteGraph(workflowKey);
      setGraphs((gs) => gs?.filter((g) => g.workflowKey !== workflowKey) ?? gs);
    } catch {
      setErr("Could not delete the workflow — try again.");
    } finally {
      setDeleting(null);
    }
  }

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
            style={{
              fontSize: "var(--text-title)",
              fontWeight: "var(--weight-bold)",
              color: "var(--ink)",
              letterSpacing: "var(--tracking-tight)",
            }}
          >
            Workflows
          </div>
          <div
            style={{
              fontSize: "var(--text-body)",
              color: "var(--ink-2)",
              marginTop: 4,
            }}
          >
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
          className="mono-label"
          style={{
            display: "grid",
            gridTemplateColumns: GRID,
            gap: 10,
            padding: "10px 18px",
            borderBottom: "1px solid var(--line)",
          }}
        >
          <span>Workflow</span>
          <span>Last run</span>
          <span>Runs</span>
          <span>Success</span>
          <span>Active</span>
          <span />
        </div>

        {err && (
          <div
            style={{
              padding: 18,
              fontSize: "var(--text-body)",
              color: "var(--ink-2)",
            }}
          >
            Sign in to see your saved workflows.
          </div>
        )}
        {!err && graphs === null && <LoadingBlock label="Loading workflows…" />}
        {!err && graphs?.length === 0 && (
          <div
            style={{
              padding: 18,
              fontSize: "var(--text-body)",
              color: "var(--ink-3)",
            }}
          >
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
                style={{
                  fontSize: "var(--text-body)",
                  fontWeight: "var(--weight-semibold)",
                  color: "var(--ink)",
                }}
              >
                {r.graph.name}
              </div>
              <div
                className="mono"
                style={{ fontSize: "var(--text-xs)", color: "var(--ink-3)" }}
              >
                {r.graph.workflowKey} · v{r.graph.version}
              </div>
            </div>
            <span>
              {r.lastStatus ? (
                <StatusPill {...runStatusUi(r.lastStatus)} />
              ) : (
                <span
                  style={{ fontSize: "var(--text-xs)", color: "var(--ink-3)" }}
                >
                  No runs
                </span>
              )}
            </span>
            <span
              className="mono"
              style={{ fontSize: "var(--text-sm)", color: "var(--ink)" }}
            >
              {r.runs}
            </span>
            <span
              className="mono"
              style={{ fontSize: "var(--text-xs)", color: "var(--ink-2)" }}
            >
              {r.success === null ? "—" : `${Math.round(r.success)}%`}
            </span>
            <span
              onClick={(e) => e.stopPropagation()}
              title={
                r.graph.active
                  ? "Active — automatic triggers fire"
                  : "Inactive — triggers paused (manual runs still work)"
              }
              style={{ display: "inline-flex", alignItems: "center" }}
            >
              <Switch
                checked={r.graph.active}
                onChange={(next) =>
                  void toggleActive(r.graph.workflowKey, next)
                }
              />
            </span>
            <span
              style={{
                textAlign: "right",
                display: "inline-flex",
                gap: 8,
                justifyContent: "flex-end",
              }}
            >
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
              <Button
                variant="secondary"
                disabled={deleting === r.graph.workflowKey}
                onClick={(e) => {
                  e.stopPropagation();
                  void remove(r.graph.workflowKey, r.graph.name);
                }}
              >
                {deleting === r.graph.workflowKey ? "Deleting…" : "Delete"}
              </Button>
            </span>
          </div>
        ))}
      </Card>

      <div
        style={{
          fontSize: "var(--text-xs)",
          color: "var(--ink-3)",
          marginTop: 12,
        }}
      >
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
