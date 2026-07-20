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

/** One day of the server's run-outcome rollup (insights.runsByDay — Slice 2). */
export interface RunsByDayRow {
  date: string;
  total: number;
  byStatus: Record<string, number>;
}

/**
 * Day-bucketed succeeded/failed series from the SERVER's runsByDay rollup
 * (Slice 2) — un-capped, unlike the 50-row runs list. Null for the 24h range
 * (the rollup is day-granular; the list-derived hourly series stays honest
 * there) and when the API predates the rollup.
 */
export function throughputFromRollup(
  days: RunsByDayRow[] | undefined,
  now: number,
  range: RangeId,
): SeriesBucket[] | null {
  if (!days || range === "24h") return null;
  const { ms, days: n } = rangeById(range);
  const from = now - ms;
  const buckets: SeriesBucket[] = Array.from({ length: n }, () => ({
    ok: 0,
    bad: 0,
  }));
  for (const d of days) {
    const t = Date.parse(`${d.date}T00:00:00Z`);
    if (Number.isNaN(t) || t > now || t < from - 86_400_000) continue;
    const i = Math.min(n - 1, Math.max(0, Math.floor((t - from) / 86_400_000)));
    for (const [status, count] of Object.entries(d.byStatus)) {
      if (status === "completed") buckets[i].ok += count;
      else if (isFailure(status)) buckets[i].bad += count;
    }
  }
  return buckets;
}

/** Total runs in the range from the server rollup (un-capped); null for 24h /
 *  an API without the rollup — the caller falls back to the (capped) list count. */
export function totalRunsFromRollup(
  days: RunsByDayRow[] | undefined,
  now: number,
  range: RangeId,
): number | null {
  if (!days || range === "24h") return null;
  const { ms } = rangeById(range);
  const from = now - ms;
  let total = 0;
  for (const d of days) {
    const t = Date.parse(`${d.date}T00:00:00Z`);
    if (Number.isNaN(t) || t > now || t < from - 86_400_000) continue;
    total += d.total;
  }
  return total;
}

/**
 * Bucket runs into succeeded/failed counts across the range: 12 × 2h buckets
 * for 24h, one bucket per day otherwise. Derived client-side from the run list
 * — used for 24h (hour-granular) and as the fallback when the server's
 * runsByDay rollup (Slice 2) is unavailable.
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

/** Display labels for the worker's compact failureKind classification (Slice 2). */
const FAILURE_KIND_LABEL: Record<string, string> = {
  timeout: "Timed out",
  upstream_5xx: "Upstream 5xx",
  rate_limit: "Rate limited",
  budget: "Budget exceeded",
  rejected: "Rejected",
  error: "Error",
};

/**
 * Failed terminal runs grouped by reason: the worker's `failureKind`
 * classification when recorded (Slice 2), else the close status itself
 * (pre-feature runs), labelled via the shared run-status map.
 */
export function failureReasons(runs: RunSummary[], top = 5): FailureReason[] {
  const counts = new Map<string, number>();
  for (const r of runs) {
    if (!isFailure(r.status)) continue;
    const label = r.failureKind
      ? (FAILURE_KIND_LABEL[r.failureKind] ?? r.failureKind)
      : runStatusUi(r.status).label;
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

// --- latency (real worker-stamped durations — Slice 2) ----------------------

export interface LatencyStats {
  medianMs: number;
  /** How many runs in the range carry a real duration (the sample size shown). */
  sample: number;
  histogram: { label: string; count: number }[];
}

const LATENCY_BUCKETS: { label: string; maxMs: number }[] = [
  { label: "<1s", maxMs: 1_000 },
  { label: "1–5s", maxMs: 5_000 },
  { label: "5–15s", maxMs: 15_000 },
  { label: "15–60s", maxMs: 60_000 },
  { label: "1–5m", maxMs: 300_000 },
  { label: ">5m", maxMs: Number.POSITIVE_INFINITY },
];

/**
 * Median + distribution over the REAL run durations in the list (worker-stamped
 * finishedAt − createdAt, Slice 2). Runs without one (in-flight / pre-feature)
 * contribute nothing; null when NO run carries a duration — the KPI/histogram
 * then keep their honest empty state.
 */
export function latencyStats(runs: RunSummary[]): LatencyStats | null {
  const ds = runs
    .map((r) => r.durationMs)
    .filter((v): v is number => typeof v === "number")
    .sort((a, b) => a - b);
  if (ds.length === 0) return null;
  const mid = Math.floor(ds.length / 2);
  const medianMs = ds.length % 2 === 1 ? ds[mid] : (ds[mid - 1] + ds[mid]) / 2;
  const histogram = LATENCY_BUCKETS.map((b) => ({ label: b.label, count: 0 }));
  for (const v of ds) {
    histogram[LATENCY_BUCKETS.findIndex((b) => v < b.maxMs)].count += 1;
  }
  return { medianMs, sample: ds.length, histogram };
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
