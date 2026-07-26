import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { useCanvasLink } from "../../lib/useCanvasLink";
import type { GraphDef } from "@naary/dsl";
import { Button, Icon, LoadingBlock, StatusPill } from "../../components";
import {
  api,
  type ExecutionState,
  HttpError,
  type NamedGraph,
  type RunSummary,
  UnauthorizedError,
} from "../../lib/api";
import { friendlyStep } from "../../lib/friendly-catalog";
import { ACCENT, nodeDisplayLabel } from "../../lib/graph-model";
import { isTerminal, runStatusUi } from "../../lib/run-status";
import { PHONE_QUERY, useMediaQuery } from "../../lib/useMediaQuery";
import { useRunHistory } from "../app/run-detail/RunLog";
import {
  computeStepStates,
  fmtAge,
  fmtStepDuration,
  fmtWhen,
  historyTimes,
  nodeTimeOf,
  type StepState,
  stepOrder,
} from "../app/run-detail/run-view-model";

const nodeTint = (type: string): string =>
  ACCENT[type as keyof typeof ACCENT] ?? "var(--ink-3)";

function stepLabel(node: GraphDef["nodes"][number]): string {
  return (
    friendlyStep(node.type)?.title ?? nodeDisplayLabel(node.type, node.config)
  );
}

/**
 * Simple-mode friendly RUN VIEW (design PRODUCT-VARIANTS.md, redesign 3d). Opens a saved
 * automation and describes its LATEST run in plain language — while never hiding run-time
 * truth: an approval pause shows the WAITING hero with the REAL Approve/Reject signal, a
 * failed/rejected run shows its honest terminal status, and cost/budget stay visible.
 *
 * This is a reskin of Builder's Run Detail data flow (1.5s getState poll, curated history,
 * the approval signal) over the SAME pure view-model helpers — a plain-language lens, not a
 * new engine. Editing the steps lives on the explicit "Edit steps" route.
 */
export function AutomationDetail() {
  const { key = "" } = useParams<{ key: string }>();
  const location = useLocation();
  // A run id handed over by the editor's Test action opens THAT run directly,
  // skipping the (possibly-stale) listRuns resolver on first render.
  const handoffRunId =
    (location.state as { runId?: string } | null)?.runId ?? null;
  // getGraph outcome: null = loading; a NamedGraph; or a distinct load error we can
  // message honestly (401 → sign in; 404 → not found; anything else → generic).
  const [named, setNamed] = useState<
    NamedGraph | null | "unauthorized" | "notfound" | "failed"
  >(null);
  // Latest run: null = resolving; a run id; "none" = genuinely no run yet;
  // "unknown" = listRuns FAILED (don't lie "hasn't run yet" — offer a retry).
  const [latestRunId, setLatestRunId] = useState<
    string | null | "none" | "unknown"
  >(handoffRunId);

  // The automation's name + a fallback graph (for the "hasn't run yet" step preview).
  useEffect(() => {
    if (!key) return;
    let live = true;
    api
      .getGraph(key)
      .then((g) => live && setNamed(g))
      .catch((e) => {
        if (!live) return;
        if (e instanceof UnauthorizedError) setNamed("unauthorized");
        else if (e instanceof HttpError && e.status === 404)
          setNamed("notfound");
        else setNamed("failed");
      });
    return () => {
      live = false;
    };
  }, [key]);

  // Resolve the automation's most-recent run (its workflowId) from the real runs list.
  const resolveLatest = useCallback(async () => {
    try {
      const runs = await api.listRuns();
      const mine = runs
        .filter((r: RunSummary) => r.workflowKey === key)
        .sort(
          (a, b) =>
            new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
        );
      setLatestRunId(mine.length ? mine[0].workflowId : "none");
    } catch {
      // Couldn't reach the runs list — this is NOT "no runs yet". Surface it as
      // unknown so the view can offer a retry instead of a false empty state.
      setLatestRunId("unknown");
    }
  }, [key]);
  useEffect(() => {
    // The editor handed us the exact run to open — don't second-guess it with listRuns.
    if (handoffRunId) return;
    void resolveLatest();
  }, [resolveLatest, handoffRunId]);

  if (named === "unauthorized") {
    return <Message>Sign in to see this automation.</Message>;
  }
  if (named === "notfound") {
    return <Message>Couldn't find that automation.</Message>;
  }
  if (named === "failed") {
    return <Message>Couldn't load that automation.</Message>;
  }
  if (!named || latestRunId === null) {
    return <Message subtle>Loading…</Message>;
  }
  if (latestRunId === "unknown") {
    return (
      <div style={{ padding: "22px 28px" }}>
        <div
          style={{
            fontSize: "var(--text-body)",
            color: "var(--ink-2)",
            marginBottom: 12,
          }}
        >
          Couldn't check this automation's runs.
        </div>
        <Button
          variant="secondary"
          onClick={() => {
            setLatestRunId(null);
            void resolveLatest();
          }}
        >
          Try again
        </Button>
      </div>
    );
  }
  if (latestRunId === "none") {
    return (
      <EmptyRun
        automationKey={key}
        name={named.name}
        graph={named.graph}
        onStarted={(id) => setLatestRunId(id)}
      />
    );
  }
  return (
    <RunView
      key={latestRunId}
      runId={latestRunId}
      automationKey={key}
      name={named.name}
    />
  );
}

function Message({
  children,
  subtle,
}: {
  children: React.ReactNode;
  subtle?: boolean;
}) {
  return (
    <div
      style={{
        padding: "22px 28px",
        fontSize: "var(--text-body)",
        color: subtle ? "var(--ink-3)" : "var(--ink-2)",
      }}
    >
      {children}
    </div>
  );
}

/* ---------------- The live run view ---------------- */
function RunView({
  runId,
  automationKey,
  name,
}: {
  runId: string;
  automationKey: string;
  name: string;
}) {
  const navigate = useNavigate();
  // Canvas links carry ?from= so the canvas's back control returns HERE.
  const canvasLink = useCanvasLink();
  const phone = useMediaQuery(PHONE_QUERY);
  const [state, setState] = useState<ExecutionState | null>(null);
  const [graph, setGraph] = useState<GraphDef | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const events = useRunHistory(runId);

  const poll = useCallback(async () => {
    try {
      const next = await api.getState(runId);
      setState(next);
      setError(null);
      return next;
    } catch (e) {
      setError(
        e instanceof UnauthorizedError
          ? "Sign in to see this run."
          : "Could not reach the server.",
      );
      return null;
    } finally {
      setLoading(false);
    }
  }, [runId]);

  // The executed graph SNAPSHOT (immutable) — accurate to what actually ran.
  useEffect(() => {
    let cancelled = false;
    api.getRunGraph(runId).then(
      (r) => !cancelled && setGraph(r.graph),
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [runId]);

  // Poll live runs until terminal (closed runs don't change).
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

  async function decide(approved: boolean) {
    setActing(true);
    try {
      await api.approve(runId, approved);
      await poll();
    } catch {
      setError("Couldn't send that decision — try again.");
    } finally {
      setActing(false);
    }
  }

  const status = state?.status ?? "";
  const awaitingApproval = status === "awaiting_approval";
  const paused =
    awaitingApproval ||
    status === "awaiting_webhook" ||
    status === "awaiting_budget";
  const ui = status ? runStatusUi(status) : null;

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

  const { startedAt, lastAt } = historyTimes(events);
  const sinceIso = paused ? lastAt : null;
  const waitingAge = sinceIso
    ? fmtAge(Date.now() - new Date(sinceIso).getTime())
    : null;

  // The gate the run is paused on (drives the approval hero's decision context).
  const currentNode = state ? nodeById.get(state.currentNodeId) : undefined;
  const approvalTitle =
    awaitingApproval && currentNode?.type === "humanApproval"
      ? (() => {
          const c = (currentNode.config ?? {}) as Record<string, unknown>;
          return typeof c.title === "string" && c.title.trim()
            ? c.title.trim()
            : null;
        })()
      : null;

  // Cost / budget — run-time truth, always shown when the run reports it.
  const spent =
    typeof state?.spentUsd === "number"
      ? state.spentUsd
      : typeof state?.ctx.__costUsd === "number"
        ? (state.ctx.__costUsd as number)
        : null;
  const cap =
    typeof state?.perExecutionCapUsd === "number"
      ? state.perExecutionCapUsd
      : null;

  const checklist = order.map((nid) => {
    const n = nodeById.get(nid);
    const st: StepState = states[nid] ?? "pending";
    const t = nodeTimeOf(state?.nodeTimes, nid);
    const duration =
      st === "waiting" ? waitingAge : t ? fmtStepDuration(t) : null;
    return {
      id: nid,
      label: n ? stepLabel(n) : nid,
      tint: n ? nodeTint(n.type) : "var(--ink-3)",
      state: st,
      duration,
    };
  });

  return (
    <div
      style={{
        padding: phone ? "16px 16px 40px" : "22px 28px 40px",
        maxWidth: 720,
        animation: "naaryFadeUp .25s ease",
      }}
    >
      {/* ===== Header ===== */}
      <button
        type="button"
        onClick={() => navigate("/app/automations")}
        style={{
          all: "unset",
          cursor: "pointer",
          fontSize: "var(--text-sm)",
          color: "var(--ink-2)",
        }}
      >
        ← Automations
      </button>
      <div
        style={{
          display: "flex",
          flexDirection: phone ? "column" : "row",
          alignItems: phone ? "stretch" : "center",
          justifyContent: "space-between",
          gap: 12,
          margin: "10px 0 20px",
        }}
      >
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
              fontSize: "var(--text-title)",
              fontWeight: "var(--weight-bold)",
              color: "var(--ink)",
              letterSpacing: "var(--tracking-tight)",
            }}
          >
            {name}
          </span>
          {ui && <StatusPill state={ui.state} label={ui.label} />}
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Button
            variant="secondary"
            icon="edit"
            onClick={() =>
              navigate(
                `/app/automations/${encodeURIComponent(automationKey)}/edit`,
              )
            }
          >
            Edit steps
          </Button>
          <Button
            variant="secondary"
            icon="workflow"
            onClick={() =>
              navigate(canvasLink(`/app/canvas?key=${encodeURIComponent(automationKey)}`))
            }
          >
            Open in Builder
          </Button>
        </div>
      </div>

      {error && (
        <div
          style={{
            fontSize: "var(--text-sm)",
            color: "var(--state-error)",
            marginBottom: 12,
          }}
        >
          {error}
        </div>
      )}
      {loading && !state && (
        <div
          style={{
            padding: 20,
            background: "var(--card)",
            border: "1px solid var(--line)",
            borderRadius: "var(--radius-lg)",
          }}
        >
          <LoadingBlock label="Loading run…" />
        </div>
      )}

      {/* ===== Approval WAITING hero (durable pause ≠ failed) ===== */}
      {awaitingApproval && (
        <ApprovalHero
          title={approvalTitle}
          sinceIso={sinceIso}
          waitingAge={waitingAge}
          acting={acting}
          onDecide={decide}
        />
      )}

      {/* ===== Other paused states — honest, calm, still not failed ===== */}
      {paused && !awaitingApproval && ui && (
        <PausedHero
          label={ui.label}
          sinceIso={sinceIso}
          waitingAge={waitingAge}
        />
      )}

      {/* ===== What's happened so far ===== */}
      {state && graph && (
        <section style={{ marginTop: paused ? 20 : 0 }}>
          <SectionLabel>What's happened so far</SectionLabel>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 2,
              background: "var(--card)",
              border: "1px solid var(--line)",
              borderRadius: "var(--radius-lg)",
              boxShadow: "var(--shadow-card)",
              padding: 8,
            }}
          >
            {checklist.map((s) => (
              <ChecklistRow key={s.id} step={s} />
            ))}
          </div>
        </section>
      )}

      {/* ===== Footer: cost · budget · started ===== */}
      {state && (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: phone ? 14 : 26,
            marginTop: 18,
            padding: "14px 16px",
            background: "var(--surface)",
            border: "1px solid var(--line)",
            borderRadius: "var(--radius-lg)",
          }}
        >
          <Stat
            label="Cost so far"
            value={spent !== null ? `$${spent.toFixed(4)}` : "—"}
          />
          <Stat
            label="Budget left"
            value={
              cap !== null
                ? `$${Math.max(0, cap - (spent ?? 0)).toFixed(2)}`
                : "No per-run cap"
            }
          />
          <Stat label="Started" value={startedAt ? fmtWhen(startedAt) : "—"} />
        </div>
      )}

      <div
        style={{
          marginTop: 16,
          fontSize: "var(--text-sm)",
          color: "var(--ink-3)",
        }}
      >
        Same run, same durability as Builder — just described in plain language.
      </div>
    </div>
  );
}

/* ---------------- Approval hero (real Approve/Reject signal) ---------------- */
function ApprovalHero({
  title,
  sinceIso,
  waitingAge,
  acting,
  onDecide,
}: {
  title: string | null;
  sinceIso: string | null;
  waitingAge: string | null;
  acting: boolean;
  onDecide: (approved: boolean) => void;
}) {
  return (
    <div
      style={{
        background: "color-mix(in srgb, var(--state-paused) 8%, var(--card))",
        border:
          "1px solid color-mix(in srgb, var(--state-paused) 45%, var(--line))",
        borderRadius: "var(--radius-lg)",
        padding: 20,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <span
          style={{
            flex: "none",
            width: 40,
            height: 40,
            borderRadius: "var(--radius-full)",
            background:
              "color-mix(in srgb, var(--state-paused) 18%, transparent)",
            color: "var(--state-paused)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Icon name="clock" size={20} />
        </span>
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              fontSize: "var(--text-lg)",
              fontWeight: "var(--weight-bold)",
              color: "var(--ink)",
            }}
          >
            Waiting for your approval
          </div>
          <div
            style={{
              fontSize: "var(--text-sm)",
              color: "var(--ink-2)",
              marginTop: 2,
            }}
          >
            Paused
            {sinceIso ? ` since ${fmtWhen(sinceIso)}` : ""}
            {waitingAge ? ` · ${waitingAge}` : ""} · it'll wait as long as it
            needs, then continue.
          </div>
        </div>
      </div>

      {title && (
        <div
          style={{
            marginTop: 14,
            padding: "10px 12px",
            background: "var(--card)",
            border: "1px solid var(--line)",
            borderRadius: "var(--radius-md)",
            fontSize: "var(--text-body)",
            color: "var(--ink)",
          }}
        >
          {title}
        </div>
      )}

      <div
        style={{ display: "flex", gap: 10, marginTop: 16, flexWrap: "wrap" }}
      >
        <button
          type="button"
          disabled={acting}
          onClick={() => onDecide(true)}
          style={{
            ...decisionBtn,
            minWidth: 120,
            background: "var(--state-done)",
            color: "#04140b",
            opacity: acting ? 0.6 : 1,
          }}
        >
          <Icon name="check" size={15} strokeWidth={3} /> Approve
        </button>
        <button
          type="button"
          disabled={acting}
          onClick={() => onDecide(false)}
          style={{
            ...decisionBtn,
            minWidth: 120,
            background: "var(--card)",
            color: "var(--state-error)",
            border:
              "1px solid color-mix(in srgb, var(--state-error) 50%, var(--line))",
            opacity: acting ? 0.6 : 1,
          }}
        >
          <Icon name="x" size={15} strokeWidth={2.6} /> Reject
        </button>
      </div>
    </div>
  );
}

const decisionBtn: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 7,
  minHeight: 44,
  padding: "0 18px",
  borderRadius: "var(--radius-md)",
  border: "none",
  cursor: "pointer",
  fontSize: "var(--text-body)",
  fontWeight: "var(--weight-semibold)",
};

/* ---------------- Non-approval paused hero (webhook / budget) ---------------- */
function PausedHero({
  label,
  sinceIso,
  waitingAge,
}: {
  label: string;
  sinceIso: string | null;
  waitingAge: string | null;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        background: "color-mix(in srgb, var(--state-paused) 8%, var(--card))",
        border:
          "1px solid color-mix(in srgb, var(--state-paused) 45%, var(--line))",
        borderRadius: "var(--radius-lg)",
        padding: 16,
      }}
    >
      <Icon name="clock" size={20} style={{ color: "var(--state-paused)" }} />
      <div>
        <div
          style={{
            fontSize: "var(--text-md)",
            fontWeight: "var(--weight-semibold)",
            color: "var(--ink)",
          }}
        >
          {label}
        </div>
        <div style={{ fontSize: "var(--text-sm)", color: "var(--ink-2)" }}>
          Paused
          {sinceIso ? ` since ${fmtWhen(sinceIso)}` : ""}
          {waitingAge ? ` · ${waitingAge}` : ""} — it'll resume on its own.
        </div>
      </div>
    </div>
  );
}

/* ---------------- One checklist row (real step state) ---------------- */
function ChecklistRow({
  step,
}: {
  step: {
    id: string;
    label: string;
    tint: string;
    state: StepState;
    duration: string | null;
  };
}) {
  const marker = markerFor(step.state, step.tint);
  const dim = step.state === "pending" || step.state === "skipped";
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "8px 10px",
      }}
    >
      {marker}
      <span
        style={{
          flex: 1,
          minWidth: 0,
          fontSize: "var(--text-body)",
          color: dim ? "var(--ink-3)" : "var(--ink)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {step.label}
      </span>
      {step.duration && (
        <span
          className="mono"
          style={{ fontSize: "var(--text-xs)", color: "var(--ink-3)" }}
        >
          {step.duration}
        </span>
      )}
    </div>
  );
}

function markerFor(state: StepState, tint: string) {
  const base: React.CSSProperties = {
    flex: "none",
    width: 22,
    height: 22,
    borderRadius: "var(--radius-full)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  };
  if (state === "done") {
    return (
      <span
        style={{
          ...base,
          background: "color-mix(in srgb, var(--state-done) 20%, transparent)",
          color: "var(--state-done)",
        }}
      >
        <Icon name="check" size={13} strokeWidth={3} />
      </span>
    );
  }
  if (state === "waiting" || state === "running") {
    const c =
      state === "waiting" ? "var(--state-paused)" : "var(--state-running)";
    return (
      <span
        style={{
          ...base,
          background: `color-mix(in srgb, ${c} 20%, transparent)`,
          color: c,
        }}
      >
        <Icon name={state === "waiting" ? "clock" : "bolt"} size={13} />
      </span>
    );
  }
  if (state === "error") {
    return (
      <span
        style={{
          ...base,
          background: "color-mix(in srgb, var(--state-error) 20%, transparent)",
          color: "var(--state-error)",
        }}
      >
        <Icon name="x" size={13} strokeWidth={2.6} />
      </span>
    );
  }
  // pending / skipped — dashed ring, not yet reached.
  return (
    <span
      style={{
        ...base,
        border: "1.5px dashed var(--line-2)",
        background: "transparent",
        color: tint,
      }}
    />
  );
}

/* ---------------- Empty state (never fabricate a run) ---------------- */
function EmptyRun({
  automationKey,
  name,
  graph,
  onStarted,
}: {
  automationKey: string;
  name: string;
  graph: GraphDef;
  onStarted: (runId: string) => void;
}) {
  const navigate = useNavigate();
  // Canvas links carry ?from= so the canvas's back control returns HERE.
  const canvasLink = useCanvasLink();
  const phone = useMediaQuery(PHONE_QUERY);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const order = stepOrder(graph);
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));

  async function test() {
    setBusy(true);
    setErr(null);
    try {
      const { workflowId } = await api.startExecution(automationKey);
      // Swap straight into the live run view for the run we just started.
      onStarted(workflowId);
    } catch {
      setErr("Couldn't start a test run — check your steps and AI connection.");
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        padding: phone ? "16px 16px 40px" : "22px 28px 40px",
        maxWidth: 720,
        animation: "naaryFadeUp .25s ease",
      }}
    >
      <button
        type="button"
        onClick={() => navigate("/app/automations")}
        style={{
          all: "unset",
          cursor: "pointer",
          fontSize: "var(--text-sm)",
          color: "var(--ink-2)",
        }}
      >
        ← Automations
      </button>
      <div
        style={{
          fontSize: "var(--text-title)",
          fontWeight: "var(--weight-bold)",
          color: "var(--ink)",
          letterSpacing: "var(--tracking-tight)",
          margin: "10px 0 4px",
        }}
      >
        {name}
      </div>
      <div
        style={{
          fontSize: "var(--text-body)",
          color: "var(--ink-2)",
          marginBottom: 18,
        }}
      >
        This automation hasn't run yet. Here are its steps — test it to see them
        light up.
      </div>

      <SectionLabel>Steps</SectionLabel>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 2,
          background: "var(--card)",
          border: "1px solid var(--line)",
          borderRadius: "var(--radius-lg)",
          boxShadow: "var(--shadow-card)",
          padding: 8,
        }}
      >
        {order.map((nid) => {
          const n = nodeById.get(nid);
          return (
            <ChecklistRow
              key={nid}
              step={{
                id: nid,
                label: n ? stepLabel(n) : nid,
                tint: n ? nodeTint(n.type) : "var(--ink-3)",
                state: "pending",
                duration: null,
              }}
            />
          );
        })}
      </div>

      {err && (
        <div
          style={{
            fontSize: "var(--text-sm)",
            color: "var(--state-error)",
            marginTop: 12,
          }}
        >
          {err}
        </div>
      )}
      <div
        style={{ display: "flex", gap: 10, marginTop: 18, flexWrap: "wrap" }}
      >
        <Button
          variant="primary"
          icon="play"
          loading={busy}
          disabled={busy}
          onClick={test}
        >
          {busy ? "Starting…" : "Test it"}
        </Button>
        <Button
          variant="secondary"
          icon="edit"
          onClick={() =>
            navigate(
              `/app/automations/${encodeURIComponent(automationKey)}/edit`,
            )
          }
        >
          Edit steps
        </Button>
        <Button
          variant="secondary"
          icon="workflow"
          onClick={() =>
            navigate(canvasLink(`/app/canvas?key=${encodeURIComponent(automationKey)}`))
          }
        >
          Open in Builder
        </Button>
      </div>
    </div>
  );
}

/* ---------------- shared bits ---------------- */
function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="mono"
      style={{
        fontSize: "var(--text-2xs)",
        letterSpacing: ".08em",
        fontWeight: "var(--weight-bold)",
        color: "var(--ink-3)",
        marginBottom: 8,
      }}
    >
      {children}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
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
          color: "var(--ink)",
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
