import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Button, Card, CodeBlock, Icon, StatusPill } from "../../components";
import {
  api,
  type ExecutionState,
  type RunEvent,
  UnauthorizedError,
} from "../../lib/api";
import { isTerminal, runStatusUi } from "../../lib/run-status";

export function RunDetail() {
  const { id = "" } = useParams();
  return (
    <div style={{ padding: "20px 28px 40px" }}>
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
  const [state, setState] = useState<ExecutionState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

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
          alignItems: "flex-start",
          justifyContent: "space-between",
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
              {running || awaiting
                ? "Polling GET /executions/:id every 1.5s"
                : "Final state · GET /executions/:id"}
            </div>
          </div>
        </div>
        {(awaiting || running) && (
          <div style={{ display: "flex", gap: 8 }}>
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

      {!error && loading && !state && (
        <Card>
          <div style={{ color: "var(--ink-3)", fontSize: "var(--text-body)" }}>
            Loading…
          </div>
        </Card>
      )}

      {!error && state && (
        <div
          style={{ display: "grid", gridTemplateColumns: "1.6fr 1fr", gap: 16 }}
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
                    <CodeBlock
                      style={{
                        fontSize: "var(--text-2xs)",
                        background: "var(--bg)",
                        maxHeight: 320,
                        overflow: "auto",
                      }}
                    >
                      {JSON.stringify(output, null, 2)}
                    </CodeBlock>
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

      {!error && state && <RunLog id={id} />}
    </>
  );
}

/* ---- Execution log: the run's curated Temporal history (durable record). ---- */
const LOG_KIND_COLOR: Record<string, string> = {
  started: "var(--state-info)",
  activity: "var(--node-agent)",
  signal: "var(--node-approval)",
  timer: "var(--state-paused)",
  completed: "var(--state-done)",
  error: "var(--state-error)",
  continued: "var(--ink-3)",
};

function RunLog({ id }: { id: string }) {
  const [events, setEvents] = useState<Awaited<
    ReturnType<typeof api.getRunHistory>
  > | null>(null);

  // Poll the history until a terminal event appears — the closing event can lag
  // the status flip, so a single fetch can miss it.
  useEffect(() => {
    let live = true;
    let t: ReturnType<typeof setTimeout>;
    const done = (evs: RunEvent[]) =>
      evs.some((e) => ["completed", "error", "continued"].includes(e.kind));
    const tick = async () => {
      try {
        const e = await api.getRunHistory(id);
        if (!live) return;
        setEvents(e);
        if (!done(e)) t = setTimeout(tick, 2000);
      } catch {
        if (live) t = setTimeout(tick, 2000);
      }
    };
    tick();
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [id]);

  return (
    <Card style={{ padding: "18px 20px", marginTop: 16 }}>
      <SectionTitle>Execution log</SectionTitle>
      {!events ? (
        <div style={{ color: "var(--ink-3)", fontSize: "var(--text-body)" }}>
          Loading…
        </div>
      ) : events.length === 0 ? (
        <div style={{ color: "var(--ink-3)", fontSize: "var(--text-body)" }}>
          No events yet.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
          {events.map((ev) => (
            <div
              key={ev.id}
              style={{
                display: "flex",
                alignItems: "baseline",
                gap: 10,
                padding: "6px 0",
                borderTop: "1px solid var(--line)",
              }}
            >
              <span
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: "50%",
                  flex: "none",
                  marginTop: 5,
                  background: LOG_KIND_COLOR[ev.kind] ?? "var(--ink-3)",
                }}
              />
              <span
                style={{
                  flex: 1,
                  fontSize: "var(--text-body)",
                  color: "var(--ink)",
                }}
              >
                {ev.label}
                {ev.detail && (
                  <span
                    className="mono"
                    style={{
                      color: "var(--ink-3)",
                      marginLeft: 8,
                      fontSize: "var(--text-xs)",
                    }}
                  >
                    {ev.detail}
                  </span>
                )}
              </span>
              <span
                className="mono"
                style={{
                  fontSize: "var(--text-2xs)",
                  color: "var(--ink-3)",
                  flex: "none",
                }}
              >
                {ev.at ? new Date(ev.at).toLocaleTimeString() : ""}
              </span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: "var(--text-md)",
        fontWeight: "var(--weight-semibold)",
        marginBottom: 16,
      }}
    >
      {children}
    </div>
  );
}

function SummaryRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        marginBottom: 11,
      }}
    >
      <span style={{ fontSize: "var(--text-sm)", color: "var(--ink-2)" }}>
        {label}
      </span>
      {children}
    </div>
  );
}
