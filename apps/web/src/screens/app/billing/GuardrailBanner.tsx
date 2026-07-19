/**
 * "Runs stopped by the budget guardrail" banner — shown ONLY when recent runs
 * actually carry status budget_exceeded this billing month (the real signal;
 * there is no separate paused-on-budget state — capped runs STOP, they don't
 * auto-resume, so the copy says rerun, not resume).
 */
import { Link } from "react-router-dom";
import { Button } from "../../../components";
import type { BudgetView } from "../../../lib/api";

export function GuardrailBanner({
  count,
  budget,
  onRaiseBudget,
}: {
  count: number;
  budget: BudgetView | null;
  onRaiseBudget: () => void;
}) {
  if (count === 0) return null;
  const policyChip =
    budget?.onBudgetExceeded === "downgrade"
      ? "policy: downgrade"
      : "policy: reject over cap";
  return (
    <div
      style={{
        border:
          "1px solid color-mix(in srgb, var(--state-paused) 45%, transparent)",
        background: "linear-gradient(120deg, var(--paused-soft), var(--panel))",
        borderRadius: 14,
        padding: "16px 20px",
        display: "flex",
        alignItems: "center",
        gap: 15,
        flexWrap: "wrap",
      }}
    >
      <div
        aria-hidden
        style={{
          width: 42,
          height: 42,
          flex: "none",
          borderRadius: 11,
          border:
            "1px solid color-mix(in srgb, var(--state-paused) 45%, transparent)",
          color: "var(--state-paused)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <svg width="21" height="21" viewBox="0 0 24 24" fill="none">
          <path
            d="M12 3l9 16H3z M12 10v4 M12 17.2v.2"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>
      <div style={{ flex: 1, minWidth: 220 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 9,
            flexWrap: "wrap",
          }}
        >
          <span
            style={{
              fontSize: "var(--text-md)",
              fontWeight: "var(--weight-bold)",
              color: "var(--ink)",
            }}
          >
            {count} recent run{count === 1 ? "" : "s"} stopped — budget
            guardrail hit
          </span>
          {budget && (
            <span
              className="mono"
              style={{
                fontSize: "var(--text-2xs)",
                color: "var(--state-paused)",
                border:
                  "1px solid color-mix(in srgb, var(--state-paused) 45%, transparent)",
                borderRadius: 20,
                padding: "2px 8px",
              }}
            >
              {policyChip}
            </span>
          )}
        </div>
        <div
          style={{
            fontSize: "var(--text-sm)",
            color: "var(--ink-2)",
            marginTop: 3,
            lineHeight: 1.5,
          }}
        >
          A cap (monthly or per-run) ended these runs as budget_exceeded this
          month. They don&apos;t resume on their own — raise the cap, then rerun
          them from the Runs screen.
        </div>
      </div>
      <Link to="/app/runs" style={{ flex: "none", textDecoration: "none" }}>
        <Button>Review runs</Button>
      </Link>
      <Button variant="primary" onClick={onRaiseBudget}>
        Raise budget
      </Button>
    </div>
  );
}
