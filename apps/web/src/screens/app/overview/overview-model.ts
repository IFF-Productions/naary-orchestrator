/**
 * Overview screen — pure derivations over the real control-plane data
 * (runs list, awaiting-approvals list). No fabricated numbers: everything
 * here is computed from what the API returned, relative to a caller-supplied
 * `now` so the functions stay deterministic and testable.
 */
import type { RunSummary } from "../../../lib/api";

const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

/** Compact relative time from an ISO timestamp (no date lib). */
export function ago(iso: string, now = Date.now()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const s = Math.max(0, Math.round((now - then) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** Waiting-age in ms for an ISO timestamp (NaN-safe → 0). */
export function ageMs(iso: string, now = Date.now()): number {
  const then = new Date(iso).getTime();
  return Number.isNaN(then) ? 0 : Math.max(0, now - then);
}

/** "2d 4h" / "6h 12m" / "45m" / "<1m" — the waiting-age chip text. */
export function formatAge(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${m % 60 ? ` ${m % 60}m` : ""}`;
  const d = Math.floor(h / 24);
  return `${d}d${h % 24 ? ` ${h % 24}h` : ""}`;
}

/** Chip tone by waiting age: >24h bad, >4h warn, else neutral. */
export type AgeTone = "bad" | "warn" | "neutral";
export function ageTone(ms: number): AgeTone {
  if (ms > DAY) return "bad";
  if (ms > 4 * HOUR) return "warn";
  return "neutral";
}

const startedWithin = (r: RunSummary, now: number, windowMs: number) => {
  const t = new Date(r.startedAt).getTime();
  return !Number.isNaN(t) && now - t <= windowMs && t <= now;
};

/** Runs started in the last 24h. */
export function runsLast24h(
  runs: RunSummary[],
  now = Date.now(),
): RunSummary[] {
  return runs.filter((r) => startedWithin(r, now, DAY));
}

/** Hard failures in the last 24h (failed / timed_out — the "go look" bucket). */
export function failuresLast24h(
  runs: RunSummary[],
  now = Date.now(),
): RunSummary[] {
  return runsLast24h(runs, now).filter(
    (r) => r.status === "failed" || r.status === "timed_out",
  );
}

/** Runs stopped by the budget guardrail in the last 24h (status budget_exceeded). */
export function budgetStoppedLast24h(
  runs: RunSummary[],
  now = Date.now(),
): RunSummary[] {
  return runsLast24h(runs, now).filter((r) => r.status === "budget_exceeded");
}

/** Runs currently PARKED on budget (status awaiting_budget, policy "pause" — Slice 3).
 *  Live state, so no 24h window — a paused run needs attention until it resumes. */
export function budgetPausedNow(runs: RunSummary[]): RunSummary[] {
  return runs.filter((r) => r.status === "awaiting_budget");
}

/** 24 hourly buckets, oldest → newest, counting run starts. */
export function hourlyBuckets(runs: RunSummary[], now = Date.now()): number[] {
  const buckets = new Array<number>(24).fill(0);
  for (const r of runs) {
    const t = new Date(r.startedAt).getTime();
    if (Number.isNaN(t) || t > now) continue;
    const hoursAgo = (now - t) / HOUR;
    if (hoursAgo >= 24) continue;
    // hoursAgo 0..24 → index 23 (this hour) .. 0 (24h ago)
    buckets[23 - Math.min(23, Math.floor(hoursAgo))] += 1;
  }
  return buckets;
}

export interface BusyWorkflow {
  /** workflowKey when known (navigates to the workflow), else null. */
  key: string | null;
  /** Display label — the key, or a shortened run id for key-less runs. */
  label: string;
  count: number;
  /** 0..100, proportional to the busiest entry. */
  pct: number;
}

/** Top workflows by run starts in the last 24h, proportional to the leader. */
export function busiestWorkflows(
  runs: RunSummary[],
  now = Date.now(),
  top = 4,
): BusyWorkflow[] {
  const counts = new Map<string, { key: string | null; count: number }>();
  for (const r of runsLast24h(runs, now)) {
    const id = r.workflowKey ?? `__run:${r.workflowId}`;
    const entry = counts.get(id) ?? { key: r.workflowKey, count: 0 };
    entry.count += 1;
    counts.set(id, entry);
  }
  const sorted = [...counts.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, top);
  const max = sorted[0]?.[1].count ?? 0;
  return sorted.map(([id, { key, count }]) => ({
    key,
    label: key ?? id.replace("__run:", "").slice(0, 18),
    count,
    pct: max > 0 ? Math.round((count / max) * 100) : 0,
  }));
}
