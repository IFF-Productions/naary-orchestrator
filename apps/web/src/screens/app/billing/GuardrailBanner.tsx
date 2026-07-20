/**
 * Budget guardrail banners, driven by REAL run state this billing month:
 *  - PAUSED (Slice 3, policy "pause"): runs currently carry status awaiting_budget.
 *    They resume automatically — the PUT behind "Raise budget & resume" signals
 *    them — so the copy says resume, never rerun.
 *  - STOPPED (reject / per-run cap): runs carry the terminal budget_exceeded.
 *    Capped runs STOP and don't auto-resume, so the copy says rerun, not resume.
 * Either banner renders only when its count is non-zero.
 */
import { Link } from "react-router-dom";
import { Button } from "../../../components";
import type { BudgetView } from "../../../lib/api";

function BannerShell({
  icon,
  children,
  actions,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
  actions: React.ReactNode;
}) {
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
        {icon}
      </div>
      <div style={{ flex: 1, minWidth: 220 }}>{children}</div>
      {actions}
    </div>
  );
}

function PolicyChip({ text }: { text: string }) {
  return (
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
      {text}
    </span>
  );
}

function Headline({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        fontSize: "var(--text-md)",
        fontWeight: "var(--weight-bold)",
        color: "var(--ink)",
      }}
    >
      {children}
    </span>
  );
}

function SubLine({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: "var(--text-sm)",
        color: "var(--ink-2)",
        marginTop: 3,
        lineHeight: 1.5,
      }}
    >
      {children}
    </div>
  );
}

const WarnIcon = (
  <svg width="21" height="21" viewBox="0 0 24 24" fill="none">
    <path
      d="M12 3l9 16H3z M12 10v4 M12 17.2v.2"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const PauseIcon = (
  <svg width="21" height="21" viewBox="0 0 24 24" fill="none">
    <path
      d="M9 5v14 M15 5v14"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
    />
  </svg>
);

export function GuardrailBanner({
  count,
  pausedCount = 0,
  budget,
  onRaiseBudget,
}: {
  /** Runs terminally stopped as budget_exceeded this billing month. */
  count: number;
  /** Runs currently parked as awaiting_budget (policy "pause", Slice 3). */
  pausedCount?: number;
  budget: BudgetView | null;
  onRaiseBudget: () => void;
}) {
  if (count === 0 && pausedCount === 0) return null;
  const policyChip =
    budget?.onBudgetExceeded === "downgrade"
      ? "policy: downgrade"
      : budget?.onBudgetExceeded === "pause"
        ? "policy: pause & resume"
        : "policy: reject over cap";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {pausedCount > 0 && (
        <BannerShell
          icon={PauseIcon}
          actions={
            <>
              <Link
                to="/app/runs"
                style={{ flex: "none", textDecoration: "none" }}
              >
                <Button>Review runs</Button>
              </Link>
              {/* The PUT behind the editor's save signals budgetResume to every
                  paused run — raising the cap IS the resume action. */}
              <Button variant="primary" onClick={onRaiseBudget}>
                Raise budget &amp; resume
              </Button>
            </>
          }
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 9,
              flexWrap: "wrap",
            }}
          >
            <Headline>
              {pausedCount} run{pausedCount === 1 ? "" : "s"} paused on budget
            </Headline>
            {budget && <PolicyChip text={policyChip} />}
          </div>
          <SubLine>
            The monthly cap was reached, so these runs are parked — not failed.
            They resume automatically when you raise the cap, and at the next
            month&apos;s rollover.
          </SubLine>
        </BannerShell>
      )}
      {count > 0 && (
        <BannerShell
          icon={WarnIcon}
          actions={
            <>
              <Link
                to="/app/runs"
                style={{ flex: "none", textDecoration: "none" }}
              >
                <Button>Review runs</Button>
              </Link>
              <Button variant="primary" onClick={onRaiseBudget}>
                Raise budget
              </Button>
            </>
          }
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 9,
              flexWrap: "wrap",
            }}
          >
            <Headline>
              {count} recent run{count === 1 ? "" : "s"} stopped — budget
              guardrail hit
            </Headline>
            {budget && <PolicyChip text={policyChip} />}
          </div>
          <SubLine>
            A cap (monthly or per-run) ended these runs as budget_exceeded this
            month. They don&apos;t resume on their own — raise the cap, then
            rerun them from the Runs screen.
          </SubLine>
        </BannerShell>
      )}
    </div>
  );
}
