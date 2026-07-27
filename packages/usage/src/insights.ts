/**
 * Insights = the usage ledger rolled up along the dimensions a cost dashboard needs: over time (by
 * UTC day), by environment, by workflow, and by model. PURE — no DB, no clock — so it's fully
 * unit-testable and the API service just feeds it rows + an executionId→workflowKey map. The ledger
 * stores tokens + cost only (never prompt/completion text), so nothing sensitive flows through here.
 */

/** The minimal shape of a ledger row this aggregation needs (a subset of Prisma's UsageEvent). */
export interface InsightsEvent {
  executionId: string;
  environmentId: string | null;
  provider: string;
  model: string;
  totalTokens: number;
  /** Already a number (Prisma Decimal → Number at the call site). */
  costUsd: number;
  createdAt: Date | string;
  /** Node-type tag (Slice 2) — null for pre-feature rows (bucketed under null, never guessed). */
  nodeType?: string | null;
  /** In-activity measured call duration (Slice 2) — null/absent rows contribute no duration. */
  durationMs?: number | null;
}

export interface InsightsBucketTotals {
  costUsd: number;
  totalTokens: number;
  calls: number;
}

export interface InsightsResult {
  range: { from: string | null; to: string | null };
  totals: InsightsBucketTotals;
  /** One entry per UTC day in which there was spend, ascending by date. */
  byDay: Array<{ date: string } & InsightsBucketTotals>;
  /** Per environment; `environmentId: null` holds pre-Slice-6a (untagged) rows. Desc by cost. */
  byEnvironment: Array<{ environmentId: string | null } & InsightsBucketTotals>;
  /** Per workflow; `workflowKey: null` holds runs with no key (pre-migration). Desc by cost. */
  byWorkflow: Array<{ workflowKey: string | null } & InsightsBucketTotals>;
  /** Per provider/model. Desc by cost. */
  byModel: Array<{ provider: string; model: string } & InsightsBucketTotals>;
  /** Per node TYPE (Slice 2 — from the stamped UsageEvent.nodeType, no graph join).
   *  `nodeType: null` holds pre-feature rows (kept so bucket sums still match totals).
   *  `avgDurationMs` averages only rows that carry a real measured duration — null when
   *  none do (never fabricated). Desc by cost. */
  byNodeType: Array<
    {
      nodeType: string | null;
      avgDurationMs: number | null;
    } & InsightsBucketTotals
  >;
}

// ---- Run-outcome rollups (Slice 2) — from the Execution read-model, NOT the ledger ----

/** The minimal Execution-row shape the run rollups need. */
export interface RunRollupRow {
  workflowKey: string | null;
  status: string;
  createdAt: Date | string;
  /** Terminal-transition stamp; null = in-flight or pre-feature (contributes no duration). */
  finishedAt: Date | string | null;
  /** Compact failure classification; null falls back to the status (pre-feature rows). */
  failureKind?: string | null;
}

/** Terminal statuses that count as a FAILURE for the failure-reason rollup. */
const FAILURE_STATUSES = new Set([
  "rejected",
  "budget_exceeded",
  "circuit_open",
  "invalid_graph",
  "failed",
  "timed_out",
  "terminated",
  "canceled",
]);

export interface RunsRollup {
  /** Per-UTC-day run counts by status (ALL runs started that day, incl. still-running) —
   *  the un-capped source for Observe's throughput series + 30d KPI floors. Ascending. */
  runsByDay: Array<{
    date: string;
    total: number;
    byStatus: Record<string, number>;
  }>;
  /** Per workflow: run count + average duration over runs with a real finishedAt
   *  (null when none have one). Desc by run count. */
  runsByWorkflow: Array<{
    workflowKey: string | null;
    runs: number;
    avgDurationMs: number | null;
  }>;
  /** Failure-reason counts: `failureKind` when present, else the close status (the
   *  documented fallback for pre-feature rows). Desc by count. */
  failureKinds: Array<{ kind: string; count: number }>;
}

/** Duration of one run in ms, or null when it has no real finishedAt (never fabricated). */
function runDurationMs(r: RunRollupRow): number | null {
  if (r.finishedAt === null) return null;
  const started =
    r.createdAt instanceof Date
      ? r.createdAt.getTime()
      : new Date(r.createdAt).getTime();
  const finished =
    r.finishedAt instanceof Date
      ? r.finishedAt.getTime()
      : new Date(r.finishedAt).getTime();
  if (Number.isNaN(started) || Number.isNaN(finished)) return null;
  return Math.max(0, finished - started);
}

/**
 * Roll up Execution rows into per-day outcome counts, per-workflow duration averages, and
 * failure-reason counts (Slice 2). PURE — the API feeds it tenant-scoped (and, for
 * restricted actors, view-filtered) rows for the requested window.
 */
export function aggregateRuns(rows: RunRollupRow[]): RunsRollup {
  const day = new Map<
    string,
    { date: string; total: number; byStatus: Record<string, number> }
  >();
  const wf = new Map<
    string,
    {
      workflowKey: string | null;
      runs: number;
      durTotal: number;
      durCount: number;
    }
  >();
  const kinds = new Map<string, number>();

  for (const r of rows) {
    // Defensive: a row whose createdAt doesn't parse can't be bucketed anywhere —
    // skip it rather than throwing away the whole rollup.
    const created =
      r.createdAt instanceof Date ? r.createdAt : new Date(r.createdAt);
    if (Number.isNaN(created.getTime())) continue;
    const d = utcDay(created);
    const bucket = day.get(d) ?? { date: d, total: 0, byStatus: {} };
    bucket.total += 1;
    bucket.byStatus[r.status] = (bucket.byStatus[r.status] ?? 0) + 1;
    day.set(d, bucket);

    const key = r.workflowKey ?? " null";
    const w = wf.get(key) ?? {
      workflowKey: r.workflowKey,
      runs: 0,
      durTotal: 0,
      durCount: 0,
    };
    w.runs += 1;
    const dur = runDurationMs(r);
    if (dur !== null) {
      w.durTotal += dur;
      w.durCount += 1;
    }
    wf.set(key, w);

    if (FAILURE_STATUSES.has(r.status)) {
      const kind = r.failureKind ?? r.status;
      kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
    }
  }

  return {
    runsByDay: [...day.values()].sort((a, b) => a.date.localeCompare(b.date)),
    runsByWorkflow: [...wf.values()]
      .map((w) => ({
        workflowKey: w.workflowKey,
        runs: w.runs,
        avgDurationMs:
          w.durCount > 0 ? Math.round(w.durTotal / w.durCount) : null,
      }))
      .sort((a, b) => b.runs - a.runs),
    failureKinds: [...kinds.entries()]
      .map(([kind, count]) => ({ kind, count }))
      .sort((a, b) => b.count - a.count),
  };
}

const round6 = (n: number): number => Number(n.toFixed(6));

/** The UTC calendar day (YYYY-MM-DD) of a timestamp — the time-series bucket key. */
function utcDay(ts: Date | string): string {
  const d = ts instanceof Date ? ts : new Date(ts);
  return d.toISOString().slice(0, 10);
}

/** Accumulate one event into a keyed bucket map. */
function bump<T>(
  map: Map<string, T & InsightsBucketTotals>,
  key: string,
  seed: () => T,
  e: InsightsEvent,
): void {
  const cur = map.get(key) ?? {
    ...seed(),
    costUsd: 0,
    totalTokens: 0,
    calls: 0,
  };
  cur.costUsd += e.costUsd;
  cur.totalTokens += e.totalTokens;
  cur.calls += 1;
  map.set(key, cur as T & InsightsBucketTotals);
}

/** Round every bucket's cost to 6dp (mirrors the ledger's precision). */
function finalize<T>(
  rows: Array<T & InsightsBucketTotals>,
): Array<T & InsightsBucketTotals> {
  return rows.map((r) => ({ ...r, costUsd: round6(r.costUsd) }));
}

const byCostDesc = (a: InsightsBucketTotals, b: InsightsBucketTotals): number =>
  b.costUsd - a.costUsd;

/**
 * Roll up ledger rows into the insights breakdowns. `workflowKeyByExec` maps a run's executionId to
 * its workflowKey (from the Execution table); a missing entry → `null` (unknown/pre-migration run).
 * `range` is echoed back verbatim (the caller's requested window, or nulls for "all time").
 */
export function aggregateInsights(
  events: InsightsEvent[],
  workflowKeyByExec: Map<string, string | null>,
  range: { from: string | null; to: string | null } = { from: null, to: null },
): InsightsResult {
  let totalCost = 0;
  let totalTokens = 0;
  const day = new Map<string, InsightsBucketTotals & { date: string }>();
  const env = new Map<
    string,
    InsightsBucketTotals & { environmentId: string | null }
  >();
  const wf = new Map<
    string,
    InsightsBucketTotals & { workflowKey: string | null }
  >();
  const model = new Map<
    string,
    InsightsBucketTotals & { provider: string; model: string }
  >();
  // Per node type (Slice 2). Duration totals tracked beside the bucket so the average
  // covers ONLY rows with a real measured duration (durCount) — never fabricated.
  const nodeType = new Map<
    string,
    InsightsBucketTotals & {
      nodeType: string | null;
      durTotal: number;
      durCount: number;
    }
  >();

  for (const e of events) {
    totalCost += e.costUsd;
    totalTokens += e.totalTokens;

    bump(day, utcDay(e.createdAt), () => ({ date: utcDay(e.createdAt) }), e);
    bump(
      env,
      e.environmentId ?? "\0null",
      () => ({ environmentId: e.environmentId ?? null }),
      e,
    );
    const key = workflowKeyByExec.get(e.executionId) ?? null;
    bump(wf, key ?? "\0null", () => ({ workflowKey: key }), e);
    bump(
      model,
      `${e.provider}/${e.model}`,
      () => ({ provider: e.provider, model: e.model }),
      e,
    );
    const nt = e.nodeType ?? null;
    const ntKey = nt ?? " null";
    bump(
      nodeType,
      ntKey,
      () => ({ nodeType: nt, durTotal: 0, durCount: 0 }),
      e,
    );
    if (e.durationMs !== undefined && e.durationMs !== null) {
      const b = nodeType.get(ntKey)!;
      b.durTotal += e.durationMs;
      b.durCount += 1;
    }
  }

  return {
    range,
    totals: {
      costUsd: round6(totalCost),
      totalTokens,
      calls: events.length,
    },
    // Time-series ascending by date so a chart can render left→right without re-sorting.
    byDay: finalize([...day.values()]).sort((a, b) =>
      a.date.localeCompare(b.date),
    ),
    byEnvironment: finalize([...env.values()]).sort(byCostDesc),
    byWorkflow: finalize([...wf.values()]).sort(byCostDesc),
    byModel: finalize([...model.values()]).sort(byCostDesc),
    byNodeType: finalize(
      [...nodeType.values()].map(({ durTotal, durCount, ...bucket }) => ({
        ...bucket,
        avgDurationMs: durCount > 0 ? Math.round(durTotal / durCount) : null,
      })),
    ).sort(byCostDesc),
  };
}
