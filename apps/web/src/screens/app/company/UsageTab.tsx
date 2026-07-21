import { Card, ProgressBar } from "../../../components";
import type { CompanyBudgetView, CompanyUsage } from "../../../lib/api";
import { workspaceLabel } from "../../../workspace/WorkspaceSwitcher";
import { usd } from "../insights.logic";
import { budgetColor } from "./helpers";

export function UsageTab({
  usage,
  budget,
}: {
  usage: CompanyUsage;
  budget: CompanyBudgetView | null;
}) {
  const max = Math.max(0, ...usage.byWorkspace.map((w) => w.costUsd));
  const rows = [...usage.byWorkspace].sort((a, b) => b.costUsd - a.costUsd);
  const cap = budget?.budget?.monthlyCapUsd ?? null;
  const mtd = budget?.mtdSpendUsd ?? null;
  const hasBudget = cap != null && cap > 0 && mtd != null;
  const remaining = budget?.remainingUsd ?? null;

  return (
    <Card>
      <div
        style={{
          fontWeight: "var(--weight-semibold)",
          marginBottom: 12,
        }}
      >
        Spend by workspace (30d)
      </div>
      {rows.length === 0 ? (
        <div style={{ fontSize: "var(--text-sm)", color: "var(--ink-3)" }}>
          No usage yet.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {rows.map((w) => (
            <div key={w.tenantId}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 12,
                  fontSize: "var(--text-sm)",
                  marginBottom: 4,
                }}
              >
                <span
                  style={{
                    color: "var(--ink)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {workspaceLabel(w.tenantId, w.displayName ?? undefined)}
                </span>
                <span style={{ color: "var(--ink-2)", flexShrink: 0 }}>
                  {usd(w.costUsd)}
                </span>
              </div>
              <ProgressBar
                value={max > 0 ? (w.costUsd / max) * 100 : 0}
                color="var(--brand)"
              />
            </div>
          ))}
        </div>
      )}

      {/* Company total + pooled-budget line (§8) — the of-budget framing the differentiator asks
          for, at the level the API actually provides a budget (company-wide, not per-workspace). */}
      <div
        style={{
          borderTop: "1px solid var(--line)",
          marginTop: 14,
          paddingTop: 12,
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            gap: 12,
            fontSize: "var(--text-body)",
          }}
        >
          <span style={{ color: "var(--ink-2)" }}>Company total (30d)</span>
          <span
            style={{
              color: "var(--ink)",
              fontWeight: "var(--weight-semibold)",
            }}
          >
            {usd(usage.totals.costUsd)}
          </span>
        </div>
        {hasBudget ? (
          <div style={{ marginTop: 10 }}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                gap: 12,
                fontSize: "var(--text-sm)",
                marginBottom: 4,
              }}
            >
              <span style={{ color: "var(--ink-2)" }}>
                Pooled budget · month to date
              </span>
              <span style={{ color: "var(--ink-2)" }}>
                {usd(mtd)} of {usd(cap)}
                {remaining != null && ` · ${usd(Math.max(0, remaining))} left`}
              </span>
            </div>
            <ProgressBar
              value={(mtd / cap) * 100}
              color={budgetColor((mtd / cap) * 100)}
            />
          </div>
        ) : (
          <div
            style={{
              marginTop: 8,
              fontSize: "var(--text-sm)",
              color: "var(--ink-3)",
            }}
          >
            No company budget cap configured.
          </div>
        )}
      </div>
    </Card>
  );
}
