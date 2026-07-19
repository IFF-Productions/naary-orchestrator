/**
 * Observe — the unified "what happened" surface (redesign IA): the old Runs /
 * Observability / Activity trio collapsed into one screen with three tabs:
 *
 *   Insights    — KPIs + charts from the run list and the usage-insights
 *                 rollups (GET /tenants/:id/usage/insights, range-scoped).
 *   Runs & logs — the recent-runs table (GET /executions); row → run detail.
 *   Audit       — the tenant audit log (GET /tenants/:id/audit), filterable.
 *
 * Tab state lives in the URL (?tab=insights|runs|audit) so views deep-link;
 * /app/activity now redirects here with ?tab=audit. Environment scoping comes
 * from the shell's env switcher (screens remount on env change) — no local env
 * selector. The 24h/7d/30d control rescopes the Insights tab.
 */
import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  api,
  type AuditEvent,
  type InsightsReport,
  type RunSummary,
  UnauthorizedError,
} from "../../lib/api";
import { windowFromDate } from "./insights.logic";
import { AuditTab } from "./observe/AuditTab";
import { InsightsTab } from "./observe/InsightsTab";
import type { AuditFilterId, RangeId } from "./observe/observe-model";
import { RANGES, rangeById } from "./observe/observe-model";
import { RunsTab } from "./observe/RunsTab";
import { Seg } from "./observe/ui";

type TabId = "insights" | "runs" | "audit";

const TABS: { id: TabId; label: string }[] = [
  { id: "insights", label: "Insights" },
  { id: "runs", label: "Runs & logs" },
  { id: "audit", label: "Audit" },
];

function tabFromParam(v: string | null): TabId {
  return v === "runs" || v === "audit" ? v : "insights";
}

export function Observability() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = tabFromParam(searchParams.get("tab"));
  const setTab = (t: TabId) =>
    setSearchParams(t === "insights" ? {} : { tab: t }, { replace: true });

  // Snapshot the clock once per mount so range windows and relative times are
  // stable across renders (screens remount on env change anyway).
  const [now0] = useState(() => Date.now());
  const [range, setRange] = useState<RangeId>("7d");
  const [auditFilter, setAuditFilter] = useState<AuditFilterId>("all");

  const [tenantId, setTenantId] = useState<string | null>(null);
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [audit, setAudit] = useState<AuditEvent[] | null>(null);
  const [insights, setInsights] = useState<InsightsReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Runs + audit load once per mount (both env-scoped server-side via headers).
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const me = await api.getMe();
        if (!live) return;
        setTenantId(me.tenantId);
        const [r, a] = await Promise.all([
          api.listRuns(),
          api.getAuditLog(me.tenantId),
        ]);
        if (!live) return;
        setRuns(r);
        setAudit(a);
        setError(null);
      } catch (e) {
        if (!live) return;
        setError(
          e instanceof UnauthorizedError
            ? "Sign in to view observability."
            : "Could not reach the control plane (apps/api on :3000).",
        );
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  // Insights rollups re-fetch when the range changes (the API takes a from date).
  const spendFrom = windowFromDate(now0, rangeById(range).days);
  useEffect(() => {
    if (!tenantId) return;
    let live = true;
    setInsights(null);
    api
      .getInsights(tenantId, { from: spendFrom })
      .then((data) => live && setInsights(data))
      .catch(() => live && setInsights(null));
    return () => {
      live = false;
    };
  }, [tenantId, spendFrom]);

  return (
    <div style={{ padding: "22px 28px 48px", maxWidth: 1360 }}>
      {/* keyframes the design's charts use (drawLine); scoped by name prefix */}
      <style>{`@keyframes obDrawLine{from{stroke-dashoffset:900;}to{stroke-dashoffset:0;}}`}</style>

      {/* heading */}
      <div style={{ marginBottom: 16 }}>
        <div
          style={{
            fontSize: "var(--text-title)",
            fontWeight: "var(--weight-bold)",
            color: "var(--ink)",
            letterSpacing: "var(--tracking-tight)",
          }}
        >
          Observe
        </div>
        <div
          style={{
            fontSize: "var(--text-body)",
            color: "var(--ink-2)",
            marginTop: 4,
          }}
        >
          What happened — insights, runs &amp; logs, and the audit trail.
        </div>
      </div>

      {/* tabs + range */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          marginBottom: 16,
          flexWrap: "wrap",
        }}
      >
        <Seg
          options={TABS.map((t) => ({ id: t.id, label: t.label }))}
          value={tab}
          onChange={setTab}
          ariaLabel="Observe tabs"
        />
        {tab === "insights" && (
          <div style={{ marginLeft: "auto" }}>
            <Seg
              options={RANGES.map((r) => ({ id: r.id, label: r.label }))}
              value={range}
              onChange={setRange}
              small
              ariaLabel="Time range"
            />
          </div>
        )}
      </div>

      {error && (
        <div
          style={{
            marginBottom: 16,
            padding: "10px 12px",
            borderRadius: "var(--radius-sm)",
            background: "var(--error-soft)",
            border:
              "1px solid color-mix(in srgb, var(--state-error) 40%, transparent)",
            color: "var(--state-error)",
            fontSize: "var(--text-sm)",
          }}
        >
          {error}
        </div>
      )}

      {tab === "insights" &&
        (runs === null && !error ? (
          <div
            style={{
              border: "1px solid var(--line-mid)",
              background: "var(--panel)",
              borderRadius: 14,
              padding: 28,
              display: "grid",
              placeItems: "center",
            }}
          >
            <span style={{ fontSize: "var(--text-sm)", color: "var(--ink-3)" }}>
              Loading insights…
            </span>
          </div>
        ) : (
          <InsightsTab
            runs={runs ?? []}
            insights={insights}
            spendFrom={spendFrom}
            range={range}
            now={now0}
          />
        ))}
      {tab === "runs" && (
        <RunsTab
          runs={runs}
          now={now0}
          onOpen={(id) => navigate(`/app/runs/${encodeURIComponent(id)}`)}
        />
      )}
      {tab === "audit" && (
        <AuditTab
          events={audit}
          filter={auditFilter}
          onFilter={setAuditFilter}
          now={now0}
        />
      )}
    </div>
  );
}
