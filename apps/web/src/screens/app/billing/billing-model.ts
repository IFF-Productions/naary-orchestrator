/**
 * Pure shaping for the Usage & budgets screen — no React, no DOM (unit-testable
 * like insights.logic). Everything here derives from REAL control-plane data:
 * BudgetView (caps + policy + live MTD spend), the usage ledger's line items
 * (per-call model/cost/createdAt), the insights rollups, and the runs list.
 */
import type {
  BudgetView,
  InsightsReport,
  RunSummary,
  UsageEventItem,
} from "../../../lib/api";

const DAY_MS = 86_400_000;

/* ---------------- billing month window ---------------- */

export interface MonthWindow {
  /** ISO date of the 1st (UTC) — the `from` for month-scoped queries. */
  fromISO: string;
  /** e.g. "Jul 1–31" */
  label: string;
  daysInMonth: number;
  /** Fractional days elapsed since the 1st (>= a small epsilon). */
  elapsedDays: number;
  /** Whole days left after today (0 on the last day). */
  daysLeft: number;
}

/** The current calendar (billing) month in UTC — matches the ledger's MTD scope. */
export function monthWindow(now: number): MonthWindow {
  const d = new Date(now);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const start = Date.UTC(y, m, 1);
  const daysInMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const monthName = new Date(start).toLocaleString("en-US", {
    month: "short",
    timeZone: "UTC",
  });
  return {
    fromISO: new Date(start).toISOString().slice(0, 10),
    label: `${monthName} 1–${daysInMonth}`,
    daysInMonth,
    elapsedDays: Math.max((now - start) / DAY_MS, 1 / 24),
    daysLeft: daysInMonth - d.getUTCDate(),
  };
}

/** Linear projection: month-to-date spend ÷ elapsed days × days in month. */
export function projectMonthly(mtdSpendUsd: number, win: MonthWindow): number {
  return (mtdSpendUsd / win.elapsedDays) * win.daysInMonth;
}

/* ---------------- enforcement thresholds ---------------- */

/** Dashboard alert threshold (UI convention — the backend has no alert rung). */
export const ALERT_PCT = 80;
/** "Near cap" presentation threshold (mirrors the bar-color flip). */
export const NEAR_PCT = 90;

export type BudgetHealth = "healthy" | "alert" | "near" | "over";

export function budgetHealth(pct: number): BudgetHealth {
  if (pct >= 100) return "over";
  if (pct >= NEAR_PCT) return "near";
  if (pct >= ALERT_PCT) return "alert";
  return "healthy";
}

export const HEALTH_LABEL: Record<BudgetHealth, string> = {
  healthy: "Healthy",
  alert: "Alert threshold",
  near: "Near cap",
  over: "Over cap",
};

/** Spent-so-far as a % of the cap (unclamped — callers clamp for bar widths). */
export function spendPct(budget: BudgetView): number {
  if (budget.monthlyCapUsd <= 0) return 0;
  return (budget.mtdSpendUsd / budget.monthlyCapUsd) * 100;
}

/* ---------------- enforcement ladder ---------------- */

export interface LadderRung {
  /** Threshold chip text ("100%", "$0.05", "50"). */
  at: string;
  title: string;
  desc: string;
  tone: "warn" | "bad" | "neutral";
  /** Lit when current monthly spend has crossed this rung. */
  active: boolean;
}

/**
 * The REAL enforcement ladder from the persisted policy: an optional ALERT rung
 * (`alertThresholdPct` — a real server-side notification since Slice 3, rendered
 * ONLY when configured), one monthly rung — `onBudgetExceeded` at 100% (reject,
 * downgrade, or pause) — plus two per-run guards (per-execution cap, step limit).
 * Without a configured alert, the 80% marker on the meter stays a dashboard-only
 * threshold and no alert rung is invented.
 */
export function enforcementLadder(
  budget: BudgetView,
  pct: number,
): LadderRung[] {
  const rungs: LadderRung[] = [];
  if (budget.alertThresholdPct != null) {
    rungs.push({
      at: `${budget.alertThresholdPct}%`,
      title: "Alert",
      desc: "A budget alert goes to your notification channels when monthly spend crosses this — at most once per calendar month.",
      tone: "warn",
      active: pct >= budget.alertThresholdPct,
    });
  }
  if (budget.onBudgetExceeded === "pause") {
    rungs.push({
      at: "100%",
      title: "Pause",
      desc: "At the monthly cap, runs park as awaiting budget and resume automatically when you raise the cap or the month rolls over.",
      tone: "warn",
      active: pct >= 100,
    });
  } else if (budget.onBudgetExceeded === "downgrade") {
    rungs.push({
      at: "100%",
      title: "Downgrade",
      desc: `At the monthly cap, agent calls swap to ${
        budget.fallbackModel ?? "the configured fallback model"
      } instead of stopping.`,
      tone: "warn",
      active: pct >= 100,
    });
  } else {
    rungs.push({
      at: "100%",
      title: "Reject over cap",
      desc: "At the monthly cap, new runs are rejected and in-flight agent calls stop as budget_exceeded.",
      tone: "bad",
      active: pct >= 100,
    });
  }
  rungs.push({
    at: usd(budget.perExecutionCapUsd),
    title: "Per-run cap",
    desc: "A single run that reaches this stops as budget_exceeded rather than overspending.",
    tone: "neutral",
    active: false,
  });
  rungs.push({
    at: String(budget.maxStepsPerRun),
    title: "Step limit / run",
    desc: `Runs stop after ${budget.maxStepsPerRun} agent steps — the runaway-loop guard.`,
    tone: "neutral",
    active: false,
  });
  return rungs;
}

/* ---------------- guardrail-hit runs ---------------- */

/**
 * Recent runs stopped by a budget cap (status budget_exceeded) this billing
 * month. "Recent" because /executions returns the latest page, not all history.
 */
export function budgetStoppedThisMonth(
  runs: RunSummary[],
  win: MonthWindow,
): RunSummary[] {
  const from = new Date(`${win.fromISO}T00:00:00Z`).getTime();
  return runs.filter(
    (r) =>
      r.status === "budget_exceeded" && new Date(r.createdAt).getTime() >= from,
  );
}

/** Runs currently PARKED on budget (status awaiting_budget, policy "pause" — Slice 3).
 *  No month window: a paused run is live state, not history. */
export function budgetPausedRuns(runs: RunSummary[]): RunSummary[] {
  return runs.filter((r) => r.status === "awaiting_budget");
}

/* ---------------- stacked spend-over-time ---------------- */

/** Narrow the ledger's `events: unknown[]` to the fields the chart needs. */
export function parseUsageEvents(events: unknown[]): UsageEventItem[] {
  const out: UsageEventItem[] = [];
  for (const e of events) {
    if (typeof e !== "object" || e === null) continue;
    const r = e as Record<string, unknown>;
    if (
      typeof r.model === "string" &&
      typeof r.provider === "string" &&
      typeof r.createdAt === "string" &&
      typeof r.costUsd === "number"
    ) {
      out.push(r as unknown as UsageEventItem);
    }
  }
  return out;
}

/** How many models get their own stack slot; the rest fold into "Other". */
export const STACK_SLOTS = 4;

export interface StackSeries {
  /** provider/model key, or "other". */
  key: string;
  /** Display label (bare model name, or "Other"). */
  label: string;
}

export interface StackDay {
  /** ISO date (UTC). */
  date: string;
  /** Short label, e.g. "Jul 4". */
  label: string;
  total: number;
  /** Cost per series, aligned with the series array. */
  parts: number[];
}

export interface StackedSpend {
  series: StackSeries[];
  days: StackDay[];
  max: number;
}

const eventKey = (e: { provider: string; model: string }) =>
  `${e.provider}/${e.model}`;

function shortDay(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/**
 * Stack the ledger's line items by UTC day and model. `ranking` fixes the series
 * order (top-cost models from the insights byModel rollup — the SAME source, so
 * the chart legend and the Cost-by-model card agree); models beyond
 * {@link STACK_SLOTS} fold into "Other". Days span `fromISO`..today inclusive
 * so quiet days render as gaps, not omissions.
 */
export function stackSpendByDay(
  events: UsageEventItem[],
  ranking: { provider: string; model: string }[],
  fromISO: string,
  now: number,
): StackedSpend {
  const top = ranking.slice(0, STACK_SLOTS);
  const series: StackSeries[] = top.map((m) => ({
    key: eventKey(m),
    label: m.model,
  }));
  const hasOther = ranking.length > STACK_SLOTS;
  if (hasOther) series.push({ key: "other", label: "Other" });
  const slot = new Map(series.map((s, i) => [s.key, i]));

  const byDate = new Map<string, number[]>();
  for (const e of events) {
    const date = e.createdAt.slice(0, 10);
    let parts = byDate.get(date);
    if (!parts) {
      parts = new Array<number>(series.length).fill(0);
      byDate.set(date, parts);
    }
    const i = slot.get(eventKey(e)) ?? (hasOther ? series.length - 1 : -1);
    if (i >= 0) parts[i] += e.costUsd;
  }

  const start = new Date(`${fromISO}T00:00:00Z`).getTime();
  const days: StackDay[] = [];
  let max = 0;
  for (let t = start; t <= now; t += DAY_MS) {
    const date = new Date(t).toISOString().slice(0, 10);
    const parts = byDate.get(date) ?? new Array<number>(series.length).fill(0);
    const total = parts.reduce((s, v) => s + v, 0);
    max = Math.max(max, total);
    days.push({ date, label: shortDay(date), total, parts });
  }
  return { series, days, max };
}

/** Earliest event date (ISO) — the "All time" window start. Falls back to today. */
export function earliestEventDate(
  events: UsageEventItem[],
  now: number,
): string {
  let min = Number.POSITIVE_INFINITY;
  for (const e of events) {
    const t = new Date(e.createdAt).getTime();
    if (!Number.isNaN(t) && t < min) min = t;
  }
  return new Date(Number.isFinite(min) ? min : now).toISOString().slice(0, 10);
}

/* ---------------- model ranking / colors ---------------- */

/** Top-cost models from the insights rollup — the shared series ranking. */
export function rankModels(byModel: InsightsReport["byModel"]): {
  provider: string;
  model: string;
  costUsd: number;
  totalTokens: number;
  calls: number;
}[] {
  return [...byModel].sort((a, b) => b.costUsd - a.costUsd);
}

/**
 * Fixed categorical order for model series (design node accents; the order
 * violet → teal → orange → blue passes the CVD-separation + normal-vision
 * checks on both themes). "Other" is deliberately muted.
 */
export const MODEL_STACK_COLORS = [
  "var(--node-agent)", // violet
  "var(--node-approval)", // teal
  "var(--node-http)", // orange
  "var(--node-mcp)", // blue
];
export const MODEL_OTHER_COLOR = "var(--ink-3)";

/** Color for the i-th ranked model (rank order is fixed per screen load). */
export function modelColor(rank: number): string {
  return rank < MODEL_STACK_COLORS.length
    ? MODEL_STACK_COLORS[rank]
    : MODEL_OTHER_COLOR;
}

/* ---------------- formatting ---------------- */

export function usd(n: number): string {
  // Defensive: a malformed payload renders "—" instead of white-screening.
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  const small = n > 0 && n < 1;
  return `$${n.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: small ? 4 : 2,
  })}`;
}

/** Compact token count: 1.2k · 18.2M · 1.1B. */
export function fmtTokens(n: number): string {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return n.toLocaleString();
}
