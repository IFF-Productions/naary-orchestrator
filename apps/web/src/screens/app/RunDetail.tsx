import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import type { GraphDef } from "@naary/dsl";
import { Button, Card, Icon, LoadingBlock, StatusPill } from "../../components";
import { RunDiagram } from "../../components/RunDiagram";
import { api, type ExecutionState, UnauthorizedError } from "../../lib/api";
import { canDo } from "../../lib/permissions-logic";
import { isTerminal, runStatusUi } from "../../lib/run-status";
import { PHONE_QUERY, useMediaQuery } from "../../lib/useMediaQuery";
import { usePermissions } from "../../lib/usePermissions";
import { RerunMenu, VersionBadge } from "./RerunMenu";
import { NodeOutputBody } from "./run-detail/NodeOutputBody";
import { RegionTraceSection } from "./run-detail/RegionTraceSection";
import { RunLog } from "./run-detail/RunLog";
import { SectionTitle, SummaryRow } from "./run-detail/shared";
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

function formatCost(ctx: Record<string, unknown>): string {
  const c = ctx.__costUsd;
  return typeof c === "number" ? `$${c.toFixed(4)}` : "—";
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
  const [copied, setCopied] = useState(false);
  // The graph SNAPSHOT this run executed (immutable → fetched once). null while loading or if
  // the snapshot is unavailable (older runs) — the canvas section just doesn't render then.
  const [graph, setGraph] = useState<GraphDef | null>(null);
  // The executed graph's version + the run's workflowKey (for the re-run-at-version picker),
  // fetched alongside the snapshot. null until loaded / for pre-snapshot runs.
  const [runVersion, setRunVersion] = useState<number | null>(null);
  const [runWorkflowKey, setRunWorkflowKey] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Affordance gating (RBAC-GROUPS G2): re-run needs `run` on the workflow. Unknown key
  // (older runs) → keep the affordance; the server still enforces on the request.
  const perms = usePermissions();
  const mayRerun = !runWorkflowKey || canDo(perms, "run", runWorkflowKey);

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
    // isn't unmounted) never flashes — or keeps showing — the wrong run's canvas.
    setGraph(null);
    setRunVersion(null);
    setRunWorkflowKey(null);
    api.getRunGraph(id).then(
      (r) => {
        if (!cancelled) {
          setGraph(r.graph);
          setRunVersion(r.version);
          setRunWorkflowKey(r.workflowKey);
        }
      },
      (e) => {
        // A 404 is expected for pre-snapshot runs — skip the canvas silently. Anything else
        // (500, auth/routing) is unexpected: log it so a real failure is detectable, not hidden.
        if (!(e instanceof Error) || !/→ 404$/.test(e.message)) {
          console.warn("run-detail canvas: graph fetch failed", e);
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
  const ui = status ? runStatusUi(status) : null;

  const nodeOutputs = state
    ? Object.entries(state.ctx).filter(([k]) => isNodeOutputKey(k))
    : [];

  return (
    <>
      <div
        style={{
          display: "flex",
          // Phone: stack the run identity over its action buttons (they'd overflow side-by-side).
          flexDirection: phone ? "column" : "row",
          alignItems: phone ? "stretch" : "flex-start",
          justifyContent: "space-between",
          gap: phone ? 12 : 0,
          marginBottom: 18,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <span
            style={{
              width: 42,
              height: 42,
              borderRadius: "var(--radius-lg)",
              background: "var(--brand-soft)",
              border:
                "1px solid color-mix(in srgb, var(--brand) 40%, transparent)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flex: "none",
              color: "var(--brand)",
            }}
          >
            <Icon name="bolt" size={20} />
          </span>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span
                style={{
                  fontSize: "var(--text-title)",
                  fontWeight: "var(--weight-bold)",
                }}
              >
                Execution
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
              {ui && <StatusPill state={ui.state} label={ui.label} />}
            </div>
            <div
              style={{
                fontSize: "var(--text-sm)",
                color: "var(--ink-2)",
                marginTop: 4,
              }}
            >
              {running || awaiting || awaitingWebhook
                ? "Polling GET /executions/:id every 1.5s"
                : "Final state · GET /executions/:id"}
            </div>
          </div>
        </div>
        {(awaiting || running || awaitingWebhook) && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {awaiting && (
              <>
                <Button
                  variant="positive"
                  icon="check"
                  disabled={acting}
                  onClick={() => decide(true)}
                >
                  Approve
                </Button>
                <Button
                  variant="danger"
                  disabled={acting}
                  onClick={() => decide(false)}
                >
                  Reject
                </Button>
              </>
            )}
            <Button
              variant="secondary"
              icon="x"
              disabled={acting}
              onClick={cancelRun}
            >
              Cancel run
            </Button>
          </div>
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

      {error && (
        <Card
          style={{
            borderColor:
              "color-mix(in srgb, var(--state-error) 40%, transparent)",
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

      {awaitingWebhook && (
        <Card
          style={{
            borderColor: "color-mix(in srgb, var(--brand) 40%, transparent)",
            marginBottom: 16,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Icon name="bolt" size={16} />
            <span
              style={{
                fontSize: "var(--text-body)",
                fontWeight: "var(--weight-bold)",
              }}
            >
              Waiting for a webhook
            </span>
          </div>
          <p
            style={{
              fontSize: "var(--text-sm)",
              color: "var(--ink-2)",
              margin: "8px 0 12px",
            }}
          >
            This run is paused until an external system POSTs to its resume URL.
            The URL contains a signed token — anyone with it can resume the run,
            so treat it like a secret.
          </p>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <code
              className="mono"
              style={{
                flex: 1,
                overflowX: "auto",
                whiteSpace: "nowrap",
                fontSize: "var(--text-xs)",
                background: "var(--surface)",
                border: "1px solid var(--line)",
                borderRadius: "var(--radius-xs)",
                padding: "8px 10px",
                color: "var(--ink-1)",
              }}
            >
              {resumeUrl ?? "Loading resume URL…"}
            </code>
            <Button
              variant="secondary"
              icon={copied ? "check" : "copy"}
              disabled={!resumeUrl}
              onClick={() => {
                if (!resumeUrl) return;
                void navigator.clipboard?.writeText(resumeUrl);
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1500);
              }}
            >
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
        </Card>
      )}

      {!error && loading && !state && (
        <Card>
          <LoadingBlock label="Loading run…" />
        </Card>
      )}

      {/* Workflow canvas — the graph this run executed, with the path it took highlighted.
          Green = ran, ember/amber = the current step, dim = not reached. */}
      {!error && state && graph && (
        <Card style={{ padding: "16px 18px 14px", marginBottom: 16 }}>
          <SectionTitle>Workflow canvas</SectionTitle>
          <div
            style={{
              fontSize: "var(--text-2xs)",
              color: "var(--ink-3)",
              marginBottom: 10,
            }}
          >
            The graph this run executed — green nodes ran; the highlighted node
            is the current step; dimmed nodes weren't reached.
          </div>
          {/* The diagram lays out horizontally; scroll it on a narrow screen rather than clip. */}
          <div style={{ overflowX: "auto", maxWidth: "100%" }}>
            <RunDiagram
              graph={graph}
              ctx={state.ctx}
              currentNodeId={state.currentNodeId}
              status={state.status}
            />
          </div>
        </Card>
      )}

      {/* Run input — the payload that STARTED the run (webhook event, form submission,
          or manual input), held in ctx.__input. Hidden from Node outputs (which drops __*). */}
      {!error && state && state.ctx.__input !== undefined && (
        <Card style={{ padding: "18px 20px", marginBottom: 16 }}>
          <SectionTitle>Run input</SectionTitle>
          <div
            style={{
              fontSize: "var(--text-2xs)",
              color: "var(--ink-3)",
              marginBottom: 8,
            }}
          >
            The payload that started this run (trigger event / manual input).
          </div>
          <NodeOutputBody output={state.ctx.__input} />
        </Card>
      )}

      {!error && state && <UnresolvedInputsSection ctx={state.ctx} />}

      {!error && state && (
        <div
          style={{
            display: "grid",
            // Phone: stack "Node outputs" over the details column instead of squeezing two.
            // minmax(0, …) — NOT plain fr — so a track can shrink below its content's min-content.
            // Without it, a very long unbroken JSON line in a node output's <pre> forces the track
            // (and the page) wide instead of scrolling inside the code block.
            gridTemplateColumns: phone
              ? "minmax(0, 1fr)"
              : "minmax(0, 1.6fr) minmax(0, 1fr)",
            gap: 16,
          }}
        >
          {/* Node outputs — the real "what each node produced" view. */}
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
            <div
              className="mono"
              style={{
                marginTop: 14,
                paddingTop: 12,
                borderTop: "1px solid var(--line)",
                fontSize: "var(--text-2xs)",
                color: "var(--ink-3)",
              }}
            >
              live node outputs (ctx) · full event history below
            </div>
          </Card>

          {/* Run summary */}
          <Card>
            <SectionTitle>Run summary</SectionTitle>
            <SummaryRow label="Status">
              {ui ? <StatusPill state={ui.state} label={ui.label} /> : "—"}
            </SummaryRow>
            <SummaryRow label="Graph version">
              <VersionBadge version={runVersion} />
            </SummaryRow>
            {running && (
              <SummaryRow label="Current node">
                <span className="mono" style={{ fontSize: "var(--text-body)" }}>
                  {state.currentNodeId || "—"}
                </span>
              </SummaryRow>
            )}
            <SummaryRow label="Accumulated cost">
              <span
                className="mono"
                style={{
                  fontSize: "var(--text-body)",
                  color: "var(--state-done)",
                }}
              >
                {formatCost(state.ctx)}
              </span>
            </SummaryRow>
            <div
              style={{
                marginTop: 14,
                paddingTop: 13,
                borderTop: "1px solid var(--line)",
                display: "flex",
                alignItems: "center",
                gap: 7,
              }}
            >
              <span
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: "50%",
                  background: "var(--state-done)",
                }}
              />
              <span
                className="mono"
                style={{ fontSize: "var(--text-2xs)", color: "var(--ink-3)" }}
              >
                durable · state checkpointed · resumable for 30d
              </span>
            </div>
          </Card>
        </div>
      )}

      {!error && state && <RegionTraceSection ctx={state.ctx} />}
      {!error && state && <RunLog id={id} />}
    </>
  );
}
