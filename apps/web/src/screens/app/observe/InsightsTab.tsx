/**
 * Observe › Insights — KPI row, run-throughput lines, outcome donut, failure
 * reasons, and top-workflow spend. Data notes (honesty over decoration):
 * - Run-derived figures (KPIs, throughput, donut, failures) come from the run
 *   list, filtered client-side to the exact range window — the usage rollups
 *   API has no run-outcome dimension.
 * - Spend figures come from the insights rollups (GET /usage/insights), which
 *   are DAY-granular: the KPI prints its true from-date so a "24h" range never
 *   silently shows two days of spend.
 * - No latency cards and no delta-vs-previous-period: the API exposes neither
 *   run durations nor cheap previous-window rollups.
 */
import type { InsightsReport, RunSummary } from "../../../lib/api";
import { successRate } from "../../../lib/run-status";
import { rankBuckets, usd, wfLabel } from "../insights.logic";
import {
  failureReasons,
  linePath,
  type RangeId,
  rangeById,
  runOutcomes,
  runsInRange,
  throughputSeries,
  xAxisLabels,
} from "./observe-model";
import { CardEmpty, CardTitle, panelCard } from "./ui";

const monoMeta: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-2xs)",
  color: "var(--ink-3)",
};

function Kpi({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div style={{ ...panelCard, padding: "16px 18px" }}>
      <div style={{ fontSize: 11.5, color: "var(--ink-faint)" }}>{label}</div>
      <div
        style={{
          fontSize: 26,
          fontWeight: "var(--weight-bold)",
          letterSpacing: "var(--tracking-tight)",
          color: "var(--ink)",
          marginTop: 6,
        }}
      >
        {value}
      </div>
      {sub && (
        <div style={{ marginTop: 6, fontSize: 11.5, color: "var(--ink-3)" }}>
          {sub}
        </div>
      )}
    </div>
  );
}

function LegendSwatch({ color, label }: { color: string; label: string }) {
  return (
    <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <span
        style={{
          width: 14,
          height: 2.5,
          borderRadius: 2,
          background: color,
        }}
      />
      {label}
    </span>
  );
}

function ThroughputCard({
  runs,
  now,
  range,
}: {
  runs: RunSummary[];
  now: number;
  range: RangeId;
}) {
  const series = throughputSeries(runs, now, range);
  const ok = series.map((b) => b.ok);
  const bad = series.map((b) => b.bad);
  const max = Math.max(4, ...ok, ...bad);
  const okPath = linePath(ok, max, 900, 180, 20);
  const badPath = linePath(bad, max, 900, 180, 20);
  const hasRuns = series.some((b) => b.ok > 0 || b.bad > 0);

  return (
    <div style={{ ...panelCard, padding: "20px 22px" }}>
      <div style={{ display: "flex", alignItems: "center", marginBottom: 18 }}>
        <CardTitle>Run throughput</CardTitle>
        <div
          style={{
            marginLeft: "auto",
            display: "flex",
            gap: 14,
            fontSize: "var(--text-xs)",
            color: "var(--ink-faint)",
          }}
        >
          <LegendSwatch color="var(--state-done)" label="succeeded" />
          <LegendSwatch color="var(--state-error)" label="failed" />
        </div>
      </div>
      {hasRuns ? (
        <>
          <div style={{ position: "relative", height: 180 }}>
            <svg
              viewBox="0 0 900 180"
              width="100%"
              height="180"
              preserveAspectRatio="none"
              style={{ overflow: "visible" }}
              role="img"
              aria-label="Succeeded vs failed runs over the selected range"
            >
              {[45, 90, 135].map((y) => (
                <line
                  key={y}
                  x1="0"
                  y1={y}
                  x2="900"
                  y2={y}
                  stroke="var(--line-mid)"
                  strokeWidth="1"
                  strokeDasharray="4 6"
                />
              ))}
              <path
                d={`${okPath} L900 160 L0 160 Z`}
                fill="var(--brand)"
                opacity="0.08"
              />
              <path
                d={okPath}
                fill="none"
                stroke="var(--state-done)"
                strokeWidth="2.4"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeDasharray="900"
                style={{ animation: "obDrawLine 1s ease forwards" }}
              />
              <path
                d={badPath}
                fill="none"
                stroke="var(--state-error)"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              marginTop: 8,
              ...monoMeta,
            }}
          >
            {xAxisLabels(now, range).map((x, i) => (
              // eslint-disable-next-line react/no-array-index-key -- fixed axis positions
              <span key={i}>{x}</span>
            ))}
          </div>
        </>
      ) : (
        <CardEmpty height={180}>No runs in this range.</CardEmpty>
      )}
    </div>
  );
}

/** The design's donut, exactly: 42-viewbox, r 16.5, stroke 3.6, pathLength 100. */
function OutcomesCard({ runs }: { runs: RunSummary[] }) {
  const o = runOutcomes(runs);
  const slices = [
    { name: "Succeeded", pct: o.okPct, color: "var(--state-done)" },
    { name: "Paused / waiting", pct: o.warnPct, color: "var(--state-paused)" },
    { name: "Failed", pct: o.badPct, color: "var(--state-error)" },
  ];
  return (
    <div
      style={{
        ...panelCard,
        padding: "18px 20px",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <CardTitle style={{ marginBottom: 16 }}>Run outcomes</CardTitle>
      {o.total === 0 ? (
        <CardEmpty height={116}>No runs in this range.</CardEmpty>
      ) : (
        <div style={{ display: "flex", alignItems: "center", gap: 24 }}>
          <div
            style={{
              position: "relative",
              width: 116,
              height: 116,
              flex: "none",
            }}
          >
            <svg
              width="116"
              height="116"
              viewBox="0 0 42 42"
              style={{ transform: "rotate(-90deg)" }}
              role="img"
              aria-label="Share of runs by outcome"
            >
              <circle
                cx="21"
                cy="21"
                r="16.5"
                fill="none"
                stroke="var(--card-2)"
                strokeWidth="3.6"
                pathLength={100}
              />
              <circle
                cx="21"
                cy="21"
                r="16.5"
                fill="none"
                stroke="var(--state-done)"
                strokeWidth="3.6"
                pathLength={100}
                strokeDasharray={`${o.okPct} 100`}
                strokeDashoffset={0}
              />
              <circle
                cx="21"
                cy="21"
                r="16.5"
                fill="none"
                stroke="var(--state-paused)"
                strokeWidth="3.6"
                pathLength={100}
                strokeDasharray={`${o.warnPct} 100`}
                strokeDashoffset={-o.okPct}
              />
              <circle
                cx="21"
                cy="21"
                r="16.5"
                fill="none"
                stroke="var(--state-error)"
                strokeWidth="3.6"
                pathLength={100}
                strokeDasharray={`${o.badPct} 100`}
                strokeDashoffset={-(o.okPct + o.warnPct)}
              />
            </svg>
            <div
              style={{
                position: "absolute",
                inset: 0,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <span
                style={{
                  fontSize: 17,
                  fontWeight: "var(--weight-bold)",
                  color: "var(--ink)",
                }}
              >
                {`${Math.round(o.okPct)}%`}
              </span>
              <span style={{ fontSize: 8.5, color: "var(--ink-3)" }}>
                succeeded
              </span>
            </div>
          </div>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 9,
              flex: 1,
            }}
          >
            {slices.map((s) => (
              <div
                key={s.name}
                style={{ display: "flex", alignItems: "center", gap: 10 }}
              >
                <span
                  style={{
                    width: 9,
                    height: 9,
                    borderRadius: 3,
                    background: s.color,
                    flex: "none",
                  }}
                />
                <span
                  style={{
                    fontSize: "var(--text-sm)",
                    color: "var(--ink-soft)",
                    whiteSpace: "nowrap",
                  }}
                >
                  {s.name}
                </span>
                <span
                  className="mono"
                  style={{
                    marginLeft: "auto",
                    paddingLeft: 16,
                    fontSize: "var(--text-sm)",
                    fontWeight: "var(--weight-semibold)",
                    color: "var(--ink)",
                  }}
                >
                  {`${s.pct.toFixed(1)}%`}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function FailureReasonsCard({ runs }: { runs: RunSummary[] }) {
  const rows = failureReasons(runs);
  return (
    <div style={{ ...panelCard, padding: "18px 20px" }}>
      <CardTitle style={{ marginBottom: 4 }}>Top failure reasons</CardTitle>
      <div
        style={{
          fontSize: "var(--text-xs)",
          color: "var(--ink-faint)",
          marginBottom: 16,
        }}
      >
        Close reasons of failed runs in this range
      </div>
      {rows.length === 0 ? (
        <CardEmpty height={100}>No failed runs in this range.</CardEmpty>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 13 }}>
          {rows.map((r) => (
            <div key={r.label}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  marginBottom: 5,
                }}
              >
                <span
                  style={{
                    fontSize: "var(--text-sm)",
                    color: "var(--ink-soft)",
                    flex: 1,
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
                    color: "var(--state-error)",
                  }}
                >
                  {r.count}
                </span>
              </div>
              <div
                style={{
                  height: 6,
                  borderRadius: 4,
                  background: "var(--card-2)",
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    height: "100%",
                    width: `${r.pct}%`,
                    background: "var(--state-error)",
                    borderRadius: 4,
                  }}
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SpendByWorkflowCard({
  insights,
}: {
  insights: InsightsReport | null;
}) {
  const rows = insights
    ? rankBuckets(insights.byWorkflow, (r) => wfLabel(r.workflowKey), 6)
    : [];
  return (
    <div style={{ ...panelCard, padding: "18px 20px" }}>
      <CardTitle style={{ marginBottom: 4 }}>Top workflows by spend</CardTitle>
      <div
        style={{
          fontSize: "var(--text-xs)",
          color: "var(--ink-faint)",
          marginBottom: 16,
        }}
      >
        Usage-ledger rollups (day-granular)
      </div>
      {rows.length === 0 ? (
        <CardEmpty height={100}>
          {insights ? "No spend in this window." : "Loading rollups…"}
        </CardEmpty>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 13 }}>
          {rows.map((r) => (
            <div key={r.label}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  marginBottom: 5,
                }}
              >
                <span
                  className="mono"
                  style={{
                    fontSize: "var(--text-xs)",
                    color: "var(--ink-soft)",
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
                  height: 6,
                  borderRadius: 4,
                  background: "var(--card-2)",
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    height: "100%",
                    width: `${r.pct}%`,
                    background: "var(--brand)",
                    borderRadius: 4,
                  }}
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function InsightsTab({
  runs,
  insights,
  spendFrom,
  range,
  now,
}: {
  /** All fetched recent runs (unfiltered). */
  runs: RunSummary[];
  insights: InsightsReport | null;
  /** ISO date the spend rollup window starts at (printed for honesty). */
  spendFrom: string;
  range: RangeId;
  now: number;
}) {
  const ranged = runsInRange(runs, now, rangeById(range).ms);
  const rate = successRate(ranged.map((r) => r.status));
  // Paused is a CURRENT state — a run that began before the window is still
  // waiting now, so this KPI counts across all fetched runs, not the range.
  const paused = runs.filter(
    (r) => r.status === "awaiting_approval" || r.status === "awaiting_webhook",
  ).length;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 16,
        animation: "naaryFadeUp .25s ease",
      }}
    >
      {/* KPI row */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
          gap: 14,
        }}
      >
        <Kpi
          label="Total runs"
          value={`${ranged.length}`}
          sub={`last ${rangeById(range).label}`}
        />
        <Kpi
          label="Success rate"
          value={rate === null ? "—" : `${rate.toFixed(1)}%`}
          sub={rate === null ? "no finished runs yet" : "of finished runs"}
        />
        <Kpi
          label="Paused (HITL)"
          value={`${paused}`}
          sub="waiting on a human now"
        />
        <Kpi
          label="Spend"
          value={insights ? usd(insights.totals.costUsd) : "—"}
          sub={
            insights
              ? `${insights.totals.calls.toLocaleString()} model calls · since ${spendFrom}`
              : "loading rollups…"
          }
        />
      </div>

      <ThroughputCard runs={runs} now={now} range={range} />

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
          gap: 14,
        }}
      >
        <OutcomesCard runs={ranged} />
        <FailureReasonsCard runs={ranged} />
        <SpendByWorkflowCard insights={insights} />
      </div>
    </div>
  );
}
