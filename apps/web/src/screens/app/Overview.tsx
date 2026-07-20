import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  type AuditEvent,
  type AwaitingApproval,
  type RunSummary,
  UnauthorizedError,
} from "../../lib/api";
import { BELOW_RAIL_QUERY, useMediaQuery } from "../../lib/useMediaQuery";
import { ActivityCard } from "./overview/ActivityCard";
import { ApprovalQueueCard } from "./overview/ApprovalQueueCard";
import { AttentionRow } from "./overview/AttentionRow";
import { BusiestWorkflowsCard } from "./overview/BusiestWorkflowsCard";
import {
  ageMs,
  budgetStoppedLast24h,
  busiestWorkflows,
  DAY,
  failuresLast24h,
  hourlyBuckets,
  runsLast24h,
} from "./overview/overview-model";
import { RunsSparklineCard } from "./overview/RunsSparklineCard";

/* ------------------------------------------------------------------
 * Overview — leads with WHAT NEEDS A HUMAN, not vanity counters
 * (redesign: Naary Overview.dc.html). Fixed composition:
 *   1. "Needs your attention" hero row (approvals / budget-stopped / failures)
 *   2. Top of the approval queue (decide-in-place) · 24h sparkline · activity
 *   3. Busiest workflows strip
 * Every number derives from real control-plane data: the runs list, the
 * awaiting-approvals inbox, and the audit log. The old customizable
 * DashboardGrid arrangement is retired here in favor of this composition.
 * ---------------------------------------------------------------- */

/** Honest sub-line for the failures card, e.g. "2 timed out · 1 failed". */
function failureHint(failures: RunSummary[]): string {
  if (failures.length === 0) return "No failures";
  const timedOut = failures.filter((r) => r.status === "timed_out").length;
  const failed = failures.length - timedOut;
  const parts: string[] = [];
  if (failed > 0) parts.push(`${failed} failed`);
  if (timedOut > 0) parts.push(`${timedOut} timed out`);
  return parts.join(" · ");
}

export function Overview() {
  // The asymmetric queue/health split collapses to one column at/below the
  // tablet threshold (≤1024). The KPI + workflow card grids flow on their own
  // via auto-fit — no JS breakpoint needed for those.
  const belowRail = useMediaQuery(BELOW_RAIL_QUERY);

  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [awaiting, setAwaiting] = useState<AwaitingApproval[] | null>(null);
  const [audit, setAudit] = useState<AuditEvent[] | null>(null);
  const [auditErr, setAuditErr] = useState(false);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<"unauth" | "error" | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const liveRef = useRef(true);

  const load = useCallback(async () => {
    try {
      const [runsRes, awaitingRes] = await Promise.all([
        api.listRuns(),
        api.listAwaitingApprovals(),
      ]);
      if (!liveRef.current) return;
      setRuns(runsRes);
      setAwaiting(awaitingRes);
      setErr(null);
    } catch (e) {
      if (liveRef.current)
        setErr(e instanceof UnauthorizedError ? "unauth" : "error");
    } finally {
      if (liveRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    liveRef.current = true;
    void load();
    // The audit feed is a nice-to-have — its card degrades to "—" on failure.
    (async () => {
      try {
        const me = await api.getMe();
        const rows = await api.getAuditLog(me.tenantId);
        // Defensive: an unexpected non-array response degrades like a failure.
        if (liveRef.current) setAudit(Array.isArray(rows) ? rows : []);
      } catch {
        if (liveRef.current) setAuditErr(true); // card degrades to "—"
      }
    })();
    return () => {
      liveRef.current = false;
    };
  }, [load]);

  /** Decide-in-place from the queue preview (same call the Approvals inbox makes). */
  const approve = useCallback(
    async (item: AwaitingApproval) => {
      setBusyId(item.workflowId);
      try {
        await api.approve(item.workflowId, true);
        // Drop it from the preview immediately; a reload reconciles the rest.
        setAwaiting((xs) =>
          (xs ?? []).filter((x) => x.workflowId !== item.workflowId),
        );
      } catch {
        // Decided elsewhere / timed out — reload to reconcile.
        await load();
      } finally {
        if (liveRef.current) setBusyId(null);
      }
    },
    [load],
  );

  const now = Date.now();
  const runList = runs ?? [];
  const awaitingList = awaiting ?? [];

  const last24 = runsLast24h(runList, now);
  const failures = failuresLast24h(runList, now);
  const budgetStopped = budgetStoppedLast24h(runList, now);
  const approvalAges = awaitingList.map((a) => ageMs(a.createdAt, now));
  const oldestApprovalMs =
    approvalAges.length > 0 ? Math.max(...approvalAges) : null;
  const breachedCount = approvalAges.filter((ms) => ms > DAY).length;
  // Oldest first — the top of the queue is what's waited longest.
  const queue = [...awaitingList].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );

  const subline = err
    ? err === "unauth"
      ? "Set your API token on the sign-in screen to load data."
      : "Couldn't load dashboard data."
    : loading
      ? "Loading…"
      : `${runList.length} recent run${runList.length === 1 ? "" : "s"} · ${
          awaitingList.length
        } awaiting approval`;

  return (
    <div style={{ padding: "24px 28px 40px", maxWidth: 1300 }}>
      {/* Screen-scoped styles: sparkline grow-in + attention-card hover
          (inline styles can't express :hover; !important beats them). */}
      <style>
        {"@keyframes ovGrowBar{from{height:0;}}" +
          ".ov-att:hover{border-color:var(--line-2)!important;box-shadow:var(--shadow-raised)!important;}"}
      </style>

      {/* ---- header (the shell already carries workspace/env context) ---- */}
      <div style={{ marginBottom: 22 }}>
        <div
          style={{
            fontSize: "var(--text-title)",
            fontWeight: "var(--weight-bold)",
            color: "var(--ink)",
            letterSpacing: "var(--tracking-tight)",
          }}
        >
          Overview
        </div>
        <div
          style={{
            fontSize: "var(--text-body)",
            color: "var(--ink-2)",
            marginTop: 4,
          }}
        >
          {subline}
        </div>
      </div>

      <AttentionRow
        loading={loading}
        errored={err !== null}
        approvalsCount={awaitingList.length}
        oldestApprovalMs={oldestApprovalMs}
        breachedCount={breachedCount}
        budgetStoppedCount={budgetStopped.length}
        failureCount={failures.length}
        failureHint={failureHint(failures)}
      />

      <div
        style={{
          display: "grid",
          // ≤1024: single column, approval queue on top (human-in-the-loop first).
          gridTemplateColumns: belowRail ? "1fr" : "1.5fr 1fr",
          gap: 16,
          alignItems: "start",
        }}
      >
        <ApprovalQueueCard
          loading={loading}
          errored={err !== null}
          items={queue}
          busyId={busyId}
          onApprove={(item) => void approve(item)}
        />
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <RunsSparklineCard
            loading={loading}
            errored={err !== null}
            buckets={hourlyBuckets(runList, now)}
            total={last24.length}
          />
          <ActivityCard events={audit} loading={audit === null && !auditErr} />
        </div>
      </div>

      <BusiestWorkflowsCard
        loading={loading}
        errored={err !== null}
        workflows={busiestWorkflows(runList, now)}
      />
    </div>
  );
}
