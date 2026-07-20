import { useCallback, useEffect, useState } from "react";
import { useMediaQuery } from "../../lib/useMediaQuery";
import {
  api,
  type BudgetView,
  type Company,
  type CompanyBudgetView,
  type RunSummary,
  UnauthorizedError,
} from "../../lib/api";
import { AnalyticsSection } from "./billing/AnalyticsSection";
import {
  budgetPausedRuns,
  budgetStoppedThisMonth,
  monthWindow,
  spendPct,
} from "./billing/billing-model";
import { BudgetEditor } from "./billing/BudgetEditor";
import { CompanyCapStrip } from "./billing/CompanyCapStrip";
import { EnforcementCard } from "./billing/EnforcementCard";
import { GuardrailBanner } from "./billing/GuardrailBanner";
import { HeroCard } from "./billing/HeroCard";

/* ------------------------------------------------------------------
 * Usage & budgets — money in ONE home (redesign: Naary Usage & Budgets
 * .dc.html). Composition:
 *   1. Monthly-spend hero (BudgetView: live MTD spend vs cap) beside the
 *      ENFORCEMENT LADDER (the real policy: one 100% rung — reject or
 *      downgrade — plus the per-run cap and step limit).
 *   2. Guardrail banner — only when recent runs really carry
 *      status budget_exceeded this month.
 *   3. Company outer cap — only when a company-wide budget exists.
 *   4. Usage analytics (windowed insights rollups + the ledger's line
 *      items): spend/day stacked by model, top workflows, cost by model,
 *      by environment.
 * Budget editing (PUT /tenants/:id/budget) lives behind "Raise budget" /
 * "Edit policy". Every figure is real; projections are labeled as such.
 * ---------------------------------------------------------------- */

interface CompanyCap {
  name: string;
  mtdSpendUsd: number;
  monthlyCapUsd: number;
}

type Load =
  | { kind: "loading" }
  | { kind: "unauthorized" }
  | { kind: "error"; message: string }
  | { kind: "ready"; tenantId: string };

export function Billing() {
  const stacked = useMediaQuery("(max-width: 980px)");
  const [state, setState] = useState<Load>({ kind: "loading" });
  const [budget, setBudget] = useState<BudgetView | null>(null);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  // Month-window rollup for the hero (spend fallback + LLM-call count).
  const [monthTotals, setMonthTotals] = useState<{
    costUsd: number;
    calls: number;
  } | null>(null);
  const [companyCap, setCompanyCap] = useState<CompanyCap | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  // Frozen per mount — keeps the billing-month window stable across renders.
  const [now] = useState(() => Date.now());
  const win = monthWindow(now);

  const loadBudget = useCallback(async (tenantId: string) => {
    // A missing budget (404 → generic Error) degrades to the "no budget"
    // hero rather than nuking the page; a 401 still means "sign in".
    try {
      setBudget(await api.getBudget(tenantId));
    } catch (e) {
      if (e instanceof UnauthorizedError) throw e;
      setBudget(null);
    }
  }, []);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const me = await api.getMe();
        const [, insights, runsRes] = await Promise.all([
          loadBudget(me.tenantId),
          // Month-scoped rollup — same ledger the budget's MTD figure reads.
          api
            .getInsights(me.tenantId, { from: win.fromISO })
            .then((r) => r.totals)
            .catch((e: unknown) => {
              if (e instanceof UnauthorizedError) throw e;
              return null;
            }),
          api.listRuns().catch((e: unknown) => {
            if (e instanceof UnauthorizedError) throw e;
            return [] as RunSummary[];
          }),
        ]);
        if (!live) return;
        setMonthTotals(
          insights
            ? { costUsd: insights.costUsd, calls: insights.calls }
            : null,
        );
        setRuns(runsRes);
        setState({ kind: "ready", tenantId: me.tenantId });
      } catch (e) {
        if (!live) return;
        setState(
          e instanceof UnauthorizedError
            ? { kind: "unauthorized" }
            : {
                kind: "error",
                message:
                  e instanceof Error ? e.message : "Failed to load usage",
              },
        );
      }
    })();
    // Company outer cap is a nice-to-have — degrade silently.
    (async () => {
      try {
        const companies: Company[] = await api.getMyCompanies();
        if (companies.length === 0) return;
        const c = companies[0];
        const view: CompanyBudgetView = await api.getCompanyBudget(c.id);
        if (live && view.budget) {
          setCompanyCap({
            name: c.name,
            mtdSpendUsd: view.mtdSpendUsd,
            monthlyCapUsd: view.budget.monthlyCapUsd,
          });
        }
      } catch {
        /* no company / no access — omit the strip */
      }
    })();
    return () => {
      live = false;
    };
  }, [loadBudget, win.fromISO]);

  const ready = state.kind === "ready";
  const pct = budget ? spendPct(budget) : 0;
  const stoppedCount = budgetStoppedThisMonth(runs, win).length;
  // Slice 3 (policy "pause"): runs currently parked as awaiting_budget.
  const pausedCount = budgetPausedRuns(runs).length;
  const monthSpend = budget?.mtdSpendUsd ?? monthTotals?.costUsd ?? 0;

  return (
    <div style={{ padding: "24px 28px 40px", maxWidth: 1300 }}>
      {/* ---- header ---- */}
      <div style={{ marginBottom: 18 }}>
        <div
          style={{
            fontSize: "var(--text-title)",
            fontWeight: "var(--weight-bold)",
            color: "var(--ink)",
            letterSpacing: "var(--tracking-tight)",
          }}
        >
          Usage &amp; budgets
        </div>
        <div
          style={{
            fontSize: "var(--text-body)",
            color: "var(--ink-2)",
            marginTop: 4,
          }}
        >
          Spend, caps, and what Naary does when you hit them · billing period{" "}
          {win.label}
        </div>
      </div>

      {state.kind === "loading" && <Notice>Loading usage…</Notice>}
      {state.kind === "unauthorized" && (
        <Notice>Sign in to view usage &amp; budgets</Notice>
      )}
      {state.kind === "error" && (
        <Notice tone="error">
          Couldn&apos;t load usage &amp; budgets — {state.message}
        </Notice>
      )}

      {ready && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 16,
            // Loading notice → real content swap fades in rather than popping.
            animation: "naaryFadeUp .25s ease",
          }}
        >
          {/* row 1: hero + enforcement ladder */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: stacked ? "1fr" : "1.35fr 1fr",
              gap: 16,
            }}
          >
            <HeroCard
              budget={budget}
              monthSpendUsd={monthSpend}
              monthCalls={monthTotals?.calls ?? null}
              win={win}
              onEditBudget={() => setEditorOpen(true)}
            />
            <EnforcementCard
              budget={budget}
              pct={pct}
              onEdit={() => setEditorOpen(true)}
            />
          </div>

          {/* row 2: only when runs really hit the guardrail this month (stopped)
              or are parked on it right now (paused, Slice 3) */}
          <GuardrailBanner
            count={stoppedCount}
            pausedCount={pausedCount}
            budget={budget}
            onRaiseBudget={() => setEditorOpen(true)}
          />

          {/* row 3: company outer cap, only when one exists */}
          {companyCap && (
            <CompanyCapStrip
              name={companyCap.name}
              mtdSpendUsd={companyCap.mtdSpendUsd}
              monthlyCapUsd={companyCap.monthlyCapUsd}
            />
          )}

          {/* row 4+: windowed usage analytics */}
          <AnalyticsSection
            tenantId={state.tenantId}
            downgradeTip={budget?.onBudgetExceeded === "downgrade"}
          />

          <BudgetEditor
            open={editorOpen}
            onClose={() => setEditorOpen(false)}
            tenantId={state.tenantId}
            budget={budget}
            onSaved={async () => {
              await loadBudget(state.tenantId);
              // A budget save also RESUMES paused runs (Slice 3) — refresh the
              // runs list so the paused banner reflects the woken runs.
              try {
                setRuns(await api.listRuns());
              } catch {
                /* banner refresh is best-effort */
              }
            }}
          />
        </div>
      )}
    </div>
  );
}

function Notice({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone?: "error";
}) {
  return (
    <div
      style={{
        background: "var(--card)",
        border: "1px solid var(--line)",
        borderRadius: "var(--radius-lg)",
        boxShadow: "var(--shadow-card)",
        padding: "28px 20px",
        textAlign: "center",
        fontSize: "var(--text-body)",
        color: tone === "error" ? "var(--state-error)" : "var(--ink-2)",
      }}
    >
      {children}
    </div>
  );
}
