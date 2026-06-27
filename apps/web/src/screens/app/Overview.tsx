import { type CSSProperties, type ReactNode, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  Card,
  Icon,
  ProgressBar,
  StatusPill,
  Table,
  type Column,
} from "../../components";
import {
  api,
  type BudgetView,
  type RunSummary,
  type UsageReport,
  UnauthorizedError,
} from "../../lib/api";
import { runStatusUi, successRate } from "../../lib/run-status";
import {
  RunVolumeChart as RealRunVolumeChart,
  SpendChart as RealSpendChart,
} from "./charts";

/* ------------------------------------------------------------------
 * Overview — the operator dashboard. Every number here comes from a
 * real control-plane call (runs / budget / usage); there is no mock
 * data. Sections degrade in place (showing "—" or an empty state) when
 * a dependency is missing or the request fails, mirroring LiveStrip.
 * ---------------------------------------------------------------- */

const cardStyle: CSSProperties = {
  background: "var(--card)",
  border: "1px solid var(--line)",
  borderRadius: 12,
  boxShadow: "var(--shadow-card)",
};

/* Palette cycled across the spend-by-model bars (purely presentational). */
const MODEL_COLORS = [
  "var(--node-agent)",
  "var(--state-info)",
  "var(--node-trigger)",
  "var(--state-done)",
  "var(--state-paused)",
];

/** Compact relative time from an ISO timestamp (no date lib). */
function ago(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const s = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

const usd = (n: number) => `$${n.toFixed(4)}`;

export function Overview() {
  const navigate = useNavigate();

  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [budget, setBudget] = useState<BudgetView | null>(null);
  const [usage, setUsage] = useState<UsageReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<"unauth" | "error" | null>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const me = await api.getMe();
        // Only getBudget may legitimately 404 (no budget configured) → null,
        // non-fatal. A real runs/usage failure still hits the outer catch.
        const [runsRes, budgetRes, usageRes] = await Promise.all([
          api.listRuns(),
          api.getBudget(me.tenantId).catch(() => null),
          api.getUsage(me.tenantId),
        ]);
        if (!live) return;
        setRuns(runsRes);
        setBudget(budgetRes);
        setUsage(usageRes);
      } catch (e) {
        if (live) setErr(e instanceof UnauthorizedError ? "unauth" : "error");
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  const runList = runs ?? [];
  const awaiting = runList.filter((r) => r.status === "awaiting_approval");
  const rate = successRate(runList.map((r) => r.status));

  const runColumns: Column<RunSummary>[] = [
    {
      key: "wf",
      header: "Workflow",
      render: (r) => (
        <span style={{ fontSize: 12.5, fontWeight: 500, color: "var(--ink)" }}>
          {r.workflowKey ?? r.workflowId}
        </span>
      ),
    },
    {
      key: "status",
      header: "Status",
      render: (r) => <StatusPill {...runStatusUi(r.status)} />,
    },
    {
      key: "cost",
      header: "Cost",
      render: (r) => (
        <span
          className="mono"
          style={{ fontSize: 11.5, color: "var(--ink-2)" }}
        >
          {r.costUsd === null ? "—" : usd(r.costUsd)}
        </span>
      ),
    },
    {
      key: "started",
      header: "Started",
      render: (r) => (
        <span className="mono" style={{ fontSize: 11, color: "var(--ink-3)" }}>
          {ago(r.startedAt)}
        </span>
      ),
    },
  ];

  const subline = err
    ? err === "unauth"
      ? "Set your API token on the sign-in screen to load data."
      : "Couldn't load dashboard data."
    : loading
      ? "Loading…"
      : `${runList.length} recent run${runList.length === 1 ? "" : "s"} · ${
          awaiting.length
        } awaiting approval`;

  return (
    <div style={{ padding: "24px 28px 40px", maxWidth: 1400 }}>
      {/* ---- header ---- */}
      <div
        style={{
          display: "flex",
          alignItems: "flex-end",
          justifyContent: "space-between",
          marginBottom: 20,
        }}
      >
        <div>
          <div
            style={{
              fontSize: 22,
              fontWeight: 700,
              color: "var(--ink)",
              letterSpacing: "-0.01em",
            }}
          >
            Overview
          </div>
          <div style={{ fontSize: 13, color: "var(--ink-2)", marginTop: 3 }}>
            {subline}
          </div>
        </div>
      </div>

      {/* ---- live metrics (real, from the control plane) ---- */}
      <LiveStrip />

      {/* ---- real charts (bucketed from runs + usage) ---- */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 14,
          marginBottom: 16,
        }}
      >
        <RealRunVolumeChart days={14} />
        <RealSpendChart days={14} />
      </div>

      {/* ---- stat cards (all real) ---- */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(4,1fr)",
          gap: 14,
          marginBottom: 16,
        }}
      >
        {/* Recent runs */}
        <div style={{ ...cardStyle, padding: "15px 16px" }}>
          <StatHead label="Recent runs" />
          <StatValue>
            {loading ? "…" : err ? "—" : runList.length.toLocaleString()}
          </StatValue>
        </div>

        {/* Success rate */}
        <div style={{ ...cardStyle, padding: "15px 16px" }}>
          <StatHead label="Success rate" />
          <StatValue>
            {rate === null ? (
              "—"
            ) : (
              <>
                {rate.toFixed(1)}
                <span style={{ fontSize: 16, color: "var(--ink-2)" }}>%</span>
              </>
            )}
          </StatValue>
          {rate !== null && (
            <div style={{ marginTop: 13 }}>
              <ProgressBar value={rate} color="var(--state-done)" />
            </div>
          )}
        </div>

        {/* Spend (MTD) */}
        <div style={{ ...cardStyle, padding: "15px 16px" }}>
          <StatHead label="Spend (MTD)">
            {budget && (
              <span
                className="mono"
                style={{
                  fontSize: 10,
                  color: "var(--ink-2)",
                  background: "var(--card-2)",
                  padding: "2px 6px",
                  borderRadius: 5,
                }}
              >
                ${Math.round(budget.monthlyCapUsd).toLocaleString()} cap
              </span>
            )}
          </StatHead>
          <StatValue>{budget ? usd(budget.mtdSpendUsd) : "—"}</StatValue>
          {budget && budget.monthlyCapUsd > 0 && (
            <div style={{ marginTop: 13 }}>
              <ProgressBar
                value={Math.min(
                  100,
                  (budget.mtdSpendUsd / budget.monthlyCapUsd) * 100,
                )}
                color="var(--state-info)"
              />
            </div>
          )}
        </div>

        {/* Awaiting approval */}
        <div
          style={{
            ...cardStyle,
            border:
              "1px solid color-mix(in srgb, var(--state-paused) 40%, var(--line))",
            padding: "15px 16px",
            position: "relative",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              position: "absolute",
              inset: 0,
              background: "var(--paused-soft)",
              pointerEvents: "none",
            }}
          />
          <div style={{ position: "relative" }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
              }}
            >
              <span style={{ fontSize: 12, color: "var(--ink-2)" }}>
                Awaiting approval
              </span>
              {awaiting.length > 0 && (
                <span
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: "50%",
                    background: "var(--state-paused)",
                    animation: "naaryBlink 1.5s infinite",
                  }}
                />
              )}
            </div>
            <StatValue>{loading ? "…" : err ? "—" : awaiting.length}</StatValue>
            {awaiting.length > 0 && (
              <Link
                to="/app/runs"
                style={{
                  marginTop: 11,
                  fontSize: 11.5,
                  fontWeight: 600,
                  color: "var(--state-paused)",
                  display: "flex",
                  alignItems: "center",
                  gap: 4,
                  textDecoration: "none",
                }}
              >
                Review queue
                <Icon name="chevron-right" size={12} strokeWidth={2} />
              </Link>
            )}
          </div>
        </div>
      </div>

      {/* ---- recent runs + approval queue ---- */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1.7fr 1fr",
          gap: 16,
          marginBottom: 16,
        }}
      >
        {/* Recent runs */}
        <Card pad={false} style={{ overflow: "hidden" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "16px 18px 12px",
            }}
          >
            <div style={{ fontSize: 14, fontWeight: 600, color: "var(--ink)" }}>
              Recent runs
            </div>
            <Link
              to="/app/runs"
              style={{
                fontSize: 11.5,
                color: "var(--ink-2)",
                textDecoration: "none",
              }}
            >
              View all runs
            </Link>
          </div>
          {runList.length === 0 ? (
            <EmptyRow>
              {loading ? "Loading…" : err ? "—" : "No runs yet."}
            </EmptyRow>
          ) : (
            <Table
              rowKey={(r) => r.workflowId}
              columns={runColumns}
              rows={runList.slice(0, 6)}
              onRowClick={(r) => navigate(`/app/runs/${r.workflowId}`)}
            />
          )}
        </Card>

        {/* Approval queue */}
        <div
          style={{
            ...cardStyle,
            padding: 18,
            display: "flex",
            flexDirection: "column",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: 14,
            }}
          >
            <div
              style={{
                fontSize: 14,
                fontWeight: 600,
                color: "var(--ink)",
                display: "flex",
                alignItems: "center",
                gap: 8,
              }}
            >
              Approval queue
              {awaiting.length > 0 && (
                <span
                  className="mono"
                  style={{
                    fontSize: 10,
                    fontWeight: 600,
                    color: "var(--state-paused)",
                    background: "var(--paused-soft)",
                    padding: "2px 7px",
                    borderRadius: 5,
                  }}
                >
                  {awaiting.length}
                </span>
              )}
            </div>
            <Link
              to="/app/runs"
              style={{
                fontSize: 11.5,
                color: "var(--ink-2)",
                textDecoration: "none",
              }}
            >
              View all
            </Link>
          </div>
          {awaiting.length === 0 ? (
            <div
              style={{
                fontSize: 12.5,
                color: "var(--ink-3)",
                padding: "20px 0",
                textAlign: "center",
              }}
            >
              {loading ? "Loading…" : "Nothing awaiting approval."}
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
              {awaiting.map((item) => (
                <Link
                  key={item.workflowId}
                  to={`/app/runs/${item.workflowId}`}
                  style={{
                    border: "1px solid var(--line)",
                    borderRadius: 9,
                    padding: 11,
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    textDecoration: "none",
                  }}
                >
                  <ApprovalIcon />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: 12.5,
                        fontWeight: 600,
                        color: "var(--ink)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {item.workflowKey ?? item.workflowId}
                    </div>
                    <div
                      className="mono"
                      style={{ fontSize: 10, color: "var(--ink-3)" }}
                    >
                      waiting {ago(item.startedAt)}
                    </div>
                  </div>
                  <Icon
                    name="chevron-right"
                    size={14}
                    strokeWidth={1.9}
                    style={{ color: "var(--ink-3)" }}
                  />
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ---- spend by model ---- */}
      <div style={{ ...cardStyle, padding: 18 }}>
        <div
          style={{
            fontSize: 14,
            fontWeight: 600,
            color: "var(--ink)",
            marginBottom: 4,
          }}
        >
          Spend by model
        </div>
        <div
          style={{ fontSize: 11.5, color: "var(--ink-3)", marginBottom: 16 }}
        >
          {usage ? `This month · ${usd(usage.totalCostUsd)} total` : "—"}
        </div>
        {!usage || usage.byModel.length === 0 ? (
          <div
            style={{
              fontSize: 12.5,
              color: "var(--ink-3)",
              padding: "12px 0",
            }}
          >
            {loading ? "Loading…" : "No usage recorded yet."}
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {usage.byModel.map((m, i) => {
              const pct =
                usage.totalCostUsd > 0
                  ? (m.costUsd / usage.totalCostUsd) * 100
                  : 0;
              return (
                <div key={`${m.provider}:${m.model}`}>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      fontSize: 12,
                      marginBottom: 5,
                    }}
                  >
                    <span style={{ color: "var(--ink)", fontWeight: 500 }}>
                      {m.model}
                    </span>
                    <span className="mono" style={{ color: "var(--ink-2)" }}>
                      {usd(m.costUsd)}
                    </span>
                  </div>
                  <ProgressBar
                    value={pct}
                    color={MODEL_COLORS[i % MODEL_COLORS.length]}
                  />
                </div>
              );
            })}
          </div>
        )}
        {budget && (
          <div
            style={{
              marginTop: 18,
              paddingTop: 15,
              borderTop: "1px solid var(--line)",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
            }}
          >
            <span style={{ fontSize: 12, color: "var(--ink-2)" }}>
              Remaining this month
            </span>
            <span
              className="mono"
              style={{ fontSize: 13, fontWeight: 600, color: "var(--ink)" }}
            >
              {usd(budget.remainingUsd)}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------------- local presentational helpers ---------------- */

/** Real metrics from the control plane: tenant, recent run count, usage cost +
 *  tokens (usage ledger). Renders alongside the stat cards below. */
function LiveStrip() {
  const [tenant, setTenant] = useState<string | null>(null);
  const [runCount, setRunCount] = useState<number | null>(null);
  const [cost, setCost] = useState<number | null>(null);
  const [tokens, setTokens] = useState<number | null>(null);
  const [err, setErr] = useState(false);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const me = await api.getMe();
        if (!live) return;
        setTenant(me.tenantId);
        const [runs, usage] = await Promise.all([
          api.listRuns(),
          api.getUsage(me.tenantId),
        ]);
        if (!live) return;
        setRunCount(runs.length);
        setCost(usage.totalCostUsd);
        setTokens(usage.totalTokens);
      } catch {
        if (live) setErr(true);
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  const fmt = (n: number | null) => (n === null ? "…" : n.toLocaleString());

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(4,1fr)",
        gap: 14,
        marginBottom: 16,
      }}
    >
      <LiveCard label="Tenant" value={err ? "—" : (tenant ?? "…")} mono />
      <LiveCard label="Recent runs" value={err ? "—" : fmt(runCount)} />
      <LiveCard
        label="Spend (USD)"
        value={err ? "—" : cost === null ? "…" : `$${cost.toFixed(4)}`}
      />
      <LiveCard label="Tokens" value={err ? "—" : fmt(tokens)} />
    </div>
  );
}

function LiveCard({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div style={{ ...cardStyle, padding: "15px 16px" }}>
      <div
        style={{
          fontSize: 10,
          fontWeight: 600,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: "var(--ink-3)",
        }}
      >
        {label} · live
      </div>
      <div
        className={mono ? "mono" : undefined}
        style={{
          fontSize: mono ? 15 : 24,
          fontWeight: 700,
          color: "var(--ink)",
          marginTop: 8,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {value}
      </div>
    </div>
  );
}

function StatHead({
  label,
  children,
}: {
  label: string;
  children?: ReactNode;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        minHeight: 18,
      }}
    >
      <span style={{ fontSize: 12, color: "var(--ink-2)" }}>{label}</span>
      {children}
    </div>
  );
}

function StatValue({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        fontSize: 27,
        fontWeight: 700,
        color: "var(--ink)",
        marginTop: 8,
        letterSpacing: "-0.02em",
      }}
    >
      {children}
    </div>
  );
}

function EmptyRow({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        padding: "20px 18px 24px",
        fontSize: 12.5,
        color: "var(--ink-3)",
      }}
    >
      {children}
    </div>
  );
}

function ApprovalIcon() {
  return (
    <span
      style={{
        width: 22,
        height: 22,
        borderRadius: 6,
        background: "color-mix(in srgb, var(--node-approval) 18%, transparent)",
        color: "var(--node-approval)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flex: "none",
      }}
    >
      <Icon name="approval" size={12} strokeWidth={1.7} />
    </span>
  );
}
