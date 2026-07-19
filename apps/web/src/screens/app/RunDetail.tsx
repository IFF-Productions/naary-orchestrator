/**
 * Run Detail (redesign, "Naary Run Detail.dc.html") — the run-observability
 * screen inside the app shell's content region. Two panes: LEFT the executed-
 * path graph (the run's snapshot graph with the actual route highlighted),
 * RIGHT the status hero (paused-on-approval = calm amber with decide-in-place),
 * the step timeline, and the selected-step detail card with the log panel.
 * All data flow is the existing one: 1.5s state polling, graph snapshot fetch,
 * approval signal, cancel, re-run-at-version, curated history.
 */
import "./run-detail/run-detail.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import type { GraphDef } from "@naary/dsl";
import { Button, Card, Icon, LoadingBlock, StatusPill } from "../../components";
import { api, type ExecutionState, UnauthorizedError } from "../../lib/api";
import { ACCENT, nodeDisplayLabel, nodeSubtitle } from "../../lib/graph-model";
import { canDo } from "../../lib/permissions-logic";
import { isTerminal, runStatusUi } from "../../lib/run-status";
import { useActiveEnvironment } from "../../lib/useActiveEnvironment";
import { PHONE_QUERY, useMediaQuery } from "../../lib/useMediaQuery";
import { usePermissions } from "../../lib/usePermissions";
import { envAccent } from "../../workspace/EnvironmentSwitcher";
import { RerunMenu, VersionBadge } from "./RerunMenu";
import { NodeOutputBody } from "./run-detail/NodeOutputBody";
import { RegionTraceSection } from "./run-detail/RegionTraceSection";
import { RunGraph } from "./run-detail/RunGraph";
import { LogPanel, useRunHistory } from "./run-detail/RunLog";
import {
  computeStepStates,
  fmtAge,
  fmtWhen,
  historyTimes,
  nodeIcon,
  stepOrder,
} from "./run-detail/run-view-model";
import { SectionTitle } from "./run-detail/shared";
import { type ApprovalInfo, StatusHero } from "./run-detail/StatusHero";
import { type StepDetail, StepDetailCard } from "./run-detail/StepDetailCard";
import { StepTimeline, type TimelineStep } from "./run-detail/StepTimeline";
import { UnresolvedInputsSection } from "./run-detail/UnresolvedInputsSection";

export function RunDetail() {
  const { id = "" } = useParams();
  const phone = useMediaQuery(PHONE_QUERY);
  return (
    <div style={{ padding: phone ? "14px 14px 32px" : "20px 28px 40px" }}>
      <BackLink />
      <RunView id={id} />
    </div>
  );
}

function BackLink() {
  const navigate = useNavigate();
  return (
    <button
      onClick={() => navigate("/app/runs")}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        background: "transparent",
        border: "none",
        color: "var(--ink-2)",
        fontSize: "var(--text-sm)",
        cursor: "pointer",
        marginBottom: 14,
        padding: 0,
      }}
    >
      <Icon
        name="chevron-right"
        size={14}
        style={{ transform: "rotate(180deg)" }}
      />
      All runs
    </button>
  );
}

/* ---- Internal ctx keys are orchestrator bookkeeping, not node output. ---- */
function isNodeOutputKey(key: string): boolean {
  return !key.startsWith("__");
}

function costText(ctx: Record<string, unknown>): string {
  const c = ctx.__costUsd;
  return typeof c === "number" ? `$${c.toFixed(4)}` : "—";
}

/** Mono uppercase stat (STEPS / ELAPSED / COST) for the top strip. */
function TopStat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div
        className="mono"
        style={{
          fontSize: "var(--text-2xs)",
          color: "var(--ink-3)",
          letterSpacing: ".03em",
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: "var(--text-body)",
          color: "var(--ink-soft)",
          fontWeight: "var(--weight-semibold)",
          marginTop: 1,
          whiteSpace: "nowrap",
        }}
      >
        {value}
      </div>
    </div>
  );
}

/* ------------- Real run: polls the control plane for live + closed runs ------------- */
function RunView({ id }: { id: string }) {
  const navigate = useNavigate();
  const phone = useMediaQuery(PHONE_QUERY);
  const [state, setState] = useState<ExecutionState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);
  const [resumeUrl, setResumeUrl] = useState<string | null>(null);
  // The graph SNAPSHOT this run executed (immutable → fetched once). null while loading or if
  // the snapshot is unavailable (older runs) — the graph pane just doesn't render then.
  const [graph, setGraph] = useState<GraphDef | null>(null);
  const [runVersion, setRunVersion] = useState<number | null>(null);
  const [runWorkflowKey, setRunWorkflowKey] = useState<string | null>(null);
  // The step the user clicked; null → follow the run (current node / first step).
  const [pickedStep, setPickedStep] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Affordance gating (RBAC-GROUPS G2): re-run needs `run` on the workflow. Unknown key
  // (older runs) → keep the affordance; the server still enforces on the request.
  const perms = usePermissions();
  const mayRerun = !runWorkflowKey || canDo(perms, "run", runWorkflowKey);
  const env = useActiveEnvironment();

  // Curated Temporal history — feeds the log panel AND the real timestamps
  // (run start, paused-since, failure detail).
  const events = useRunHistory(id);

  const poll = useCallback(async () => {
    try {
      const next = await api.getState(id);
      setState(next);
      setError(null);
      return next;
    } catch (e) {
      setError(
        e instanceof UnauthorizedError
          ? "Not authenticated — set your API token on the sign-in screen."
          : "Could not reach the control plane (apps/api on :3000).",
      );
      return null;
    } finally {
      setLoading(false);
    }
  }, [id]);

  // Fetch the run's executed graph snapshot once (immutable for the life of the run).
  useEffect(() => {
    let cancelled = false;
    // Clear the previous run's graph immediately so navigating between runs (this screen
    // isn't unmounted) never flashes — or keeps showing — the wrong run's graph.
    setGraph(null);
    setRunVersion(null);
    setRunWorkflowKey(null);
    setPickedStep(null);
    api.getRunGraph(id).then(
      (r) => {
        if (!cancelled) {
          setGraph(r.graph);
          setRunVersion(r.version);
          setRunWorkflowKey(r.workflowKey);
        }
      },
      (e) => {
        // A 404 is expected for pre-snapshot runs — skip the graph silently. Anything else
        // (500, auth/routing) is unexpected: log it so a real failure is detectable, not hidden.
        if (!(e instanceof Error) || !/→ 404$/.test(e.message)) {
          console.warn("run-detail graph: fetch failed", e);
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [id]);

  // Poll until the run reaches a terminal status (then stop — closed runs don't change).
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      const next = await poll();
      if (cancelled) return;
      if (!next || !isTerminal(next.status)) {
        timer.current = setTimeout(tick, 1500);
      }
    };
    tick();
    return () => {
      cancelled = true;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [poll]);

  // Fetch the signed resume URL while the run is paused on a wait(webhook) node. Built like the
  // webhook ingress URLs elsewhere: `${origin}/api` + the relative path the API returns.
  useEffect(() => {
    if (state?.status !== "awaiting_webhook") {
      setResumeUrl(null);
      return;
    }
    let cancelled = false;
    api.getResumeUrl(id).then(
      (r) => {
        if (!cancelled) setResumeUrl(`${window.location.origin}/api${r.path}`);
      },
      () => {
        /* transient — the poll will retry via a re-render */
      },
    );
    return () => {
      cancelled = true;
    };
  }, [state?.status, id]);

  async function decide(approved: boolean) {
    setActing(true);
    try {
      await api.approve(id, approved);
      await poll();
    } catch {
      setError("Approval signal failed.");
    } finally {
      setActing(false);
    }
  }

  async function cancelRun() {
    if (
      !window.confirm(
        "Cancel this run? It will be terminated and can't resume.",
      )
    )
      return;
    setActing(true);
    try {
      await api.cancelRun(id);
      await poll();
    } catch {
      setError("Could not cancel the run (it may have already finished).");
    } finally {
      setActing(false);
    }
  }

  const status = state?.status;
  const awaiting = status === "awaiting_approval";
  const awaitingWebhook = status === "awaiting_webhook";
  const running = status === "running";
  const active = awaiting || awaitingWebhook || running;
  const ui = status ? runStatusUi(status) : null;

  /* ---------- Derived view-model (all from real run data) ---------- */

  const states = useMemo(
    () =>
      state && graph
        ? computeStepStates(graph, state.ctx, state.currentNodeId, state.status)
        : {},
    [state, graph],
  );
  const order = useMemo(() => (graph ? stepOrder(graph) : []), [graph]);
  const nodeById = useMemo(
    () => new Map((graph?.nodes ?? []).map((n) => [n.id, n])),
    [graph],
  );

  const { startedAt, lastAt, errorDetail } = historyTimes(events);
  // "Suspended since": the moment the history went idle (its last recorded event).
  const sinceIso = awaiting || awaitingWebhook ? lastAt : null;
  const waitingAge = sinceIso
    ? fmtAge(Date.now() - new Date(sinceIso).getTime())
    : null;

  // Steps that RAN (the entry trigger counts — computeStepStates marks it done).
  const executedCount = order.filter((nid) => states[nid] === "done").length;
  const elapsed = startedAt
    ? fmtAge(
        (status && isTerminal(status) && lastAt
          ? new Date(lastAt).getTime()
          : Date.now()) - new Date(startedAt).getTime(),
      )
    : null;

  const currentNode = state ? nodeById.get(state.currentNodeId) : undefined;
  const currentNodeLabel = currentNode
    ? nodeDisplayLabel(currentNode.type, currentNode.config)
    : null;
  const approval: ApprovalInfo | null =
    awaiting && currentNode?.type === "humanApproval"
      ? ((currentNode.config ?? {}) as ApprovalInfo)
      : null;

  // Trigger line: the snapshot's entry node names how this run started.
  const entryNode = graph ? nodeById.get(graph.startNodeId) : undefined;
  const triggerLabel = entryNode
    ? nodeDisplayLabel(entryNode.type, entryNode.config)
    : null;

  // Selection: follow the run until the user picks a step.
  const selectedId =
    pickedStep && nodeById.has(pickedStep)
      ? pickedStep
      : state && nodeById.has(state.currentNodeId)
        ? state.currentNodeId
        : (order[0] ?? null);

  const timelineSteps: TimelineStep[] = useMemo(
    () =>
      order.map((nid) => {
        const n = nodeById.get(nid);
        const st = states[nid] ?? "pending";
        return {
          id: nid,
          label: n ? nodeDisplayLabel(n.type, n.config) : nid,
          icon: n ? nodeIcon(n.type) : "workflow",
          accent: n ? ACCENT[n.type] : "var(--ink-3)",
          state: st,
          // Data honesty: the platform records no per-step duration/cost — only
          // the waiting step's age is real (derived from the durable history).
          duration: st === "waiting" ? waitingAge : null,
          cost: null,
        };
      }),
    [order, nodeById, states, waitingAge],
  );

  const detail: StepDetail | null = useMemo(() => {
    if (!state || !selectedId) return null;
    const n = nodeById.get(selectedId);
    if (!n) return null;
    const st = states[selectedId] ?? "pending";
    const sub = nodeSubtitle(n.type, n.config);
    const hasOwnOutput = selectedId in state.ctx;
    const isTriggerInput =
      !hasOwnOutput &&
      selectedId === graph?.startNodeId &&
      state.ctx.__input !== undefined;
    return {
      id: selectedId,
      label: nodeDisplayLabel(n.type, n.config),
      typeLine: sub ? `${n.type} · ${sub}` : n.type,
      icon: nodeIcon(n.type),
      accent: ACCENT[n.type],
      state: st,
      duration: st === "waiting" ? waitingAge : null,
      output: hasOwnOutput
        ? state.ctx[selectedId]
        : isTriggerInput
          ? state.ctx.__input
          : undefined,
      isTriggerInput,
    };
  }, [state, selectedId, nodeById, states, graph, waitingAge]);

  const nodeOutputs = state
    ? Object.entries(state.ctx).filter(([k]) => isNodeOutputKey(k))
    : [];

  /* ---------- Render ---------- */

  const hero = state && (
    <StatusHero
      status={state.status}
      currentNodeLabel={currentNodeLabel ?? (state.currentNodeId || null)}
      sinceIso={sinceIso}
      approval={approval}
      acting={acting}
      onDecide={(a) => void decide(a)}
      resumeUrl={resumeUrl}
      errorDetail={errorDetail}
      executedCount={executedCount}
      totalCount={graph?.nodes.length ?? 0}
    />
  );

  const rightColumn = state && (
    <div
      style={{ display: "flex", flexDirection: "column", gap: 18, minWidth: 0 }}
    >
      {hero}
      <UnresolvedInputsSection ctx={state.ctx} />
      {graph && (
        <StepTimeline
          steps={timelineSteps}
          selectedId={selectedId}
          onSelect={setPickedStep}
        />
      )}
      {detail && <StepDetailCard step={detail} events={events} />}
      <RegionTraceSection ctx={state.ctx} />
    </div>
  );

  return (
    <>
      {/* ===== Top strip: run identity · status · stats · actions ===== */}
      <div
        style={{
          display: "flex",
          flexDirection: phone ? "column" : "row",
          alignItems: phone ? "stretch" : "flex-start",
          justifyContent: "space-between",
          gap: phone ? 12 : 18,
          marginBottom: 18,
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              flexWrap: "wrap",
            }}
          >
            <span
              style={{
                fontSize: "var(--text-lg)",
                fontWeight: "var(--weight-bold)",
                letterSpacing: "var(--tracking-tight)",
              }}
            >
              {runWorkflowKey ?? "Execution"}
            </span>
            <span
              className="mono"
              style={{
                fontSize: "var(--text-xs)",
                color: "var(--ink-2)",
                background: "var(--surface)",
                border: "1px solid var(--line)",
                padding: "2px 8px",
                borderRadius: "var(--radius-xs)",
              }}
            >
              {id}
            </span>
            {env && (
              <span
                className="mono"
                style={{
                  fontSize: "var(--text-2xs)",
                  color: envAccent({ slug: env, name: env }),
                  border: `1px solid color-mix(in srgb, ${envAccent({ slug: env, name: env })} 50%, transparent)`,
                  background: `color-mix(in srgb, ${envAccent({ slug: env, name: env })} 12%, transparent)`,
                  borderRadius: "var(--radius-pill)",
                  padding: "2px 8px",
                }}
              >
                {env}
              </span>
            )}
            <VersionBadge version={runVersion} />
            {ui && <StatusPill state={ui.state} label={ui.label} />}
          </div>
          <div
            style={{
              fontSize: "var(--text-sm)",
              color: "var(--ink-faint)",
              marginTop: 4,
            }}
          >
            {triggerLabel ? (
              <>
                Triggered by{" "}
                <span style={{ color: "var(--ink-2)" }}>{triggerLabel}</span>
              </>
            ) : (
              "Run"
            )}
            {startedAt && <> · {fmtWhen(startedAt)}</>}
            {active && (
              <span
                className="mono"
                style={{
                  color: "var(--ink-3)",
                  marginLeft: 8,
                  fontSize: "var(--text-2xs)",
                }}
              >
                live · polling 1.5s
              </span>
            )}
          </div>
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 18,
            flexWrap: "wrap",
          }}
        >
          {state && (
            <div style={{ display: "flex", gap: 18 }}>
              <TopStat
                label="STEPS"
                value={graph ? `${executedCount} / ${graph.nodes.length}` : "—"}
              />
              <TopStat label="ELAPSED" value={elapsed ?? "—"} />
              <TopStat label="COST" value={costText(state.ctx)} />
            </div>
          )}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {runWorkflowKey && (
              <Button
                variant="secondary"
                icon="workflow"
                onClick={() =>
                  navigate(
                    `/app/canvas?key=${encodeURIComponent(runWorkflowKey)}`,
                  )
                }
              >
                Open in canvas
              </Button>
            )}
            {active && (
              <Button
                variant="secondary"
                icon="x"
                disabled={acting}
                onClick={() => void cancelRun()}
              >
                Cancel run
              </Button>
            )}
            {status && isTerminal(status) && mayRerun && (
              <RerunMenu
                runId={id}
                workflowKey={runWorkflowKey}
                currentVersion={runVersion}
                size="md"
                label="Re-run"
                onRerun={(newId) => navigate(`/app/runs/${newId}`)}
                onError={setError}
              />
            )}
          </div>
        </div>
      </div>

      {error && (
        <Card
          style={{
            borderColor:
              "color-mix(in srgb, var(--state-error) 40%, transparent)",
            marginBottom: 16,
          }}
        >
          <span
            style={{
              color: "var(--state-error)",
              fontSize: "var(--text-body)",
            }}
          >
            {error}
          </span>
        </Card>
      )}

      {!error && loading && !state && (
        <Card>
          <LoadingBlock label="Loading run…" />
        </Card>
      )}

      {/* ===== Two-pane body: executed-path graph · hero + timeline + detail ===== */}
      {!error && state && graph && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: phone
              ? "minmax(0, 1fr)"
              : "minmax(320px, 42fr) minmax(360px, 58fr)",
            gap: 18,
            alignItems: "start",
          }}
        >
          {/* Phone: status first — the graph pane follows the right column. */}
          {phone ? (
            <>
              {rightColumn}
              <RunGraph
                graph={graph}
                states={states}
                waitingAge={waitingAge}
                selectedId={selectedId}
                onSelect={setPickedStep}
                height={360}
              />
            </>
          ) : (
            <>
              <RunGraph
                graph={graph}
                states={states}
                waitingAge={waitingAge}
                selectedId={selectedId}
                onSelect={setPickedStep}
                height={470}
              />
              {rightColumn}
            </>
          )}
        </div>
      )}

      {/* ===== Fallback for pre-snapshot runs (no graph): hero + raw outputs + log ===== */}
      {!error && state && !graph && (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {hero}
          <UnresolvedInputsSection ctx={state.ctx} />
          {state.ctx.__input !== undefined && (
            <Card style={{ padding: "18px 20px" }}>
              <SectionTitle>Run input</SectionTitle>
              <NodeOutputBody output={state.ctx.__input} />
            </Card>
          )}
          <Card style={{ padding: "18px 20px" }}>
            <SectionTitle>Node outputs</SectionTitle>
            {nodeOutputs.length === 0 ? (
              <div
                style={{ color: "var(--ink-3)", fontSize: "var(--text-body)" }}
              >
                No node outputs yet — this run hasn't produced any node results.
              </div>
            ) : (
              <div
                style={{ display: "flex", flexDirection: "column", gap: 14 }}
              >
                {nodeOutputs.map(([nodeId, output]) => (
                  <div key={nodeId}>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        marginBottom: 6,
                      }}
                    >
                      <span
                        className="mono"
                        style={{
                          fontSize: "var(--text-sm)",
                          fontWeight: "var(--weight-semibold)",
                        }}
                      >
                        {nodeId}
                      </span>
                      {running && state.currentNodeId === nodeId && (
                        <StatusPill state="running" label="current" />
                      )}
                    </div>
                    <NodeOutputBody output={output} />
                  </div>
                ))}
              </div>
            )}
          </Card>
          <RegionTraceSection ctx={state.ctx} />
          <Card style={{ padding: "18px 20px" }}>
            <SectionTitle>Execution log</SectionTitle>
            <LogPanel events={events} />
          </Card>
        </div>
      )}
    </>
  );
}
