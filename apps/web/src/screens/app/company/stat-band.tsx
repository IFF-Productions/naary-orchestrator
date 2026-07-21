import { type ReactNode } from "react";
import { ProgressBar } from "../../../components";
import type { CompanyBudgetView, CompanyUsage } from "../../../lib/api";
import { usd } from "../insights.logic";
import { budgetColor } from "./helpers";
import type { WorkspaceRow } from "./types";

/** One KPI tile — built inline (StatCard has no of-budget subtext / threshold bar). */
export function KpiTile({
  label,
  value,
  accent,
  sub,
  bar,
}: {
  label: string;
  value: ReactNode;
  accent?: string;
  sub?: ReactNode;
  bar?: { pct: number; color: string };
}) {
  return (
    <div
      style={{
        background: "var(--card)",
        border: "1px solid var(--line)",
        borderRadius: "var(--radius-lg, 12px)",
        padding: "13px 15px",
        display: "flex",
        flexDirection: "column",
        gap: 4,
        minWidth: 0,
      }}
    >
      <div
        style={{
          fontSize: 11.5,
          color: "var(--ink-2)",
          textTransform: "uppercase",
          letterSpacing: ".04em",
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 22,
          fontWeight: "var(--weight-semibold)",
          color: accent ?? "var(--ink)",
          lineHeight: 1.15,
        }}
      >
        {value}
      </div>
      {sub && (
        <div style={{ fontSize: "var(--text-sm)", color: "var(--ink-3)" }}>
          {sub}
        </div>
      )}
      {bar && (
        <div style={{ marginTop: 2 }}>
          <ProgressBar value={bar.pct} color={bar.color} />
        </div>
      )}
    </div>
  );
}

export function StatBand({
  usage,
  budget,
  seats,
}: {
  usage: CompanyUsage;
  budget: CompanyBudgetView | null;
  seats: number | null;
}) {
  // Spend-of-budget uses MTD spend / monthly cap (BOTH month-to-date). Never divide the
  // range/30d rollup by the monthly cap — different windows. Falls back to the 30d rollup
  // spend (no budget framing) when no company budget is configured.
  const cap = budget?.budget?.monthlyCapUsd ?? null;
  const mtd = budget?.mtdSpendUsd ?? null;
  const hasBudget = cap != null && cap > 0 && mtd != null;
  const pct = hasBudget ? (mtd / cap) * 100 : 0;

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
        gap: 12,
        marginBottom: 8,
      }}
    >
      {hasBudget ? (
        <KpiTile
          label="Spend · month to date"
          value={usd(mtd)}
          accent={budgetColor(pct)}
          sub={`of ${usd(cap)} · ${Math.round(pct)}%`}
          bar={{ pct, color: budgetColor(pct) }}
        />
      ) : (
        <KpiTile
          label="Company spend (30d)"
          value={usd(usage.totals.costUsd)}
        />
      )}
      <KpiTile
        label="Tokens (30d)"
        value={usage.totals.totalTokens.toLocaleString()}
      />
      <KpiTile label="Metered calls (30d)" value={String(usage.totals.calls)} />
      <KpiTile label="Seats" value={seats == null ? "—" : String(seats)} />
    </div>
  );
}

/** Neutral environment dots — `byEnvironment` gives only opaque environmentIds, not a
 *  prod/uat/sandbox KIND, so we can't legitimately use the --env-* accents. Show one
 *  neutral dot per environment with activity (dim placeholder when none). */
export function EnvDots({ envs }: { envs: WorkspaceRow["byEnvironment"] }) {
  if (envs.length === 0) {
    return (
      <span
        style={{
          display: "inline-block",
          width: 8,
          height: 8,
          borderRadius: 99,
          background: "var(--line-2)",
        }}
        title="No environment activity"
      />
    );
  }
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
      {envs.slice(0, 4).map((e, i) => (
        <span
          key={e.environmentId ?? `default-${i}`}
          title={e.environmentId ?? "default"}
          style={{
            width: 8,
            height: 8,
            borderRadius: 99,
            background: "var(--ink-2)",
          }}
        />
      ))}
      {envs.length > 4 && (
        <span style={{ fontSize: 11, color: "var(--ink-3)" }}>
          +{envs.length - 4}
        </span>
      )}
    </span>
  );
}
