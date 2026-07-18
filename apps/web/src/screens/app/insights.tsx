/**
 * Insights section for the Billing & usage screen — spend rolled up over time, by environment, and
 * by workflow, from GET /tenants/:id/usage/insights (the server does the aggregation; this just
 * renders it). Self-fetching like the charts in charts.tsx; inline SVG, no chart lib. The pure
 * shaping helpers are exported for unit tests.
 */
import { type CSSProperties, useEffect, useState } from "react";
import { Card } from "../../components";
import { api, type Environment, type InsightsReport } from "../../lib/api";
import {
  type Bar,
  DEFAULT_WINDOW_DAYS,
  type RankedRow,
  WINDOW_PRESETS,
  dayBars,
  envLabel,
  insightsQuery,
  rankBuckets,
  usd,
  wfLabel,
  windowLabel,
} from "./insights.logic";

const cardStyle: CSSProperties = {
  background: "var(--card)",
  border: "1px solid var(--line)",
  borderRadius: "var(--radius-lg)",
  boxShadow: "var(--shadow-card)",
};

// --- presentational --------------------------------------------------------

function CardTitle({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: "var(--text-body)",
        fontWeight: "var(--weight-semibold)",
        color: "var(--ink)",
        marginBottom: 4,
      }}
    >
      {children}
    </div>
  );
}

function CardSub({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: "var(--text-xs)", color: "var(--ink-3)" }}>
      {children}
    </div>
  );
}

/** Inline-SVG daily cost bars (mirrors charts.tsx DayBars, driven by the server's byDay). */
function DayCostBars({ bars }: { bars: Bar[] }) {
  const max = Math.max(1e-9, ...bars.map((b) => b.value));
  const W = 100 / Math.max(1, bars.length);
  return (
    <svg
      width="100%"
      height="120"
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      style={{ display: "block" }}
      role="img"
      aria-label="daily spend"
    >
      {bars.map((b, i) => {
        const h = (b.value / max) * 92;
        return (
          <rect
            key={b.label}
            x={i * W + W * 0.15}
            y={100 - h}
            width={W * 0.7}
            height={Math.max(h, b.value > 0 ? 1.5 : 0)}
            rx={0.6}
            fill="var(--state-done)"
            opacity={b.value > 0 ? 0.9 : 0.18}
          >
            <title>{`${b.label}: ${usd(b.value)}`}</title>
          </rect>
        );
      })}
    </svg>
  );
}

function RankedBars({
  title,
  sub,
  rows,
}: {
  title: string;
  sub: string;
  rows: RankedRow[];
}) {
  return (
    <Card pad={false} style={{ padding: 16 }}>
      <CardTitle>{title}</CardTitle>
      <CardSub>{sub}</CardSub>
      {rows.length === 0 ? (
        <div
          style={{
            marginTop: 14,
            fontSize: "var(--text-xs)",
            color: "var(--ink-3)",
          }}
        >
          No spend in this window.
        </div>
      ) : (
        <div style={{ marginTop: 14, display: "grid", gap: 10 }}>
          {rows.map((r) => (
            <div key={r.label}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  fontSize: "var(--text-xs)",
                  marginBottom: 4,
                }}
              >
                <span
                  style={{
                    color: "var(--ink-2)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    marginRight: 8,
                  }}
                  title={r.label}
                >
                  {r.label}
                </span>
                <span
                  className="mono"
                  style={{ color: "var(--ink)", flexShrink: 0 }}
                >
                  {usd(r.costUsd)}
                </span>
              </div>
              <div
                style={{
                  height: 6,
                  borderRadius: 3,
                  background: "var(--line)",
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    width: `${r.pct}%`,
                    height: "100%",
                    background: "var(--brand)",
                    borderRadius: 3,
                  }}
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function ChartCard({
  title,
  total,
  children,
}: {
  title: string;
  total: string;
  children: React.ReactNode;
}) {
  return (
    <Card pad={false} style={{ padding: 16 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          marginBottom: 10,
        }}
      >
        <span style={{ fontSize: 13, fontWeight: 600 }}>{title}</span>
        <span style={{ fontSize: 12, color: "var(--ink-2)" }}>{total}</span>
      </div>
      {children}
    </Card>
  );
}

type State =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "ready"; data: InsightsReport };

/**
 * The Insights section. Fetches the last {@link DEFAULT_WINDOW_DAYS} days of insights for the tenant
 * and renders a spend time-series plus by-environment and by-workflow breakdowns. `byModel` is
 * intentionally omitted — the Billing screen already shows Spend by model.
 */
export function InsightsSection({
  tenantId,
  now = Date.now(),
}: {
  tenantId: string;
  /** Injectable for tests/stories. */
  now?: number;
}) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [days, setDays] = useState<number | null>(DEFAULT_WINDOW_DAYS);
  const [envId, setEnvId] = useState<string | null>(null);
  const [envs, setEnvs] = useState<Environment[]>([]);

  // Environments for the picker — load once; degrade to "All environments" only if it fails.
  useEffect(() => {
    let live = true;
    api
      .listEnvironments(tenantId)
      .then((rows) => live && setEnvs(rows))
      .catch(() => live && setEnvs([]));
    return () => {
      live = false;
    };
  }, [tenantId]);

  // Re-fetch whenever the tenant or the selected filters change.
  useEffect(() => {
    let live = true;
    setState({ kind: "loading" });
    api
      .getInsights(tenantId, insightsQuery(now, days, envId))
      .then((data) => live && setState({ kind: "ready", data }))
      .catch(() => live && setState({ kind: "error" }));
    return () => {
      live = false;
    };
  }, [tenantId, now, days, envId]);

  return (
    <div style={{ marginTop: 4 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
          marginBottom: 12,
        }}
      >
        <div
          style={{
            fontSize: "var(--text-body)",
            fontWeight: "var(--weight-semibold)",
            color: "var(--ink)",
          }}
        >
          Insights · {windowLabel(days)}
        </div>
        <FilterBar
          days={days}
          onDays={setDays}
          envId={envId}
          onEnv={setEnvId}
          envs={envs}
        />
      </div>

      {state.kind === "loading" && (
        <div
          style={{
            ...cardStyle,
            padding: 28,
            display: "grid",
            placeItems: "center",
          }}
        >
          <span style={{ fontSize: 12, color: "var(--ink-3)" }}>
            Loading insights…
          </span>
        </div>
      )}

      {state.kind === "error" && (
        <div
          style={{
            ...cardStyle,
            padding: 28,
            textAlign: "center",
            fontSize: "var(--text-body)",
            color: "var(--ink-2)",
          }}
        >
          Couldn&apos;t load insights.
        </div>
      )}

      {state.kind === "ready" && <InsightsBody data={state.data} />}
    </div>
  );
}

/** Window-preset segmented control + environment picker. */
function FilterBar({
  days,
  onDays,
  envId,
  onEnv,
  envs,
}: {
  days: number | null;
  onDays: (d: number | null) => void;
  envId: string | null;
  onEnv: (id: string | null) => void;
  envs: Environment[];
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        flexWrap: "wrap",
      }}
    >
      <div
        style={{
          display: "inline-flex",
          border: "1px solid var(--line)",
          borderRadius: 8,
          overflow: "hidden",
        }}
        role="group"
        aria-label="Time window"
      >
        {WINDOW_PRESETS.map((p) => {
          const active = p.days === days;
          return (
            <button
              key={p.label}
              type="button"
              onClick={() => onDays(p.days)}
              aria-pressed={active}
              style={{
                border: "none",
                padding: "5px 11px",
                fontSize: "var(--text-xs)",
                fontWeight: "var(--weight-semibold)",
                cursor: "pointer",
                background: active ? "var(--brand)" : "var(--card)",
                color: active ? "var(--on-brand, #fff)" : "var(--ink-2)",
              }}
            >
              {p.label}
            </button>
          );
        })}
      </div>

      {envs.length > 0 && (
        <select
          value={envId ?? ""}
          onChange={(e) => onEnv(e.target.value || null)}
          aria-label="Environment"
          style={{
            border: "1px solid var(--line)",
            borderRadius: 8,
            background: "var(--card)",
            color: "var(--ink)",
            fontSize: "var(--text-xs)",
            padding: "5px 9px",
          }}
        >
          <option value="">All environments</option>
          {envs.map((env) => (
            <option key={env.id} value={env.id}>
              {env.name}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

export function InsightsBody({ data }: { data: InsightsReport }) {
  const bars = dayBars(data.byDay);
  const byEnv = rankBuckets(data.byEnvironment, (r) =>
    envLabel(r.environmentId),
  );
  const byWf = rankBuckets(data.byWorkflow, (r) => wfLabel(r.workflowKey));

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <ChartCard
        title="Spend over time"
        total={`${usd(data.totals.costUsd)} · ${data.totals.calls.toLocaleString()} calls`}
      >
        {bars.length > 0 ? (
          <DayCostBars bars={bars} />
        ) : (
          <div style={{ height: 120, display: "grid", placeItems: "center" }}>
            <span style={{ fontSize: 12, color: "var(--ink-3)" }}>
              No spend in this window.
            </span>
          </div>
        )}
      </ChartCard>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
          gap: 16,
        }}
      >
        <RankedBars
          title="By environment"
          sub="Spend per environment"
          rows={byEnv}
        />
        <RankedBars
          title="By workflow"
          sub="Top workflows by spend"
          rows={byWf}
        />
      </div>
    </div>
  );
}
