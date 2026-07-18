/**
 * Pure shaping for the Insights section — no React, no DOM — so the windowing/bucketing/formatting
 * is unit-testable in the node vitest env (like lib/timeseries). insights.tsx renders these.
 */
import type { InsightsReport } from "../../lib/api";

export const DEFAULT_WINDOW_DAYS = 30;

/** ISO date (YYYY-MM-DD) `days` before `now` — the default dashboard window start. */
export function windowFromDate(
  now: number,
  days: number = DEFAULT_WINDOW_DAYS,
): string {
  return new Date(now - days * 86_400_000).toISOString().slice(0, 10);
}

export interface Bar {
  label: string;
  value: number;
}

/** byDay → chart bars (value = cost). Already ascending by date from the server. */
export function dayBars(byDay: InsightsReport["byDay"]): Bar[] {
  return byDay.map((d) => ({ label: d.date, value: d.costUsd }));
}

export interface RankedRow {
  label: string;
  costUsd: number;
  calls: number;
  /** Share of the top bucket's cost, 0..100, for the bar width. */
  pct: number;
}

/**
 * Top-`n` buckets by cost (desc), each scaled to the largest for its bar width. `labelOf` maps a
 * bucket to a display label (so a null environment/workflow is labeled, not dropped).
 */
export function rankBuckets<T extends { costUsd: number; calls: number }>(
  rows: T[],
  labelOf: (row: T) => string,
  n = 8,
): RankedRow[] {
  const sorted = [...rows].sort((a, b) => b.costUsd - a.costUsd).slice(0, n);
  const max = Math.max(0, ...sorted.map((r) => r.costUsd));
  return sorted.map((r) => ({
    label: labelOf(r),
    costUsd: r.costUsd,
    calls: r.calls,
    pct: max > 0 ? (r.costUsd / max) * 100 : 0,
  }));
}

export function usd(n: number): string {
  const small = n > 0 && n < 1;
  return `$${n.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: small ? 4 : 2,
  })}`;
}

export const envLabel = (id: string | null): string => id ?? "— untagged";
export const wfLabel = (key: string | null): string => key ?? "— no key";
