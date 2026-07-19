/**
 * Company outer-cap strip — shown ONLY when the signed-in user belongs to a
 * company that has a company-wide budget configured (GET /me/companies +
 * GET /companies/:id/budget). The figures are company-wide (all member
 * workspaces), so the copy says exactly that.
 */
import { Link } from "react-router-dom";
import { usd } from "./billing-model";

export function CompanyCapStrip({
  name,
  mtdSpendUsd,
  monthlyCapUsd,
}: {
  name: string;
  mtdSpendUsd: number;
  monthlyCapUsd: number;
}) {
  const pct =
    monthlyCapUsd > 0 ? Math.min(100, (mtdSpendUsd / monthlyCapUsd) * 100) : 0;
  return (
    <div
      style={{
        border: "1px solid var(--line-mid)",
        background: "var(--panel)",
        borderRadius: 12,
        padding: "12px 18px",
        display: "flex",
        alignItems: "center",
        gap: 14,
        flexWrap: "wrap",
      }}
    >
      <span
        className="mono"
        style={{
          fontSize: "var(--text-2xs)",
          fontWeight: "var(--weight-semibold)",
          letterSpacing: "var(--tracking-label)",
          textTransform: "uppercase",
          color: "var(--ink-3)",
          flex: "none",
        }}
      >
        Company outer cap
      </span>
      <span style={{ fontSize: "var(--text-sm)", color: "var(--ink-2)" }}>
        {name} — company-wide, across all member workspaces
      </span>
      <div
        style={{
          flex: 1,
          minWidth: 120,
          height: 6,
          borderRadius: 4,
          background: "var(--card-2)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            height: "100%",
            width: `${pct}%`,
            borderRadius: 4,
            background:
              pct >= 90
                ? "var(--state-error)"
                : pct >= 80
                  ? "var(--state-paused)"
                  : "var(--state-info)",
          }}
        />
      </div>
      <span
        className="mono"
        style={{
          fontSize: "var(--text-sm)",
          fontWeight: "var(--weight-semibold)",
          color: "var(--ink)",
          flex: "none",
        }}
      >
        {usd(mtdSpendUsd)} / {usd(monthlyCapUsd)}
      </span>
      <Link
        to="/app/company"
        style={{ fontSize: "var(--text-xs)", flex: "none" }}
      >
        Company view →
      </Link>
    </div>
  );
}
