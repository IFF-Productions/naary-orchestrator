import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  Button,
  Card,
  Checkbox,
  Dialog,
  Icon,
  LoadingBlock,
  SearchInput,
  Select,
  StatusPill,
  Switch,
  Tag,
} from "../../components";
import {
  api,
  type Environment,
  getActiveEnvironment,
  type GraphSummary,
  type RunSummary,
  type Tag as TagRow,
} from "../../lib/api";
import { runStatusUi, successRate } from "../../lib/run-status";
import { PHONE_QUERY, useMediaQuery } from "../../lib/useMediaQuery";
import { WorkflowTagsDialog } from "./WorkflowTagsDialog";

/**
 * Workflows — the tenant's saved graphs (from POST /graphs via the canvas), each
 * with REAL recent-run stats derived from the runs list (run count, success rate,
 * last status). Open one to edit it on the canvas, or create a new one.
 */
// Actions column is a FIXED width wide enough for Open/Promote/Delete (a too-narrow 90px overflowed
// into the Active toggle; `auto` mis-aligns the header vs data since each row is its own grid).
const GRID = "2.2fr 1fr 0.8fr 1fr 84px 230px";

interface Row {
  graph: GraphSummary;
  runs: number;
  success: number | null;
  lastStatus: string | null;
}

export function Workflows() {
  const navigate = useNavigate();
  const phone = useMediaQuery(PHONE_QUERY); // phone: rows render as stacked cards
  const [graphs, setGraphs] = useState<GraphSummary[] | null>(null);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [tenant, setTenant] = useState<string | null>(null);
  const [toggling, setToggling] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  // Tags: the workspace's tag list (filter menu + edit dialog), the ids the list is
  // filtered by (AND semantics — a row must carry every selected tag), and the workflow
  // whose tags are being edited.
  const [allTags, setAllTags] = useState<TagRow[]>([]);
  const [tagFilter, setTagFilter] = useState<string[]>([]);
  const [tagMenuOpen, setTagMenuOpen] = useState(false);
  const tagMenuRef = useRef<HTMLSpanElement>(null);
  const [editTags, setEditTags] = useState<{
    key: string;
    name: string;
  } | null>(null);

  // Close the tag-filter menu on an outside click / Escape (the RerunMenu pattern).
  useEffect(() => {
    if (!tagMenuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (tagMenuRef.current && !tagMenuRef.current.contains(e.target as Node))
        setTagMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) =>
      e.key === "Escape" && setTagMenuOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [tagMenuOpen]);
  // Promote flow: the workflow being promoted (source = the ACTIVE env, via the header), the
  // candidate target envs (all but the active one), and progress/result.
  const [promoteFor, setPromoteFor] = useState<string | null>(null);
  const [promoteEnvs, setPromoteEnvs] = useState<Environment[]>([]);
  const [promoteBusy, setPromoteBusy] = useState<string | null>(null);
  const [promoteMsg, setPromoteMsg] = useState<string | null>(null);

  async function openPromote(workflowKey: string): Promise<void> {
    if (!tenant) return;
    setPromoteFor(workflowKey);
    setPromoteMsg(null);
    setPromoteEnvs([]);
    let envs: Environment[];
    try {
      envs = await api.listEnvironments(tenant);
    } catch {
      // Distinguish a load failure from "no other environments".
      setPromoteMsg("Couldn't load environments — try again.");
      return;
    }
    const active = getActiveEnvironment();
    // Exclude the SOURCE env from the targets. When no env is selected (header omitted), the
    // server uses the DEFAULT env as the source — so filter THAT out, not just a matching slug.
    setPromoteEnvs(
      envs.filter((e) =>
        active ? e.slug !== active && e.id !== active : !e.isDefault,
      ),
    );
  }

  async function doPromote(
    workflowKey: string,
    target: Environment,
  ): Promise<void> {
    setPromoteBusy(target.id);
    setPromoteMsg(null);
    try {
      const res = await api.promoteWorkflow(workflowKey, target.slug);
      setPromoteMsg(`Promoted to ${target.name} (v${res.toVersion}).`);
    } catch {
      setPromoteMsg(`Could not promote to ${target.name}.`);
    } finally {
      setPromoteBusy(null);
    }
  }
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
      api.listTags().catch(() => []),
    ])
      .then(([gs, rs, t, ts]) => {
        if (!live) return;
        setGraphs(gs);
        setRuns(rs);
        setTenant(t);
        setAllTags(ts);
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
      (!query ||
        r.graph.name.toLowerCase().includes(query.toLowerCase()) ||
        r.graph.workflowKey.includes(query)) &&
      // Tag filter: AND semantics — the row must carry EVERY selected tag.
      tagFilter.every((id) => (r.graph.tags ?? []).some((t) => t.id === id)),
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

      <div
        style={{
          marginBottom: 14,
          display: "flex",
          alignItems: "center",
          gap: 10,
          flexWrap: "wrap",
        }}
      >
        <SearchInput
          placeholder="Filter by name…"
          kbd=""
          value={query}
          onChange={setQuery}
          style={{ width: 240 }}
        />
        {/* Tag filter — multi-select of existing tags; filters client-side (AND). */}
        <span
          ref={tagMenuRef}
          style={{ position: "relative", display: "inline-flex" }}
        >
          <Select
            value={
              tagFilter.length
                ? `${tagFilter.length} tag${tagFilter.length === 1 ? "" : "s"}`
                : undefined
            }
            placeholder="All tags"
            onClick={() => setTagMenuOpen((o) => !o)}
          />
          {tagMenuOpen && (
            <div
              role="menu"
              onClick={(e) => e.stopPropagation()}
              style={{
                position: "absolute",
                top: "calc(100% + 4px)",
                left: 0,
                zIndex: 30,
                minWidth: 200,
                maxHeight: 260,
                overflowY: "auto",
                background: "var(--surface)",
                border: "1px solid var(--line)",
                borderRadius: 10,
                boxShadow: "0 8px 28px rgba(0,0,0,0.18)",
                padding: 6,
              }}
            >
              {allTags.length === 0 && (
                <div
                  style={{
                    fontSize: "var(--text-xs)",
                    color: "var(--ink-3)",
                    padding: "6px 8px",
                  }}
                >
                  No tags yet — add one from a workflow row.
                </div>
              )}
              {allTags.map((t) => {
                const on = tagFilter.includes(t.id);
                return (
                  <div
                    key={t.id}
                    role="menuitemcheckbox"
                    aria-checked={on}
                    onClick={() =>
                      setTagFilter((prev) =>
                        on ? prev.filter((id) => id !== t.id) : [...prev, t.id],
                      )
                    }
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "6px 8px",
                      borderRadius: 7,
                      cursor: "pointer",
                    }}
                  >
                    <Checkbox checked={on} />
                    <Tag color={t.color ?? undefined}>{t.name}</Tag>
                    <span
                      style={{
                        marginLeft: "auto",
                        fontSize: "var(--text-xs)",
                        color: "var(--ink-3)",
                      }}
                    >
                      {t.workflowCount}
                    </span>
                  </div>
                );
              })}
              {tagFilter.length > 0 && (
                <div style={{ padding: 6 }}>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setTagFilter([])}
                  >
                    Clear filter
                  </Button>
                </div>
              )}
            </div>
          )}
        </span>
      </div>

      <Card pad={false} style={{ overflow: "hidden" }}>
        {!phone && (
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
        )}

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

        {filtered.map((r) => {
          const go = () =>
            navigate(
              `/app/workflows/${encodeURIComponent(r.graph.workflowKey)}`,
            );
          const lastRun = r.lastStatus ? (
            <StatusPill {...runStatusUi(r.lastStatus)} />
          ) : (
            <span style={{ fontSize: "var(--text-xs)", color: "var(--ink-3)" }}>
              No runs
            </span>
          );
          const activeSwitch = (
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
          );
          const actions = (
            <>
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
                onClick={(e) => {
                  e.stopPropagation();
                  void openPromote(r.graph.workflowKey);
                }}
                title="Copy this workflow into another environment"
              >
                Promote
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
            </>
          );
          const title = (
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
              {/* Tag chips + the edit affordance (a "+" chip keeps the actions column intact). */}
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  alignItems: "center",
                  gap: 4,
                  marginTop: 5,
                }}
              >
                {(r.graph.tags ?? []).map((t) => (
                  <Tag key={t.id} color={t.color ?? undefined}>
                    {t.name}
                  </Tag>
                ))}
                <button
                  type="button"
                  className="tag"
                  title="Edit tags"
                  onClick={(e) => {
                    e.stopPropagation();
                    setEditTags({
                      key: r.graph.workflowKey,
                      name: r.graph.name,
                    });
                  }}
                  style={{ cursor: "pointer", background: "transparent" }}
                >
                  {(r.graph.tags ?? []).length ? "+" : "+ tag"}
                </button>
              </div>
            </div>
          );

          if (phone) {
            return (
              <div
                key={r.graph.workflowKey}
                onClick={go}
                className="run-row"
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 10,
                  padding: "13px 16px",
                  borderBottom: "1px solid var(--line)",
                  cursor: "pointer",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    justifyContent: "space-between",
                    gap: 10,
                  }}
                >
                  {title}
                  {activeSwitch}
                </div>
                <div
                  className="mono"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    fontSize: "var(--text-xs)",
                    color: "var(--ink-2)",
                  }}
                >
                  {lastRun}
                  <span>{r.runs} runs</span>
                  <span>
                    {r.success === null ? "—" : `${Math.round(r.success)}% ok`}
                  </span>
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {actions}
                </div>
              </div>
            );
          }

          return (
            <div
              key={r.graph.workflowKey}
              onClick={go}
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
              {title}
              <span>{lastRun}</span>
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
              {activeSwitch}
              <span
                style={{
                  textAlign: "right",
                  display: "inline-flex",
                  gap: 8,
                  justifyContent: "flex-end",
                }}
              >
                {actions}
              </span>
            </div>
          );
        })}
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

      {/* Promote picker — copy the workflow from the active env into a target env. Uses the shared
          Dialog (consistent overlay/close behaviour + styling). */}
      <Dialog
        open={!!promoteFor}
        onClose={() => setPromoteFor(null)}
        title={`Promote “${promoteFor ?? ""}”`}
        footer={
          <Button variant="ghost" onClick={() => setPromoteFor(null)}>
            Close
          </Button>
        }
      >
        <div
          style={{
            fontSize: "var(--text-sm)",
            color: "var(--ink-3)",
            marginBottom: 14,
            lineHeight: "var(--leading-snug)",
          }}
        >
          Copies this workflow’s current graph from the <strong>active</strong>{" "}
          environment into the target as a new version. Credentials &
          connections are not copied — the target env uses its own.
        </div>
        {promoteEnvs.length === 0 ? (
          <div style={{ fontSize: "var(--text-sm)", color: "var(--ink-3)" }}>
            {promoteMsg ??
              "No other environments to promote to. Create one from the sidebar switcher."}
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {promoteEnvs.map((e) => (
              <Button
                key={e.id}
                variant="secondary"
                loading={promoteBusy === e.id}
                disabled={!!promoteBusy}
                onClick={() => promoteFor && void doPromote(promoteFor, e)}
              >
                Promote to {e.name}
                {e.isDefault ? " (default)" : ""}
              </Button>
            ))}
          </div>
        )}
        {promoteEnvs.length > 0 && promoteMsg && (
          <div
            style={{
              marginTop: 12,
              fontSize: "var(--text-sm)",
              color: "var(--ink-2)",
            }}
          >
            {promoteMsg}
          </div>
        )}
      </Dialog>

      {/* Edit one workflow's tags — replace-set save; a tag created inline joins the list. */}
      <WorkflowTagsDialog
        workflowKey={editTags?.key ?? null}
        workflowName={editTags?.name ?? ""}
        current={
          graphs?.find((g) => g.workflowKey === editTags?.key)?.tags ?? []
        }
        allTags={allTags}
        onClose={() => setEditTags(null)}
        onSaved={(key, tags) =>
          setGraphs(
            (gs) =>
              gs?.map((g) => (g.workflowKey === key ? { ...g, tags } : g)) ??
              gs,
          )
        }
        onTagCreated={(t) =>
          setAllTags((prev) =>
            [...prev, t].sort((a, b) => a.name.localeCompare(b.name)),
          )
        }
      />
    </div>
  );
}
