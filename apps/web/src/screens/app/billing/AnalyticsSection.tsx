/**
 * Usage analytics for the Usage & budgets screen — the old InsightsSection's
 * machinery (window presets + environment filter over GET /usage/insights)
 * restyled into the redesign layout:
 *   · Spend over time — stacked BY MODEL from the usage ledger's line items
 *     (falls back to single-series byDay totals when an environment filter is
 *     active: ledger line items don't carry environmentId, so an env-scoped
 *     stack would be fabricated).
 *   · Top workflows by cost · Cost by model (tokens + $) · By environment.
 * All from the server's insights rollups; the model ranking (and its colors)
 * is shared between the chart legend and the Cost-by-model card.
 */
import { useEffect, useState } from "react";
import { Card } from "../../../components";
import {
  api,
  type Environment,
  type InsightsReport,
  type UsageEventItem,
} from "../../../lib/api";
import {
  DEFAULT_WINDOW_DAYS,
  envLabel,
  insightsQuery,
  rankBuckets,
  type RankedRow,
  wfLabel,
  WINDOW_PRESETS,
  windowFromDate,
  windowLabel,
} from "../insights.logic";
import {
  earliestEventDate,
  fmtTokens,
  modelColor,
  parseUsageEvents,
  rankModels,
  stackSpendByDay,
  usd,
} from "./billing-model";
import { SpendStackedChart } from "./SpendStackedChart";

/* ---------------- shared card scaffolding ---------------- */

function CardTitle({
  title,
  right,
}: {
  title: string;
  right?: React.ReactNode;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        marginBottom: 16,
      }}
    >
      <div
        style={{
          fontSize: "var(--text-body)",
          fontWeight: "var(--weight-bold)",
          color: "var(--ink)",
        }}
      >
        {title}
      </div>
      {right !== undefined && (
        <span
          className="mono"
          style={{
            marginLeft: "auto",
            fontSize: "var(--text-xs)",
            color: "var(--ink-3)",
          }}
        >
          {right}
        </span>
      )}
    </div>
  );
}

function EmptyRows() {
  return (
    <div style={{ fontSize: "var(--text-xs)", color: "var(--ink-3)" }}>
      No spend in this window.
    </div>
  );
}

/* ---------------- breakdown cards ---------------- */

function TopWorkflowsCard({ rows }: { rows: RankedRow[] }) {
  return (
    <Card pad={false} style={{ padding: "20px 22px" }}>
      <CardTitle title="Top workflows by cost" right="this window" />
      {rows.length === 0 ? (
        <EmptyRows />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {rows.map((r) => (
            <div key={r.label}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 9,
                  marginBottom: 6,
                }}
              >
                <span
                  style={{
                    fontSize: "var(--text-sm)",
                    fontWeight: "var(--weight-medium)",
                    color: "var(--ink)",
                    flex: 1,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                  title={r.label}
                >
                  {r.label}
                </span>
                <span
                  className="mono"
                  style={{
                    fontSize: "var(--text-2xs)",
                    color: "var(--ink-3)",
                  }}
                >
                  {r.calls.toLocaleString()} calls
                </span>
                <span
                  className="mono"
                  style={{
                    fontSize: "var(--text-sm)",
                    fontWeight: "var(--weight-semibold)",
                    color: "var(--ink)",
                  }}
                >
                  {usd(r.costUsd)}
                </span>
              </div>
              <div
                style={{
                  height: 8,
                  borderRadius: 5,
                  background: "var(--card-2)",
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    height: "100%",
                    width: `${r.pct}%`,
                    background: "var(--brand)",
                    borderRadius: 5,
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

function CostByModelCard({
  byModel,
  downgradeTip,
}: {
  byModel: InsightsReport["byModel"];
  /** Shown only when the downgrade policy actually exists on this workspace. */
  downgradeTip: boolean;
}) {
  const ranked = rankModels(byModel);
  return (
    <Card pad={false} style={{ padding: "20px 22px" }}>
      <CardTitle title="Cost by model" right="tokens · $" />
      {ranked.length === 0 ? (
        <EmptyRows />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
          {ranked.map((m, i) => (
            <div
              key={`${m.provider}/${m.model}`}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                padding: "10px 0",
                borderBottom: "1px solid var(--line)",
              }}
            >
              <span
                aria-hidden
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  flex: "none",
                  background: modelColor(i),
                }}
              />
              <span
                className="mono"
                title={`${m.provider}/${m.model}`}
                style={{
                  fontSize: "var(--text-sm)",
                  fontWeight: "var(--weight-medium)",
                  color: "var(--ink)",
                  flex: 1,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {m.model}
              </span>
              <span
                className="mono"
                style={{
                  fontSize: "var(--text-xs)",
                  color: "var(--ink-faint)",
                  width: 74,
                  textAlign: "right",
                }}
              >
                {fmtTokens(m.totalTokens)}
              </span>
              <span
                className="mono"
                style={{
                  fontSize: "var(--text-sm)",
                  fontWeight: "var(--weight-semibold)",
                  color: "var(--ink)",
                  width: 76,
                  textAlign: "right",
                }}
              >
                {usd(m.costUsd)}
              </span>
            </div>
          ))}
        </div>
      )}
      {downgradeTip && ranked.length > 0 && (
        <div
          style={{
            marginTop: 14,
            fontSize: "var(--text-xs)",
            color: "var(--ink-faint)",
            lineHeight: 1.5,
          }}
        >
          Tip: your <span style={{ color: "var(--ink-soft)" }}>downgrade</span>{" "}
          policy swaps costlier models for the fallback as you approach the cap
          — the biggest lever here.
        </div>
      )}
    </Card>
  );
}

function ByEnvironmentCard({ rows }: { rows: RankedRow[] }) {
  return (
    <Card pad={false} style={{ padding: "20px 22px" }}>
      <CardTitle title="By environment" right="this window" />
      {rows.length === 0 ? (
        <EmptyRows />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {rows.map((r) => (
            <div key={r.label}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 8,
                  marginBottom: 6,
                }}
              >
                <span
                  style={{
                    fontSize: "var(--text-sm)",
                    fontWeight: "var(--weight-medium)",
                    color: "var(--ink)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {r.label}
                </span>
                <span
                  className="mono"
                  style={{
                    fontSize: "var(--text-sm)",
                    fontWeight: "var(--weight-semibold)",
                    color: "var(--ink)",
                    flexShrink: 0,
                  }}
                >
                  {usd(r.costUsd)}
                </span>
              </div>
              <div
                style={{
                  height: 8,
                  borderRadius: 5,
                  background: "var(--card-2)",
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    height: "100%",
                    width: `${r.pct}%`,
                    background: "var(--state-info)",
                    borderRadius: 5,
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

/* ---------------- filter bar (kept from the old InsightsSection) ---------------- */

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
          border: "1px solid var(--line-2)",
          borderRadius: 8,
          overflow: "hidden",
          background: "var(--bg)",
          padding: 2,
          gap: 2,
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
              className="mono"
              style={{
                border: "none",
                padding: "4px 10px",
                borderRadius: 6,
                fontSize: "var(--text-xs)",
                fontWeight: "var(--weight-semibold)",
                cursor: "pointer",
                background: active ? "var(--card)" : "transparent",
                color: active ? "var(--ink)" : "var(--ink-faint)",
              }}
            >
              {p.label}
            </button>
          );
        })}
      </div>
      {/* Degrades to "All environments" while loading / on failure. */}
      <select
        value={envId ?? ""}
        onChange={(e) => onEnv(e.target.value || null)}
        aria-label="Environment"
        style={{
          border: "1px solid var(--line-2)",
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
    </div>
  );
}

/* ---------------- the section ---------------- */

type State =
  | { kind: "loading" }
  | { kind: "error" }
  | {
      kind: "ready";
      data: InsightsReport;
      /** Ledger line items for the same window; null when the fetch failed. */
      events: UsageEventItem[] | null;
    };

export function AnalyticsSection({
  tenantId,
  downgradeTip,
  now,
}: {
  tenantId: string;
  downgradeTip: boolean;
  /** Injectable for tests/stories. */
  now?: number;
}) {
  // Freeze once per mount so the re-fetch effect doesn't loop on Date.now().
  const [now0] = useState(() => now ?? Date.now());
  const [state, setState] = useState<State>({ kind: "loading" });
  const [days, setDays] = useState<number | null>(DEFAULT_WINDOW_DAYS);
  const [envId, setEnvId] = useState<string | null>(null);
  const [envs, setEnvs] = useState<Environment[]>([]);

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

  useEffect(() => {
    let live = true;
    setState({ kind: "loading" });
    (async () => {
      try {
        const q = insightsQuery(now0, days, envId);
        const data = await api.getInsights(tenantId, q);
        // Line items only matter when no env filter is active (see header note).
        let events: UsageEventItem[] | null = null;
        if (envId === null) {
          events = await api
            .getUsage(tenantId, q.from ? { from: q.from } : {})
            .then((u) => parseUsageEvents(u.events))
            .catch(() => null);
        }
        if (live) setState({ kind: "ready", data, events });
      } catch {
        if (live) setState({ kind: "error" });
      }
    })();
    return () => {
      live = false;
    };
  }, [tenantId, now0, days, envId]);

  // Env id → name for the breakdown labels (falls back to the raw id).
  const envName = (id: string | null): string => {
    if (id === null) return envLabel(null);
    return envs.find((e) => e.id === id)?.name ?? id;
  };

  return (
    <div>
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
          Usage · {windowLabel(days)}
          {state.kind === "ready" && (
            <span
              className="mono"
              style={{
                marginLeft: 10,
                fontSize: "var(--text-xs)",
                fontWeight: "var(--weight-regular)",
                color: "var(--ink-3)",
              }}
            >
              {usd(state.data.totals.costUsd)} ·{" "}
              {state.data.totals.calls.toLocaleString()} calls ·{" "}
              {fmtTokens(state.data.totals.totalTokens)} tokens
            </span>
          )}
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
        <Card pad={false} style={{ padding: 28, textAlign: "center" }}>
          <span style={{ fontSize: "var(--text-sm)", color: "var(--ink-3)" }}>
            Loading usage…
          </span>
        </Card>
      )}
      {state.kind === "error" && (
        <Card pad={false} style={{ padding: 28, textAlign: "center" }}>
          <span style={{ fontSize: "var(--text-body)", color: "var(--ink-2)" }}>
            Couldn&apos;t load usage analytics.
          </span>
        </Card>
      )}

      {state.kind === "ready" && (
        <ReadyBody
          data={state.data}
          events={state.events}
          envFiltered={envId !== null}
          days={days}
          now={now0}
          envName={envName}
          downgradeTip={downgradeTip}
        />
      )}
    </div>
  );
}

function ReadyBody({
  data,
  events,
  envFiltered,
  days,
  now,
  envName,
  downgradeTip,
}: {
  data: InsightsReport;
  events: UsageEventItem[] | null;
  envFiltered: boolean;
  days: number | null;
  now: number;
  envName: (id: string | null) => string;
  downgradeTip: boolean;
}) {
  const byWf = rankBuckets(data.byWorkflow, (r) => wfLabel(r.workflowKey), 5);
  const byEnv = rankBuckets(data.byEnvironment, (r) =>
    envName(r.environmentId),
  );

  // Stack by model when line items are available (no env filter); otherwise a
  // single "total" series from the byDay rollup — never a fabricated split.
  const canStack = !envFiltered && events !== null;
  const stack = canStack
    ? stackSpendByDay(
        events,
        rankModels(data.byModel),
        days !== null
          ? windowFromDate(now, days)
          : earliestEventDate(events, now),
        now,
      )
    : {
        series: [{ key: "total", label: "total spend" }],
        days: data.byDay.map((d) => ({
          date: d.date,
          label: new Date(`${d.date}T00:00:00Z`).toLocaleString("en-US", {
            month: "short",
            day: "numeric",
            timeZone: "UTC",
          }),
          total: d.costUsd,
          parts: [d.costUsd],
        })),
        max: Math.max(0, ...data.byDay.map((d) => d.costUsd)),
      };

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <Card pad={false} style={{ padding: "20px 22px" }}>
        <CardTitle
          title="Spend over time"
          right={
            canStack
              ? "stacked by model · usage ledger"
              : "daily totals · per-model stack is all-environments only"
          }
        />
        <SpendStackedChart stack={stack} />
      </Card>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))",
          gap: 16,
        }}
      >
        <TopWorkflowsCard rows={byWf} />
        <CostByModelCard byModel={data.byModel} downgradeTip={downgradeTip} />
        <ByEnvironmentCard rows={byEnv} />
      </div>
    </div>
  );
}
