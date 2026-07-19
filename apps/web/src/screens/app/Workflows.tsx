/**
 * Workflows list (redesign "Naary Workflows.dc.html") — surfaces TRIGGER and
 * ACTIVATION prominently: each row shows a trigger icon tile + label read from
 * the graph's REAL entry node, where the workflow is live (per-env presence +
 * activation), the last run (real runs data), and a 30-day run count.
 *
 * Data honesty:
 * - "Live in" = per-environment GET /graphs (env-header override per env) +
 *   the activation flag in that env;
 * - "Trigger" = the entry node of each workflow's latest graph (active env);
 * - "Last run" / "30d runs" = derived from the recent-runs list (footnoted —
 *   the list is recency-limited, so 30d counts are a floor, not a census).
 *
 * Kept from the previous screen: ?q search (topbar deep-link), tag filtering +
 * the tags edit dialog, the activation toggle, RBAC affordance gating, and the
 * phone card layout. Promote/delete moved into the detail screen (the redesign
 * folds environments + promote into detail).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  Button,
  Card,
  Checkbox,
  Icon,
  LoadingBlock,
  SearchInput,
  SegmentedToggle,
  Select,
  Switch,
  Tag,
} from "../../components";
import {
  api,
  type Environment,
  type GraphSummary,
  type RunSummary,
  type Tag as TagRow,
} from "../../lib/api";
import { canCreateWorkflow, canDo } from "../../lib/permissions-logic";
import { runStatusUi } from "../../lib/run-status";
import { PHONE_QUERY, useMediaQuery } from "../../lib/useMediaQuery";
import { usePermissions } from "../../lib/usePermissions";
import {
  ago,
  type EnvPresence,
  envRank,
  isProdLike,
  liveIn,
  listGraphsInEnv,
  STATE_DOT,
  triggerInfo,
  type TriggerInfo,
} from "./workflows/model";
import { WorkflowTagsDialog } from "./WorkflowTagsDialog";

// Workflow · Live in · Trigger · Last run · 30d runs · Active
const GRID = "2.2fr 1fr 1.1fr 1.2fr 0.7fr 64px";

type Filter = "all" | "prod" | "active" | "draft";

interface Row {
  graph: GraphSummary;
  presences: EnvPresence[];
  trigger: TriggerInfo | null;
  lastRun: RunSummary | null;
  runs30: number;
}

export function Workflows() {
  const navigate = useNavigate();
  const phone = useMediaQuery(PHONE_QUERY); // phone: rows render as stacked cards
  // Affordance gating (RBAC-GROUPS G2): hide what /me/permissions says the server
  // would 403. Gating only — the API enforces; a forced request still fails.
  const perms = usePermissions();
  const [graphs, setGraphs] = useState<GraphSummary[] | null>(null);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [tenant, setTenant] = useState<string | null>(null);
  const [toggling, setToggling] = useState<string | null>(null);
  // Cross-env presence: env list + which envs each workflowKey exists in.
  const [envs, setEnvs] = useState<Environment[] | null>(null);
  const [presence, setPresence] = useState<Map<string, EnvPresence[]>>(
    new Map(),
  );
  // Trigger info per workflowKey, read from each graph's entry node.
  const [triggers, setTriggers] = useState<Map<string, TriggerInfo>>(new Map());
  const [filter, setFilter] = useState<Filter>("all");
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

  // Per-env presence — one GET /graphs per environment (envs are few).
  useEffect(() => {
    if (!tenant) return;
    let live = true;
    (async () => {
      const es = await api.listEnvironments(tenant).catch(() => []);
      const lists = await Promise.all(
        es.map((e) => listGraphsInEnv(e.id).catch(() => [] as GraphSummary[])),
      );
      if (!live) return;
      const map = new Map<string, EnvPresence[]>();
      es.forEach((env, i) => {
        for (const summary of lists[i]) {
          const arr = map.get(summary.workflowKey) ?? [];
          arr.push({ env, summary });
          map.set(summary.workflowKey, arr);
        }
      });
      setEnvs(es);
      setPresence(map);
    })().catch(() => live && setEnvs([]));
    return () => {
      live = false;
    };
  }, [tenant]);

  // Trigger column — read each workflow's graph once (entry node → trigger).
  useEffect(() => {
    if (!graphs || graphs.length === 0) return;
    let live = true;
    (async () => {
      const results = await Promise.allSettled(
        graphs.map((g) => api.getGraph(g.workflowKey)),
      );
      if (!live) return;
      const map = new Map<string, TriggerInfo>();
      results.forEach((r, i) => {
        if (r.status === "fulfilled" && r.value) {
          map.set(graphs[i].workflowKey, triggerInfo(r.value.graph));
        }
      });
      setTriggers(map);
    })();
    return () => {
      live = false;
    };
  }, [graphs]);

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

  // Per-workflow stats from the runs list (newest-first), keyed by workflowKey.
  const rows = useMemo<Row[]>(() => {
    const byKey = new Map<string, RunSummary[]>();
    for (const r of runs) {
      if (!r.workflowKey) continue;
      const arr = byKey.get(r.workflowKey) ?? [];
      arr.push(r);
      byKey.set(r.workflowKey, arr);
    }
    const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
    return (graphs ?? []).map((g) => {
      const wr = byKey.get(g.workflowKey) ?? [];
      return {
        graph: g,
        presences: presence.get(g.workflowKey) ?? [],
        trigger: triggers.get(g.workflowKey) ?? null,
        lastRun: wr[0] ?? null,
        runs30: wr.filter((r) => new Date(r.startedAt).getTime() >= cutoff)
          .length,
      };
    });
  }, [graphs, runs, presence, triggers]);

  const prodExists = (envs ?? []).some(isProdLike);
  const inProd = rows.filter((r) =>
    r.presences.some((p) => isProdLike(p.env) && p.summary.active),
  ).length;

  const matchesFilter = (r: Row): boolean => {
    switch (filter) {
      case "all":
        return true;
      // Production: the workflow exists in a prod-like env.
      case "prod":
        return r.presences.some((p) => isProdLike(p.env));
      // Active: automatic triggers fire in the CURRENT env (the toggle's fact).
      case "active":
        return r.graph.active;
      // Draft: never deployed above a sandbox-rank env, or switched off here.
      case "draft":
        return !r.graph.active || !r.presences.some((p) => envRank(p.env) >= 2);
    }
  };

  const filtered = rows.filter(
    (r) =>
      matchesFilter(r) &&
      (!query ||
        r.graph.name.toLowerCase().includes(query.toLowerCase()) ||
        r.graph.workflowKey.includes(query)) &&
      // Tag filter: AND semantics — the row must carry EVERY selected tag.
      tagFilter.every((id) => (r.graph.tags ?? []).some((t) => t.id === id)),
  );

  const filterOptions: { value: Filter; label: string }[] = [
    { value: "all", label: "All" },
    ...(prodExists ? [{ value: "prod" as Filter, label: "Production" }] : []),
    { value: "active", label: "Active" },
    { value: "draft", label: "Draft" },
  ];

  return (
    <div
      style={{ padding: "22px 28px 40px", animation: "naaryFadeUp .25s ease" }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "flex-end",
          justifyContent: "space-between",
          marginBottom: 16,
          gap: 12,
          flexWrap: "wrap",
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
            {graphs
              ? `${graphs.length} workflow${graphs.length === 1 ? "" : "s"}` +
                (prodExists ? ` · ${inProd} in production` : "")
              : "…"}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <SegmentedToggle
            options={filterOptions}
            value={filter}
            onChange={setFilter}
          />
          {canCreateWorkflow(perms) && (
            <Button
              variant="primary"
              icon="plus"
              onClick={() => navigate("/app/canvas")}
            >
              New workflow
            </Button>
          )}
        </div>
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
              className="menu-pop"
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
                    className="run-row"
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
              background: "var(--card-2)",
            }}
          >
            <span>Workflow</span>
            <span>Live in</span>
            <span>Trigger</span>
            <span>Last run</span>
            <span style={{ textAlign: "right" }}>30d runs</span>
            <span>Active</span>
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
          // Per-row affordances mirror the effective matrix (tags PUT + the
          // activation toggle are edit-gated).
          const mayEdit = canDo(perms, "edit", r.graph.workflowKey);
          const go = () =>
            navigate(
              `/app/workflows/${encodeURIComponent(r.graph.workflowKey)}`,
            );

          const live = liveIn(r.presences);
          const liveCell = live ? (
            <span
              style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
            >
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  flex: "none",
                  background: live.dot,
                  boxShadow: `0 0 7px ${live.dot}`,
                }}
              />
              <span
                style={{
                  fontSize: "var(--text-xs)",
                  fontWeight: "var(--weight-semibold)",
                  color: live.color,
                }}
              >
                {live.label}
              </span>
            </span>
          ) : (
            // Env picture unavailable (older API / load failure) — fall back to
            // the activation fact we DO have.
            <span style={{ fontSize: "var(--text-xs)", color: "var(--ink-3)" }}>
              {envs === null ? "…" : r.graph.active ? "Active" : "Inactive"}
            </span>
          );

          const triggerCell = r.trigger ? (
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                fontSize: "var(--text-sm)",
                color: "var(--ink-2)",
                minWidth: 0,
              }}
            >
              <Icon
                name={r.trigger.icon}
                size={13}
                style={{ color: r.trigger.accent, flex: "none" }}
              />
              <span
                style={{
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {r.trigger.label}
              </span>
            </span>
          ) : (
            <span style={{ fontSize: "var(--text-xs)", color: "var(--ink-3)" }}>
              …
            </span>
          );

          const lastRunCell = r.lastRun ? (
            <span
              title={runStatusUi(r.lastRun.status).label}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                fontSize: "var(--text-sm)",
                color: "var(--ink-2)",
              }}
            >
              <span
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: "50%",
                  flex: "none",
                  background: STATE_DOT[runStatusUi(r.lastRun.status).state],
                }}
              />
              {ago(r.lastRun.startedAt)}
            </span>
          ) : (
            <span style={{ fontSize: "var(--text-xs)", color: "var(--ink-3)" }}>
              No runs
            </span>
          );

          const activeSwitch = mayEdit ? (
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
          ) : (
            <span
              title="You don't have edit permission on this workflow"
              style={{ fontSize: "var(--text-xs)", color: "var(--ink-3)" }}
            >
              {r.graph.active ? "Active" : "Inactive"}
            </span>
          );

          const title = (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                minWidth: 0,
              }}
            >
              <span
                style={{
                  width: 34,
                  height: 34,
                  flex: "none",
                  borderRadius: 9,
                  border: `1px solid ${r.trigger?.accent ?? "var(--line-2)"}`,
                  color: r.trigger?.accent ?? "var(--ink-3)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Icon name={r.trigger?.icon ?? "workflow"} size={16} />
              </span>
              <div style={{ minWidth: 0 }}>
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
                  {r.graph.name}
                </div>
                <div
                  className="mono"
                  style={{ fontSize: "var(--text-xs)", color: "var(--ink-3)" }}
                >
                  {r.graph.workflowKey} · v{r.graph.version}
                </div>
                {/* Tag chips + the edit affordance (a "+" chip keeps the row compact). */}
                {((r.graph.tags ?? []).length > 0 || mayEdit) && (
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
                    {/* Tag editing is `edit` (§4 — tags PUT is edit-gated), so hide the
                        affordance without it. */}
                    {mayEdit && (
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
                        style={{
                          cursor: "pointer",
                          background: "transparent",
                        }}
                      >
                        {(r.graph.tags ?? []).length ? "+" : "+ tag"}
                      </button>
                    )}
                  </div>
                )}
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
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    fontSize: "var(--text-xs)",
                    color: "var(--ink-2)",
                    flexWrap: "wrap",
                  }}
                >
                  {liveCell}
                  {triggerCell}
                  {lastRunCell}
                  <span className="mono">{r.runs30} runs/30d</span>
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
              <span>{liveCell}</span>
              {triggerCell}
              <span>{lastRunCell}</span>
              <span
                className="mono"
                style={{
                  textAlign: "right",
                  fontSize: "var(--text-sm)",
                  fontWeight: "var(--weight-semibold)",
                  color: "var(--ink)",
                }}
              >
                {r.runs30}
              </span>
              {activeSwitch}
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
