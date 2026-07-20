/**
 * "Needs your attention" — the hero row. Three cards, each backed by a real
 * signal from the runs/approvals lists:
 *   1. Approvals waiting  (amber-tinted, ping-pulse icon) → /app/approvals
 *   2. Stopped on budget  (runs with status budget_exceeded · 24h) → /app/billing
 *   3. Failures · 24h     (failed / timed_out · 24h) → /app/runs
 */
import type { CSSProperties, ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { Icon, type IconName } from "../../../components";
import { formatAge } from "./overview-model";

const cardBase: CSSProperties = {
  border: "1px solid var(--line-mid)",
  background: "var(--card)",
  borderRadius: 14,
  padding: 18,
  cursor: "pointer",
  textAlign: "left",
  font: "inherit",
  color: "var(--ink)",
  transition: "background .12s, border-color .12s, box-shadow .12s",
  boxShadow: "var(--shadow-card)",
};

function AttentionCard({
  title,
  tile,
  value,
  sub,
  cta,
  ctaColor,
  onClick,
  style,
}: {
  title: string;
  tile: ReactNode;
  value: ReactNode;
  sub: string;
  cta: string;
  ctaColor: string;
  onClick: () => void;
  style?: CSSProperties;
}) {
  return (
    <button
      type="button"
      className="ov-att"
      onClick={onClick}
      style={{ ...cardBase, ...style }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 9,
          marginBottom: 12,
        }}
      >
        {tile}
        <div
          style={{
            fontSize: "var(--text-body)",
            fontWeight: "var(--weight-semibold)",
            color: "var(--ink-soft)",
          }}
        >
          {title}
        </div>
      </div>
      <div
        style={{
          fontSize: 30,
          fontWeight: "var(--weight-bold)",
          letterSpacing: "var(--tracking-tight)",
          lineHeight: 1.1,
        }}
      >
        {value}
      </div>
      <div
        style={{
          fontSize: "var(--text-xs)",
          color: "var(--ink-faint)",
          marginTop: 3,
        }}
      >
        {sub}
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          marginTop: 12,
          fontSize: "var(--text-sm)",
          color: ctaColor,
          fontWeight: "var(--weight-semibold)",
        }}
      >
        {cta}
        <Icon name="arrow-right" size={13} strokeWidth={1.9} />
      </div>
    </button>
  );
}

function Tile({
  color,
  border,
  icon,
  pulse,
}: {
  color: string;
  border: string;
  icon: IconName;
  pulse?: boolean;
}) {
  return (
    <span
      style={{
        position: "relative",
        width: 32,
        height: 32,
        flex: "none",
        borderRadius: 9,
        border: `1px solid ${border}`,
        color,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        animation: pulse ? "naaryPulseRing 1.8s ease-out infinite" : undefined,
      }}
    >
      <Icon name={icon} size={16} strokeWidth={1.8} />
    </span>
  );
}

export function AttentionRow({
  loading,
  errored,
  approvalsCount,
  oldestApprovalMs,
  breachedCount,
  budgetStoppedCount,
  failureCount,
  failureHint,
}: {
  loading: boolean;
  errored: boolean;
  /** Runs paused for a human right now. */
  approvalsCount: number;
  /** Age (ms) of the oldest waiting approval; null when the queue is empty. */
  oldestApprovalMs: number | null;
  /** Approvals waiting longer than 24h. */
  breachedCount: number;
  /** Runs the budget guardrail stopped in the last 24h. */
  budgetStoppedCount: number;
  /** failed / timed_out runs in the last 24h. */
  failureCount: number;
  /** Honest sub-line for the failures card (e.g. "3 timed out · 1 failed"). */
  failureHint: string;
}) {
  const navigate = useNavigate();
  const v = (n: number): ReactNode => (loading ? "…" : errored ? "—" : n);
  const attention = approvalsCount + budgetStoppedCount + failureCount;

  return (
    <>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 9,
          marginBottom: 14,
        }}
      >
        <div
          style={{
            fontSize: "var(--text-lg)",
            fontWeight: "var(--weight-bold)",
            color: "var(--ink)",
          }}
        >
          Needs your attention
        </div>
        {!loading && !errored && (
          <span
            style={{
              fontSize: "var(--text-xs)",
              fontWeight: "var(--weight-semibold)",
              color: attention > 0 ? "var(--brand-2)" : "var(--ink-2)",
              background:
                attention > 0 ? "var(--paused-soft)" : "var(--card-2)",
              border: `1px solid ${
                attention > 0
                  ? "color-mix(in srgb, var(--state-paused) 45%, var(--line))"
                  : "var(--line-mid)"
              }`,
              borderRadius: "var(--radius-pill)",
              padding: "3px 10px",
            }}
          >
            {attention} item{attention === 1 ? "" : "s"}
          </span>
        )}
      </div>

      <div
        style={{
          // Card grid: flows 3 → 2 → 1 with no hard breakpoint (auto-fit).
          // minmax keeps each KPI legible; the budget-stopped cap must stay readable.
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
          gap: 14,
          marginBottom: 28,
        }}
      >
        <AttentionCard
          title="Approvals waiting"
          tile={
            <Tile
              color="var(--state-paused)"
              border="color-mix(in srgb, var(--state-paused) 55%, var(--line))"
              icon="check"
              pulse={approvalsCount > 0}
            />
          }
          value={v(approvalsCount)}
          sub={
            loading || errored
              ? " "
              : approvalsCount === 0
                ? "All clear"
                : `${
                    breachedCount > 0 ? `${breachedCount} waiting >24h · ` : ""
                  }oldest ${formatAge(oldestApprovalMs ?? 0)}`
          }
          cta="Review inbox"
          ctaColor="var(--state-paused)"
          onClick={() => navigate("/app/approvals")}
          style={{
            border:
              "1px solid color-mix(in srgb, var(--state-paused) 45%, var(--line))",
            background:
              "linear-gradient(150deg, var(--paused-soft), var(--card) 70%)",
          }}
        />

        <AttentionCard
          title="Stopped on budget · 24h"
          tile={
            <Tile color="var(--brand)" border="var(--brand)" icon="pause" />
          }
          value={v(budgetStoppedCount)}
          sub={
            loading || errored
              ? " "
              : budgetStoppedCount === 0
                ? "Within budget"
                : "hit the budget guardrail — raise the cap to re-run"
          }
          cta="Manage budget"
          ctaColor="var(--brand)"
          onClick={() => navigate("/app/billing")}
        />

        <AttentionCard
          title="Failures · 24h"
          tile={
            <Tile
              color="var(--state-error)"
              border="color-mix(in srgb, var(--state-error) 55%, var(--line))"
              icon="alert"
            />
          }
          value={v(failureCount)}
          sub={loading || errored ? " " : failureHint}
          cta="View failed runs"
          ctaColor="var(--state-error)"
          onClick={() => navigate("/app/runs")}
        />
      </div>
    </>
  );
}
