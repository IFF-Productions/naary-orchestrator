import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Button, Card, CodeBlock, Icon, StatusPill } from "../../components";
import type { RunState } from "../../components";
import {
  api,
  statusToRunState,
  type ExecutionState,
  type ExecutionStatus,
} from "../../lib/api";

export function RunDetail() {
  const { id = "" } = useParams();
  const isLive = !id.startsWith("rs_");
  return (
    <div style={{ padding: "20px 28px 40px" }}>
      <BackLink />
      {isLive ? <LiveRun id={id} /> : <MockRun />}
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
        fontSize: 12,
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

/* ------------- Live run: polls the real control plane ------------- */
function LiveRun({ id }: { id: string }) {
  const [state, setState] = useState<ExecutionState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [acting, setActing] = useState(false);

  const poll = useCallback(async () => {
    try {
      setState(await api.getState(id));
      setError(null);
    } catch {
      setError("Could not reach the control plane (apps/api on :3000).");
    }
  }, [id]);

  useEffect(() => {
    poll();
    const t = setInterval(poll, 1500);
    return () => clearInterval(t);
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

  const status: ExecutionStatus | undefined = state?.status;
  const runState: RunState = status ? statusToRunState(status) : "idle";
  const awaiting = status === "awaiting_approval";

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
              borderRadius: 11,
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
              <span style={{ fontSize: 19, fontWeight: 700 }}>
                Live execution
              </span>
              <span
                className="mono"
                style={{
                  fontSize: 11,
                  color: "var(--ink-2)",
                  background: "var(--surface)",
                  border: "1px solid var(--line)",
                  padding: "2px 8px",
                  borderRadius: 6,
                }}
              >
                {id}
              </span>
            </div>
            <div style={{ fontSize: 12, color: "var(--ink-2)", marginTop: 4 }}>
              Polling GET /executions/:id every 1.5s
            </div>
          </div>
        </div>
        {awaiting && (
          <div style={{ display: "flex", gap: 9 }}>
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
          <span style={{ color: "var(--state-error)", fontSize: 12.5 }}>
            {error}
          </span>
        </Card>
      )}

      {!error && (
        <div
          style={{ display: "grid", gridTemplateColumns: "1.6fr 1fr", gap: 16 }}
        >
          <Card>
            <SectionTitle>Live state</SectionTitle>
            {state ? (
              <CodeBlock>{JSON.stringify(state.ctx, null, 2)}</CodeBlock>
            ) : (
              <div style={{ color: "var(--ink-3)", fontSize: 12.5 }}>
                Loading…
              </div>
            )}
          </Card>
          <Card>
            <SectionTitle>Run summary</SectionTitle>
            <SummaryRow label="Status">
              {status ? (
                <StatusPill state={runState} label={prettyStatus(status)} />
              ) : (
                "—"
              )}
            </SummaryRow>
            <SummaryRow label="Current node">
              <span className="mono" style={{ fontSize: 12.5 }}>
                {state?.currentNodeId ?? "—"}
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
                style={{ fontSize: 10.5, color: "var(--ink-3)" }}
              >
                durable · state checkpointed · resumable for 30d
              </span>
            </div>
          </Card>
        </div>
      )}
    </>
  );
}

function prettyStatus(s: ExecutionStatus): string {
  return (
    {
      running: "Running",
      awaiting_approval: "Paused",
      completed: "Done",
      rejected: "Rejected",
      budget_exceeded: "Budget exceeded",
      circuit_open: "Circuit open",
    } as Record<ExecutionStatus, string>
  )[s];
}

/* ------------- Mock run: the reference detail design ------------- */
const TIMELINE: {
  title: string;
  meta: string;
  t: string;
  state: "done" | "awaiting" | "pending";
  output?: string;
}[] = [
  {
    title: "Email received",
    meta: "webhook · POST /hooks/inbound",
    t: "0ms",
    state: "done",
  },
  {
    title: "Classify email",
    meta: "agent · opus 4.8 · 1,840 tok · $0.0091",
    t: "1.2s",
    state: "done",
    output: 'output {\n  category: "refund_request",\n  confidence: 0.94\n}',
  },
  {
    title: "Route by category",
    meta: "router · matched refund_request",
    t: "4ms",
    state: "done",
  },
  {
    title: "Approve refund",
    meta: "human approval · $48.00 · order #A-29183",
    t: "AWAITING · 2h 14m",
    state: "awaiting",
  },
  {
    title: "Ticket resolved",
    meta: "end · awaiting upstream",
    t: "pending",
    state: "pending",
  },
];

function MockRun() {
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
              borderRadius: 11,
              background: "var(--paused-soft)",
              border:
                "1px solid color-mix(in srgb, var(--state-paused) 40%, transparent)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flex: "none",
              color: "var(--state-paused)",
            }}
          >
            <Icon name="clock" size={20} />
          </span>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontSize: 19, fontWeight: 700 }}>
                Email triage &amp; refunds
              </span>
              {["rs_8f3a", "v14"].map((b) => (
                <span
                  key={b}
                  className="mono"
                  style={{
                    fontSize: 11,
                    color: "var(--ink-2)",
                    background: "var(--surface)",
                    border: "1px solid var(--line)",
                    padding: "2px 8px",
                    borderRadius: 6,
                  }}
                >
                  {b}
                </span>
              ))}
            </div>
            <div style={{ fontSize: 12, color: "var(--ink-2)", marginTop: 4 }}>
              Triggered by webhook · started 2h 14m ago · checkpoint #4
            </div>
          </div>
        </div>
        <div style={{ display: "flex", gap: 9 }}>
          <Button icon="edit">Open in canvas</Button>
          <Button variant="positive" icon="check">
            Approve refund
          </Button>
          <Button variant="danger">Reject</Button>
        </div>
      </div>

      <div
        style={{ display: "grid", gridTemplateColumns: "1.6fr 1fr", gap: 16 }}
      >
        {/* timeline */}
        <Card style={{ padding: "18px 20px" }}>
          <SectionTitle>Execution timeline</SectionTitle>
          <div style={{ position: "relative", paddingLeft: 24 }}>
            <div
              style={{
                position: "absolute",
                left: 8,
                top: 6,
                bottom: 14,
                width: 1.5,
                background: "var(--line-2)",
              }}
            />
            {TIMELINE.map((step, i) => (
              <div
                key={i}
                style={{
                  position: "relative",
                  marginBottom: i < TIMELINE.length - 1 ? 16 : 0,
                }}
              >
                <TimelineDot state={step.state} />
                {step.state === "awaiting" ? (
                  <div
                    style={{
                      background: "var(--paused-soft)",
                      border:
                        "1px solid color-mix(in srgb, var(--state-paused) 38%, transparent)",
                      borderRadius: 9,
                      padding: "11px 12px",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                      }}
                    >
                      <span style={{ fontSize: 13, fontWeight: 600 }}>
                        {step.title}
                      </span>
                      <span
                        className="mono"
                        style={{
                          fontSize: 10,
                          fontWeight: 600,
                          color: "#e9c281",
                        }}
                      >
                        {step.t}
                      </span>
                    </div>
                    <div
                      className="mono"
                      style={{
                        fontSize: 10.5,
                        color: "var(--ink-2)",
                        marginTop: 5,
                      }}
                    >
                      {step.meta}
                    </div>
                    <div style={{ display: "flex", gap: 7, marginTop: 10 }}>
                      <Button variant="positive" size="sm">
                        Approve
                      </Button>
                      <Button variant="danger" size="sm">
                        Reject
                      </Button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                      }}
                    >
                      <span
                        style={{
                          fontSize: 13,
                          fontWeight: 500,
                          color:
                            step.state === "pending"
                              ? "var(--ink-3)"
                              : "var(--ink)",
                        }}
                      >
                        {step.title}
                      </span>
                      <span
                        className="mono"
                        style={{ fontSize: 11, color: "var(--ink-3)" }}
                      >
                        {step.t}
                      </span>
                    </div>
                    <div
                      className="mono"
                      style={{
                        fontSize: 10.5,
                        color: "var(--ink-3)",
                        marginTop: 2,
                      }}
                    >
                      {step.meta}
                    </div>
                    {step.output && (
                      <CodeBlock
                        style={{
                          marginTop: 8,
                          fontSize: 10.5,
                          background: "var(--bg)",
                        }}
                      >
                        {step.output}
                      </CodeBlock>
                    )}
                  </>
                )}
              </div>
            ))}
          </div>
        </Card>

        {/* summary + payload */}
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <Card>
            <SectionTitle>Run summary</SectionTitle>
            <SummaryRow label="Status">
              <StatusPill state="paused" label="Paused" />
            </SummaryRow>
            <SummaryRow label="Step">
              <Mono>4 / 5</Mono>
            </SummaryRow>
            <SummaryRow label="Accumulated cost">
              <span
                className="mono"
                style={{ fontSize: 12.5, color: "#7fc99a" }}
              >
                $0.0142
              </span>
            </SummaryRow>
            <SummaryRow label="Tokens">
              <Mono>3,240</Mono>
            </SummaryRow>
            <SummaryRow label="Waiting">
              <Mono>2h 14m</Mono>
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
                style={{ fontSize: 10.5, color: "var(--ink-3)" }}
              >
                durable · state checkpointed · resumable for 30d
              </span>
            </div>
          </Card>
          <Card>
            <SectionTitle small>Trigger payload</SectionTitle>
            <CodeBlock style={{ background: "var(--bg)", fontSize: 10.5 }}>
              {`{
  from: "m.alvarez@…",
  subject: "Double charge",
  amount: 48.00
}`}
            </CodeBlock>
          </Card>
        </div>
      </div>
    </>
  );
}

function TimelineDot({ state }: { state: "done" | "awaiting" | "pending" }) {
  const common: React.CSSProperties = {
    position: "absolute",
    left: -24,
    top: 0,
    width: 17,
    height: 17,
    borderRadius: "50%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  };
  if (state === "done")
    return (
      <span style={{ ...common, background: "var(--state-done)" }}>
        <Icon
          name="check"
          size={10}
          strokeWidth={3}
          style={{ color: "#08120c" }}
        />
      </span>
    );
  if (state === "awaiting")
    return (
      <span
        className="mono"
        style={{
          ...common,
          background: "var(--state-paused)",
          fontSize: 10,
          fontWeight: 700,
          color: "#1a1305",
          animation: "naaryBlink 1.4s infinite",
        }}
      >
        ◷
      </span>
    );
  return (
    <span
      style={{
        ...common,
        background: "transparent",
        border: "1.5px solid var(--line-2)",
      }}
    />
  );
}

function SectionTitle({
  children,
  small,
}: {
  children: React.ReactNode;
  small?: boolean;
}) {
  return (
    <div
      style={{
        fontSize: small ? 13 : 14,
        fontWeight: 600,
        marginBottom: small ? 11 : 16,
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
      <span style={{ fontSize: 12, color: "var(--ink-2)" }}>{label}</span>
      {children}
    </div>
  );
}

function Mono({ children }: { children: React.ReactNode }) {
  return (
    <span className="mono" style={{ fontSize: 12.5, color: "var(--ink)" }}>
      {children}
    </span>
  );
}
