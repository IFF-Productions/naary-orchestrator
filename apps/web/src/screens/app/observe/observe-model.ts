/**
 * Pure shaping for the Observe screen (no React, no DOM) — range windows, run
 * bucketing for the throughput chart, donut slices, failure-reason ranking, and
 * audit-event categorisation. Everything binds to REAL control-plane data:
 * runs (api.listRuns), usage rollups (api.getInsights), audit (api.getAuditLog).
 */
import type { AuditEvent, RunSummary } from "../../../lib/api";
import { isFailure, runStatusUi } from "../../../lib/run-status";

// --- time ranges ------------------------------------------------------------

export type RangeId = "24h" | "7d" | "30d";

export const RANGES: {
  id: RangeId;
  label: string;
  ms: number;
  days: number;
}[] = [
  { id: "24h", label: "24h", ms: 86_400_000, days: 1 },
  { id: "7d", label: "7d", ms: 7 * 86_400_000, days: 7 },
  { id: "30d", label: "30d", ms: 30 * 86_400_000, days: 30 },
];

export function rangeById(id: RangeId) {
  return RANGES.find((r) => r.id === id) ?? RANGES[1];
}

/** Runs whose createdAt falls inside the exact millisecond window. */
export function runsInRange(
  runs: RunSummary[],
  now: number,
  rangeMs: number,
): RunSummary[] {
  const from = now - rangeMs;
  return runs.filter((r) => new Date(r.createdAt).getTime() >= from);
}

/** Compact relative time from an ISO timestamp (no date lib). */
export function relTime(iso: string, now: number): string {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

export function fmtCost(v: number | null): string {
  return v === null ? "—" : `$${v.toFixed(4)}`;
}

// --- throughput (succeeded vs failed series) --------------------------------

export interface SeriesBucket {
  ok: number;
  bad: number;
}

/**
 * Bucket runs into succeeded/failed counts across the range: 12 × 2h buckets
 * for 24h, one bucket per day otherwise. Derived client-side from the run list
 * (the usage rollups have no run-outcome dimension — see the tab's data notes).
 */
export function throughputSeries(
  runs: RunSummary[],
  now: number,
  range: RangeId,
): SeriesBucket[] {
  const { ms } = rangeById(range);
  const n = range === "24h" ? 12 : rangeById(range).days;
  const bucketMs = ms / n;
  const from = now - ms;
  const buckets: SeriesBucket[] = Array.from({ length: n }, () => ({
    ok: 0,
    bad: 0,
  }));
  for (const r of runs) {
    const t = new Date(r.createdAt).getTime();
    if (t < from || t > now) continue;
    const i = Math.min(n - 1, Math.floor((t - from) / bucketMs));
    if (r.status === "completed") buckets[i].ok += 1;
    else if (isFailure(r.status)) buckets[i].bad += 1;
  }
  return buckets;
}

/** ~7 x-axis labels spanning the range, ending in "now". */
export function xAxisLabels(now: number, range: RangeId): string[] {
  const { ms } = rangeById(range);
  const n = 6;
  const labels: string[] = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(now - ms + (i * ms) / n);
    if (range === "24h") {
      labels.push(`${String(d.getHours()).padStart(2, "0")}:00`);
    } else if (range === "7d") {
      labels.push(d.toLocaleDateString(undefined, { weekday: "short" }));
    } else {
      labels.push(`${d.getMonth() + 1}/${d.getDate()}`);
    }
  }
  labels.push("now");
  return labels;
}

/** SVG polyline path for a value series (design's linePath geometry). */
export function linePath(
  vals: number[],
  max: number,
  w: number,
  h: number,
  pad: number,
): string {
  if (vals.length === 0) return "";
  const step = vals.length > 1 ? w / (vals.length - 1) : 0;
  return vals
    .map((v, i) => {
      const x = i * step;
      const y = h - pad - (v / Math.max(1, max)) * (h - pad * 2);
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");
}

// --- outcomes donut ---------------------------------------------------------

export interface Outcomes {
  succeeded: number;
  waiting: number;
  failed: number;
  /** Classified runs only (succeeded + waiting + failed). */
  total: number;
  okPct: number;
  warnPct: number;
  badPct: number;
}

const WAITING = new Set(["running", "awaiting_approval", "awaiting_webhook"]);

/** Run-outcome shares for the donut: succeeded / paused·waiting / failed. */
export function runOutcomes(runs: RunSummary[]): Outcomes {
  let succeeded = 0;
  let waiting = 0;
  let failed = 0;
  for (const r of runs) {
    if (r.status === "completed") succeeded += 1;
    else if (WAITING.has(r.status)) waiting += 1;
    else if (isFailure(r.status)) failed += 1;
  }
  const total = succeeded + waiting + failed;
  const pct = (v: number) => (total > 0 ? (v / total) * 100 : 0);
  return {
    succeeded,
    waiting,
    failed,
    total,
    okPct: pct(succeeded),
    warnPct: pct(waiting),
    badPct: pct(failed),
  };
}

// --- failure reasons --------------------------------------------------------

export interface FailureReason {
  label: string;
  count: number;
  /** Share of the top reason's count, 0..100 (bar width). */
  pct: number;
}

/**
 * Failed terminal runs grouped by their close reason — the status itself IS the
 * reason on this API (timed_out / budget_exceeded / rejected / circuit_open /
 * failed / …), labelled via the shared run-status map.
 */
export function failureReasons(runs: RunSummary[], top = 5): FailureReason[] {
  const counts = new Map<string, number>();
  for (const r of runs) {
    if (!isFailure(r.status)) continue;
    const label = runStatusUi(r.status).label;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const rows = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, top);
  const max = rows.length > 0 ? rows[0][1] : 0;
  return rows.map(([label, count]) => ({
    label,
    count,
    pct: max > 0 ? (count / max) * 100 : 0,
  }));
}

// --- audit categorisation ---------------------------------------------------

/** Real event families derivable from the audit rows we actually store
 *  (method + path — there is no explicit type/env column). */
export type AuditCategory =
  "run" | "approval" | "workflow" | "security" | "config";

export function auditCategory(e: Pick<AuditEvent, "path">): AuditCategory {
  const p = e.path;
  if (/\/approve$|\/approvals(\/|$)/.test(p)) return "approval";
  if (/\/executions(\/|$)|\/schedules(\/|$)/.test(p)) return "run";
  if (/\/graphs(\/|$)/.test(p)) return "workflow";
  if (
    /\/credentials(\/|$)|\/secrets(\/|$)|\/tokens(\/|$)|\/members(\/|$)|\/invitations(\/|$)|\/groups(\/|$)|\/connections(\/|$)/.test(
      p,
    )
  )
    return "security";
  return "config";
}

export type AuditFilterId = "all" | AuditCategory;

/** Filter chips — only families the interceptor actually records. */
export const AUDIT_FILTERS: { id: AuditFilterId; label: string }[] = [
  { id: "all", label: "All" },
  { id: "run", label: "Runs" },
  { id: "approval", label: "Approvals" },
  { id: "workflow", label: "Workflows" },
  { id: "security", label: "Security" },
];

export function filterAudit(
  events: AuditEvent[],
  filter: AuditFilterId,
): AuditEvent[] {
  if (filter === "all") return events;
  return events.filter((e) => auditCategory(e) === filter);
}
