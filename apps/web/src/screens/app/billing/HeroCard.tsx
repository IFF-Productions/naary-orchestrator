/**
 * Monthly-spend hero — the big "spent / budget" figure, the gradient meter with
 * the 80% alert notch, a status pill from the real spend %, and the stat strip
 * (projection · LLM calls · avg/call · days left). All figures are real:
 * spend/caps come from BudgetView, calls from the month-window insights rollup;
 * the projection is derived linearly and labeled as such.
 */
import type { BudgetView } from "../../../lib/api";
import { Button, Card, StatusPill } from "../../../components";
import {
  ALERT_PCT,
  type BudgetHealth,
  budgetHealth,
  HEALTH_LABEL,
  type MonthWindow,
  NEAR_PCT,
  projectMonthly,
  spendPct,
  usd,
} from "./billing-model";

const PILL_STATE: Record<BudgetHealth, "done" | "paused" | "error"> = {
  healthy: "done",
  alert: "paused",
  near: "error",
  over: "error",
};

function meterColor(pct: number): string {
  if (pct >= NEAR_PCT) return "var(--state-error)";
  if (pct >= ALERT_PCT) return "var(--state-paused)";
  return "linear-gradient(90deg, var(--brand) 0%, #ffb347 100%)";
}

function StatCell({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color?: string;
}) {
  return (
    <div>
      <div
        className="mono"
        style={{
          fontSize: "var(--text-xs)",
          fontWeight: "var(--weight-semibold)",
          letterSpacing: "var(--tracking-label)",
          textTransform: "uppercase",
          color: "var(--ink-3)",
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: "var(--text-lg)",
          fontWeight: "var(--weight-semibold)",
          color: color ?? "var(--ink)",
          marginTop: 3,
          whiteSpace: "nowrap",
        }}
      >
        {value}
      </div>
    </div>
  );
}

export function HeroCard({
  budget,
  monthSpendUsd,
  monthCalls,
  win,
  onEditBudget,
}: {
  /** null = no budget configured (the hero degrades honestly). */
  budget: BudgetView | null;
  /** Month-to-date spend (from BudgetView when set, else the month insights rollup). */
  monthSpendUsd: number;
  /** LLM calls this billing month (usage-ledger rollup) — null while loading/failed. */
  monthCalls: number | null;
  win: MonthWindow;
  onEditBudget: () => void;
}) {
  const pct = budget ? spendPct(budget) : 0;
  const health = budget ? budgetHealth(pct) : null;
  const projected = projectMonthly(monthSpendUsd, win);
  const projectedOver = budget !== null && projected > budget.monthlyCapUsd;
  const avgPerCall =
    monthCalls !== null && monthCalls > 0 ? monthSpendUsd / monthCalls : null;

  return (
    <Card pad={false} style={{ padding: "22px 24px" }}>
      {/* header: label + big figure + status pill */}
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{ fontSize: "var(--text-sm)", color: "var(--ink-faint)" }}
          >
            Monthly spend
          </div>
          <div
            style={{
              fontSize: 34,
              fontWeight: "var(--weight-bold)",
              letterSpacing: "var(--tracking-tight)",
              color: "var(--ink)",
              marginTop: 4,
            }}
          >
            {usd(monthSpendUsd)}{" "}
            <span
              style={{
                fontSize: "var(--text-lg)",
                color: "var(--ink-faint)",
                fontWeight: "var(--weight-medium)",
              }}
            >
              / {budget ? usd(budget.monthlyCapUsd) : "no cap"}
            </span>
          </div>
        </div>
        {health ? (
          <StatusPill state={PILL_STATE[health]} label={HEALTH_LABEL[health]} />
        ) : (
          <Button size="sm" onClick={onEditBudget}>
            Set a budget
          </Button>
        )}
      </div>

      {/* meter + 80% alert notch (dashboard threshold — enforcement is at 100%) */}
      {budget ? (
        <>
          <div
            role="progressbar"
            aria-valuenow={Math.round(Math.min(100, Math.max(0, pct)))}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="monthly budget used"
            style={{
              marginTop: 18,
              height: 14,
              borderRadius: 8,
              background: "var(--card-2)",
              border: "1px solid var(--line-mid)",
              overflow: "visible",
              position: "relative",
            }}
          >
            <div
              style={{
                height: "100%",
                width: `${Math.min(100, Math.max(0, pct))}%`,
                background: meterColor(pct),
                borderRadius: 8,
                transition: "width .6s ease",
              }}
            />
            <div
              title={`${ALERT_PCT}% — alert threshold (dashboard marker)`}
              style={{
                position: "absolute",
                top: -3,
                bottom: -3,
                left: `${ALERT_PCT}%`,
                width: 2,
                background: "var(--state-paused)",
                opacity: 0.8,
              }}
            />
          </div>
          <div
            className="mono"
            style={{
              display: "flex",
              justifyContent: "space-between",
              marginTop: 9,
              fontSize: "var(--text-xs)",
              color: "var(--ink-3)",
            }}
          >
            <span>{pct.toFixed(0)}% used</span>
            <span style={{ color: "var(--state-paused)" }}>
              alert at {ALERT_PCT}%
            </span>
            <span>{usd(budget.monthlyCapUsd)}</span>
          </div>
          <div
            className="mono"
            style={{
              marginTop: 4,
              fontSize: "var(--text-2xs)",
              color:
                budget.remainingUsd < 0 ? "var(--state-error)" : "var(--ink-3)",
            }}
          >
            {budget.remainingUsd < 0
              ? `${usd(-budget.remainingUsd)} over cap`
              : `${usd(budget.remainingUsd)} remaining`}
          </div>
        </>
      ) : (
        <div
          style={{
            marginTop: 16,
            fontSize: "var(--text-sm)",
            color: "var(--ink-2)",
            lineHeight: 1.5,
          }}
        >
          No budget configured — spend is unmetered. Set a monthly cap to turn
          the enforcement ladder on.
        </div>
      )}

      {/* stat strip — only real derivable values */}
      <div
        style={{
          display: "flex",
          gap: 26,
          flexWrap: "wrap",
          marginTop: 20,
          paddingTop: 18,
          borderTop: "1px solid var(--line)",
        }}
      >
        <StatCell
          label="Projected"
          value={usd(projected)}
          color={projectedOver ? "var(--state-error)" : "var(--ink-soft)"}
        />
        <StatCell
          label="LLM calls"
          value={monthCalls === null ? "—" : monthCalls.toLocaleString()}
        />
        <StatCell
          label="Avg / call"
          value={avgPerCall === null ? "—" : usd(avgPerCall)}
        />
        <StatCell label="Days left" value={String(win.daysLeft)} />
      </div>
      <div
        style={{
          marginTop: 10,
          fontSize: "var(--text-2xs)",
          color: "var(--ink-3)",
        }}
      >
        Projection is linear — month-to-date ÷ elapsed days × days in month, not
        a forecast.
      </div>
    </Card>
  );
}
