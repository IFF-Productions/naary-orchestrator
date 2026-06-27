import { type CSSProperties, type ReactNode, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  Button,
  Card,
  Icon,
  ProgressBar,
  StatusPill,
  Table,
  type Column,
} from "../../components";
import { api } from "../../lib/api";
import { runs, type RunRow } from "../../lib/mock";

/* ------------------------------------------------------------------
 * Overview — the operator dashboard. Ported faithfully from the
 * product design (Naary.dc.html, the `scr.dashboard` screen).
 *
 * Data not present in lib/mock.ts (approval queue items, spend-by-model
 * breakdown, the headline stats / chart series) is defined locally here.
 * Recent runs reuse the shared `runs` mock by id so costs + statuses
 * match the design exactly.
 * ---------------------------------------------------------------- */

/* The five "recent runs" the design highlights, pulled from the shared mock. */
const RECENT_RUN_IDS = ["rs_8f3a", "rs_8f29", "rs_8f10", "rs_8ee0", "rs_8ed2"];
const byId = new Map(runs.map((r) => [r.id, r]));
const recentRuns: RunRow[] = RECENT_RUN_IDS.map((id) => byId.get(id)).filter(
  (r): r is RunRow => Boolean(r),
);

interface ApprovalItem {
  title: string;
  meta: string;
  primary?: boolean;
  runId: string;
}
const approvalQueue: ApprovalItem[] = [
  {
    title: "Approve refund · $48.00",
    meta: "Email triage · waiting 2h 14m",
    primary: true,
    runId: "rs_8f3a",
  },
  {
    title: "Publish blog draft",
    meta: "Content pipeline · 41m",
    runId: "rs_8ed2",
  },
  {
    title: "Escalate ticket #4821",
    meta: "Support router · 1h 06m",
    runId: "rs_8ef7",
  },
];

interface ModelSpend {
  name: string;
  amount: string;
  pct: number;
  color: string;
}
const spendByModel: ModelSpend[] = [
  {
    name: "Claude Sonnet 4.5",
    amount: "$742",
    pct: 58,
    color: "var(--node-agent)",
  },
  { name: "GPT-4o", amount: "$318", pct: 25, color: "var(--state-info)" },
  { name: "Gemini 2.5", amount: "$144", pct: 11, color: "var(--node-trigger)" },
  { name: "Haiku 4.5", amount: "$80", pct: 6, color: "var(--state-done)" },
];

const cardStyle: CSSProperties = {
  background: "var(--card)",
  border: "1px solid var(--line)",
  borderRadius: 12,
  boxShadow: "var(--shadow-card)",
};

export function Overview() {
  const navigate = useNavigate();

  const runColumns: Column<RunRow>[] = [
    {
      key: "wf",
      header: "Workflow",
      render: (r) => (
        <span style={{ fontSize: 12.5, fontWeight: 500, color: "var(--ink)" }}>
          {r.wf}
        </span>
      ),
    },
    {
      key: "status",
      header: "Status",
      render: (r) => <StatusPill state={r.statusState} />,
    },
    {
      key: "cost",
      header: "Cost",
      render: (r) => (
        <span
          className="mono"
          style={{ fontSize: 11.5, color: "var(--ink-2)" }}
        >
          {r.cost}
        </span>
      ),
    },
    {
      key: "started",
      header: "Started",
      render: (r) => (
        <span className="mono" style={{ fontSize: 11, color: "var(--ink-3)" }}>
          {r.started}
        </span>
      ),
    },
  ];

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
            Good morning, Maria
          </div>
          <div style={{ fontSize: 13, color: "var(--ink-2)", marginTop: 3 }}>
            28 workflows live · 7 runs need your approval
          </div>
        </div>
        <Button variant="secondary" icon="clock" iconRight="chevron-down">
          Last 24 hours
        </Button>
      </div>

      {/* ---- live metrics (real, from the control plane) ---- */}
      <LiveStrip />

      {/* ---- stat cards (prototype/illustrative) ---- */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(4,1fr)",
          gap: 14,
          marginBottom: 16,
        }}
      >
        {/* Runs (24h) */}
        <div style={{ ...cardStyle, padding: "15px 16px" }}>
          <StatHead label="Runs (24h)">
            <DeltaBadge dir="up">12%</DeltaBadge>
          </StatHead>
          <StatValue>4,182</StatValue>
          <svg
            width="100%"
            height="28"
            viewBox="0 0 160 28"
            preserveAspectRatio="none"
            style={{ marginTop: 6, display: "block" }}
          >
            <polyline
              points="0,22 18,18 36,20 54,12 72,15 90,8 108,11 126,6 144,9 160,4"
              fill="none"
              stroke="var(--brand)"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>

        {/* Success rate */}
        <div style={{ ...cardStyle, padding: "15px 16px" }}>
          <StatHead label="Success rate">
            <DeltaBadge dir="up">0.4%</DeltaBadge>
          </StatHead>
          <StatValue>
            98.7<span style={{ fontSize: 16, color: "var(--ink-2)" }}>%</span>
          </StatValue>
          <div style={{ marginTop: 13 }}>
            <ProgressBar value={98.7} color="var(--state-done)" />
          </div>
        </div>

        {/* Spend (MTD) */}
        <div style={{ ...cardStyle, padding: "15px 16px" }}>
          <StatHead label="Spend (MTD)">
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
              $3k cap
            </span>
          </StatHead>
          <StatValue>$1,284</StatValue>
          <svg
            width="100%"
            height="28"
            viewBox="0 0 160 28"
            preserveAspectRatio="none"
            style={{ marginTop: 6, display: "block" }}
          >
            <polyline
              points="0,24 20,21 40,22 60,17 80,16 100,12 120,13 140,8 160,7"
              fill="none"
              stroke="var(--state-info)"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
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
              <span
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: "50%",
                  background: "var(--state-paused)",
                  animation: "naaryBlink 1.5s infinite",
                }}
              />
            </div>
            <StatValue>7</StatValue>
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
          </div>
        </div>
      </div>

      {/* ---- run volume + approval queue ---- */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1.7fr 1fr",
          gap: 16,
          marginBottom: 16,
        }}
      >
        {/* Run volume chart */}
        <div style={{ ...cardStyle, padding: 18 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: 18,
            }}
          >
            <div>
              <div
                style={{ fontSize: 14, fontWeight: 600, color: "var(--ink)" }}
              >
                Run volume
              </div>
              <div
                style={{ fontSize: 11.5, color: "var(--ink-3)", marginTop: 2 }}
              >
                Executions per hour · last 24h
              </div>
            </div>
            <div style={{ display: "flex", gap: 14 }}>
              <Legend color="var(--state-done)">Succeeded</Legend>
              <Legend color="var(--state-error)">Failed</Legend>
              <Legend color="var(--state-paused)">Paused</Legend>
            </div>
          </div>
          <RunVolumeChart />
          <div
            className="mono"
            style={{
              display: "flex",
              justifyContent: "space-between",
              marginTop: 8,
              fontSize: 10,
              color: "var(--ink-3)",
            }}
          >
            <span>00:00</span>
            <span>06:00</span>
            <span>12:00</span>
            <span>18:00</span>
            <span>now</span>
          </div>
        </div>

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
                7
              </span>
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
          <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
            {approvalQueue.map((item) =>
              item.primary ? (
                <div
                  key={item.title}
                  style={{
                    border:
                      "1px solid color-mix(in srgb, var(--state-paused) 32%, var(--line))",
                    background: "var(--paused-soft)",
                    borderRadius: 9,
                    padding: 11,
                  }}
                >
                  <div
                    style={{ display: "flex", alignItems: "center", gap: 7 }}
                  >
                    <ApprovalIcon />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div
                        style={{
                          fontSize: 12.5,
                          fontWeight: 600,
                          color: "var(--ink)",
                        }}
                      >
                        {item.title}
                      </div>
                      <div
                        className="mono"
                        style={{ fontSize: 10, color: "var(--ink-3)" }}
                      >
                        {item.meta}
                      </div>
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 7, marginTop: 10 }}>
                    <Button
                      variant="positive"
                      size="sm"
                      style={{ flex: 1 }}
                      onClick={() => navigate(`/app/runs/${item.runId}`)}
                    >
                      Approve
                    </Button>
                    <Button variant="danger" size="sm" style={{ flex: 1 }}>
                      Reject
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      iconOnly
                      icon="eye"
                      aria-label="View run"
                      onClick={() => navigate(`/app/runs/${item.runId}`)}
                    />
                  </div>
                </div>
              ) : (
                <Link
                  key={item.title}
                  to={`/app/runs/${item.runId}`}
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
                      }}
                    >
                      {item.title}
                    </div>
                    <div
                      className="mono"
                      style={{ fontSize: 10, color: "var(--ink-3)" }}
                    >
                      {item.meta}
                    </div>
                  </div>
                  <Icon
                    name="chevron-right"
                    size={14}
                    strokeWidth={1.9}
                    style={{ color: "var(--ink-3)" }}
                  />
                </Link>
              ),
            )}
          </div>
        </div>
      </div>

      {/* ---- recent runs + spend by model ---- */}
      <div
        style={{ display: "grid", gridTemplateColumns: "1.7fr 1fr", gap: 16 }}
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
          <Table
            rowKey={(r) => r.id}
            columns={runColumns}
            rows={recentRuns}
            onRowClick={(r) => navigate(`/app/runs/${r.id}`)}
          />
        </Card>

        {/* Spend by model */}
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
            This month · $1,284 total
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {spendByModel.map((m) => (
              <div key={m.name}>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    fontSize: 12,
                    marginBottom: 5,
                  }}
                >
                  <span style={{ color: "var(--ink)", fontWeight: 500 }}>
                    {m.name}
                  </span>
                  <span className="mono" style={{ color: "var(--ink-2)" }}>
                    {m.amount}
                  </span>
                </div>
                <ProgressBar value={m.pct} color={m.color} />
              </div>
            ))}
          </div>
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
              Projected month-end
            </span>
            <span
              className="mono"
              style={{ fontSize: 13, fontWeight: 600, color: "var(--ink)" }}
            >
              $2,470
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------------- local presentational helpers ---------------- */

/** Real metrics from the control plane: tenant, recent run count, usage cost +
 *  tokens (usage ledger). Renders alongside the illustrative cards below. */
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

function StatHead({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
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

function DeltaBadge({
  dir,
  children,
}: {
  dir: "up" | "down";
  children: ReactNode;
}) {
  return (
    <span
      className="mono"
      style={{
        fontSize: 10,
        color: "var(--state-done)",
        background: "var(--done-soft)",
        padding: "2px 6px",
        borderRadius: 5,
      }}
    >
      {dir === "down" ? "▼" : "▲"} {children}
    </span>
  );
}

function Legend({ color, children }: { color: string; children: ReactNode }) {
  return (
    <span
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        fontSize: 11,
        color: "var(--ink-2)",
      }}
    >
      <span
        style={{ width: 9, height: 9, borderRadius: 2, background: color }}
      />
      {children}
    </span>
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

/* Stacked run-volume bars — succeeded (base) with failed / paused caps. */
function RunVolumeChart() {
  const ok = [
    [8, 120, 60],
    [38, 100, 80],
    [68, 135, 45],
    [98, 88, 92],
    [128, 70, 110],
    [158, 92, 88],
    [188, 60, 120],
    [218, 48, 132],
    [248, 64, 116],
    [278, 40, 140],
    [308, 55, 125],
    [338, 36, 144],
    [368, 50, 130],
    [398, 44, 136],
    [428, 62, 118],
    [458, 38, 142],
    [488, 30, 150],
    [518, 52, 128],
    [548, 70, 110],
    [578, 58, 122],
    [608, 80, 100],
    [638, 66, 114],
    [668, 92, 88],
  ];
  return (
    <svg
      width="100%"
      height="180"
      viewBox="0 0 720 180"
      preserveAspectRatio="none"
      style={{ display: "block", overflow: "visible" }}
    >
      {[45, 90, 135, 180].map((y) => (
        <line
          key={y}
          x1={0}
          y1={y}
          x2={720}
          y2={y}
          stroke="var(--line)"
          strokeWidth={1}
        />
      ))}
      {ok.map(([x, y, h]) => (
        <rect
          key={x}
          x={x}
          y={y}
          width={22}
          height={h}
          rx={2}
          fill="var(--state-done)"
          opacity={0.85}
        />
      ))}
      <rect
        x={698}
        y={104}
        width={14}
        height={76}
        rx={2}
        fill="var(--state-done)"
        opacity={0.85}
      />
      {/* failed / paused caps */}
      <rect
        x={338}
        y={26}
        width={22}
        height={10}
        rx={2}
        fill="var(--state-error)"
      />
      <rect
        x={278}
        y={32}
        width={22}
        height={8}
        rx={2}
        fill="var(--state-error)"
      />
      <rect
        x={188}
        y={52}
        width={22}
        height={8}
        rx={2}
        fill="var(--state-paused)"
      />
      <rect
        x={488}
        y={20}
        width={22}
        height={10}
        rx={2}
        fill="var(--state-paused)"
      />
    </svg>
  );
}
