import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useState,
} from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  Button,
  Card,
  type Column,
  Icon,
  ProgressBar,
  StatusPill,
  Table,
} from "../../components";
import {
  api,
  type BudgetView,
  type DashboardItem,
  type RunSummary,
  type UsageReport,
  UnauthorizedError,
} from "../../lib/api";
import { runStatusUi, successRate } from "../../lib/run-status";
import {
  RunVolumeChart as RealRunVolumeChart,
  SpendChart as RealSpendChart,
} from "./charts";
import { DashboardGrid, type WidgetMeta } from "./DashboardGrid";

/* ------------------------------------------------------------------
 * Overview — the operator dashboard. Every number here comes from a
 * real control-plane call (runs / budget / usage); there is no mock
 * data. It's a CUSTOMIZABLE grid: the user can reorder, resize, and
 * hide widgets, persisted per-user via /me/preferences (mirrored to
 * localStorage for an instant paint). Sections degrade in place
 * (showing "—" or an empty state) when a dependency is missing.
 * ---------------------------------------------------------------- */

const cardStyle: CSSProperties = {
  background: "var(--card)",
  border: "1px solid var(--line)",
  borderRadius: "var(--radius-lg)",
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

/* --- Customizable dashboard: the widget registry + default arrangement --- */
const WIDGETS: WidgetMeta[] = [
  { id: "metrics", title: "Live metrics" },
  { id: "charts", title: "Run volume & spend" },
  { id: "stats", title: "Key stats" },
  { id: "recent-runs", title: "Recent runs" },
  { id: "approvals", title: "Approval queue" },
  { id: "spend", title: "Spend by model" },
];
const DEFAULT_LAYOUT: DashboardItem[] = [
  { id: "metrics", hidden: false, span: 12 },
  { id: "charts", hidden: false, span: 12 },
  { id: "stats", hidden: false, span: 12 },
  { id: "recent-runs", hidden: false, span: 8 },
  { id: "approvals", hidden: false, span: 4 },
  { id: "spend", hidden: false, span: 12 },
];
const DASH_STORAGE_KEY = "naary.dashboard";

/** Reconcile a saved layout with the current registry: keep the user's order/size/
 *  visibility for widgets that still exist, drop unknown ids, and append any NEW widgets
 *  (so a shipped widget shows up instead of silently missing). */
function mergeLayout(saved: DashboardItem[] | null): DashboardItem[] {
  if (!saved || saved.length === 0) return DEFAULT_LAYOUT;
  const known = new Set(WIDGETS.map((w) => w.id));
  const kept = saved.filter((i) => known.has(i.id));
  const present = new Set(kept.map((i) => i.id));
  const missing = DEFAULT_LAYOUT.filter((d) => !present.has(d.id));
  return [...kept, ...missing];
}

function readStoredLayout(): DashboardItem[] | null {
  try {
    const raw = localStorage.getItem(DASH_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as DashboardItem[]) : null;
  } catch {
    return null;
  }
}

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

const usd = (n: number) =>
  `$${n.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: n > 0 && n < 1 ? 4 : 2,
  })}`;

export function Overview() {
  const navigate = useNavigate();

  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [budget, setBudget] = useState<BudgetView | null>(null);
  const [usage, setUsage] = useState<UsageReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<"unauth" | "error" | null>(null);

  // Customizable layout: seed from localStorage for an instant paint, reconcile with the
  // server copy on mount, and persist every change (localStorage + fire-and-forget PUT).
  const [layout, setLayout] = useState<DashboardItem[]>(() =>
    mergeLayout(readStoredLayout()),
  );
  const [customizing, setCustomizing] = useState(false);

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

  useEffect(() => {
    let live = true;
    api
      .getPreferences()
      .then((p) => {
        if (live && p.dashboard) setLayout(mergeLayout(p.dashboard));
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  const applyLayout = useCallback((next: DashboardItem[]) => {
    setLayout(next);
    try {
      localStorage.setItem(DASH_STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* ignore quota / private-mode */
    }
    void api.saveDashboard(next).catch(() => undefined);
  }, []);

  const runList = runs ?? [];
  const awaiting = runList.filter((r) => r.status === "awaiting_approval");
  const rate = successRate(runList.map((r) => r.status));

  const runColumns: Column<RunSummary>[] = [
    {
      key: "wf",
      header: "Workflow",
      render: (r) => (
        <span
          style={{
            fontSize: "var(--text-body)",
            fontWeight: "var(--weight-medium)",
            color: "var(--ink)",
          }}
        >
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
          style={{ fontSize: "var(--text-xs)", color: "var(--ink-2)" }}
        >
          {r.costUsd === null ? "—" : usd(r.costUsd)}
        </span>
      ),
    },
    {
      key: "started",
      header: "Started",
      render: (r) => (
        <span
          className="mono"
          style={{ fontSize: "var(--text-xs)", color: "var(--ink-3)" }}
        >
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

  /** One widget's content, by id — drawn by the DashboardGrid in the user's order. */
  const renderWidget = (id: string): ReactNode => {
    switch (id) {
      case "metrics":
        return <LiveStrip />;

      case "charts":
        return (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 14,
            }}
          >
            <RealRunVolumeChart days={14} />
            <RealSpendChart days={14} />
          </div>
        );

      case "stats":
        return (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
              gap: 14,
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
                    <span
                      style={{
                        fontSize: "var(--text-lg)",
                        color: "var(--ink-2)",
                      }}
                    >
                      %
                    </span>
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
                      fontSize: "var(--text-2xs)",
                      color: "var(--ink-2)",
                      background: "var(--card-2)",
                      padding: "2px 6px",
                      borderRadius: "var(--radius-xs)",
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
                  <span
                    className="mono"
                    style={{
                      fontSize: "var(--text-2xs)",
                      fontWeight: "var(--weight-semibold)",
                      letterSpacing: "var(--tracking-label)",
                      textTransform: "uppercase",
                      color: "var(--ink-3)",
                    }}
                  >
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
                <StatValue>
                  {loading ? "…" : err ? "—" : awaiting.length}
                </StatValue>
                {awaiting.length > 0 && (
                  <Link
                    to="/app/runs"
                    style={{
                      marginTop: 12,
                      fontSize: "var(--text-xs)",
                      fontWeight: "var(--weight-semibold)",
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
        );

      case "recent-runs":
        return (
          <Card pad={false} style={{ overflow: "hidden" }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "16px 18px 12px",
              }}
            >
              <div
                style={{
                  fontSize: "var(--text-md)",
                  fontWeight: "var(--weight-semibold)",
                  color: "var(--ink)",
                }}
              >
                Recent runs
              </div>
              <Link
                to="/app/runs"
                style={{
                  fontSize: "var(--text-xs)",
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
        );

      case "approvals":
        return (
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
                  fontSize: "var(--text-md)",
                  fontWeight: "var(--weight-semibold)",
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
                      fontSize: "var(--text-2xs)",
                      fontWeight: "var(--weight-semibold)",
                      color: "var(--state-paused)",
                      background: "var(--paused-soft)",
                      padding: "2px 7px",
                      borderRadius: "var(--radius-xs)",
                    }}
                  >
                    {awaiting.length}
                  </span>
                )}
              </div>
              <Link
                to="/app/runs"
                style={{
                  fontSize: "var(--text-xs)",
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
                  fontSize: "var(--text-body)",
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
                    className="run-row"
                    style={{
                      border: "1px solid var(--line)",
                      borderRadius: "var(--radius-md)",
                      padding: 12,
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
                          fontSize: "var(--text-body)",
                          fontWeight: "var(--weight-semibold)",
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
                        style={{
                          fontSize: "var(--text-2xs)",
                          color: "var(--ink-3)",
                        }}
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
        );

      case "spend":
        return (
          <div style={{ ...cardStyle, padding: 18 }}>
            <div
              style={{
                fontSize: "var(--text-md)",
                fontWeight: "var(--weight-semibold)",
                color: "var(--ink)",
                marginBottom: 4,
              }}
            >
              Spend by model
            </div>
            <div
              style={{
                fontSize: "var(--text-xs)",
                color: "var(--ink-3)",
                marginBottom: 16,
              }}
            >
              {usage ? `This month · ${usd(usage.totalCostUsd)} total` : "—"}
            </div>
            {!usage || usage.byModel.length === 0 ? (
              <div
                style={{
                  fontSize: "var(--text-body)",
                  color: "var(--ink-3)",
                  padding: "12px 0",
                }}
              >
                {loading ? "Loading…" : "No usage recorded yet."}
              </div>
            ) : (
              <div
                style={{ display: "flex", flexDirection: "column", gap: 14 }}
              >
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
                          fontSize: "var(--text-sm)",
                          marginBottom: 6,
                        }}
                      >
                        <span
                          style={{
                            color: "var(--ink)",
                            fontWeight: "var(--weight-medium)",
                          }}
                        >
                          {m.model}
                        </span>
                        <span
                          className="mono"
                          style={{ color: "var(--ink-2)" }}
                        >
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
                  marginTop: 20,
                  paddingTop: 16,
                  borderTop: "1px solid var(--line)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                }}
              >
                <span
                  style={{ fontSize: "var(--text-sm)", color: "var(--ink-2)" }}
                >
                  Remaining this month
                </span>
                <span
                  className="mono"
                  style={{
                    fontSize: "var(--text-body)",
                    fontWeight: "var(--weight-semibold)",
                    color: "var(--ink)",
                  }}
                >
                  {usd(budget.remainingUsd)}
                </span>
              </div>
            )}
          </div>
        );

      default:
        return null;
    }
  };

  return (
    <div style={{ padding: "24px 28px 40px", maxWidth: 1400 }}>
      {/* ---- header ---- */}
      <div
        style={{
          display: "flex",
          alignItems: "flex-end",
          justifyContent: "space-between",
          gap: 12,
          marginBottom: 20,
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
            Overview
          </div>
          <div
            style={{
              fontSize: "var(--text-body)",
              color: "var(--ink-2)",
              marginTop: 4,
            }}
          >
            {customizing
              ? "Drag to reorder · width button to resize · eye to hide"
              : subline}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, flex: "none" }}>
          {customizing && (
            <Button
              variant="ghost"
              icon="refresh"
              onClick={() => applyLayout(DEFAULT_LAYOUT)}
            >
              Reset
            </Button>
          )}
          <Button
            variant={customizing ? "primary" : "secondary"}
            icon={customizing ? "check" : "settings"}
            onClick={() => setCustomizing((v) => !v)}
          >
            {customizing ? "Done" : "Customize"}
          </Button>
        </div>
      </div>

      <DashboardGrid
        layout={layout}
        widgets={WIDGETS}
        customizing={customizing}
        render={renderWidget}
        onChange={applyLayout}
      />
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
        gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
        gap: 14,
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
          fontSize: "var(--text-2xs)",
          fontWeight: "var(--weight-semibold)",
          letterSpacing: "var(--tracking-label)",
          textTransform: "uppercase",
          color: "var(--ink-3)",
        }}
      >
        {label} · live
      </div>
      <div
        className={mono ? "mono" : undefined}
        style={{
          fontSize: mono ? "var(--text-lg)" : "var(--text-xl)",
          fontWeight: "var(--weight-bold)",
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
      <span
        className="mono"
        style={{
          fontSize: "var(--text-2xs)",
          fontWeight: "var(--weight-semibold)",
          letterSpacing: "var(--tracking-label)",
          textTransform: "uppercase",
          color: "var(--ink-3)",
        }}
      >
        {label}
      </span>
      {children}
    </div>
  );
}

function StatValue({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        fontSize: "var(--text-xl)",
        fontWeight: "var(--weight-bold)",
        color: "var(--ink)",
        marginTop: 8,
        letterSpacing: "var(--tracking-tight)",
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
        fontSize: "var(--text-body)",
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
        borderRadius: "var(--radius-xs)",
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
