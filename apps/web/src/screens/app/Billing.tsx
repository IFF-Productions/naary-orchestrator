import { type CSSProperties, type ReactNode, useEffect, useState } from "react";
import { Card, ProgressBar } from "../../components";
import {
  api,
  UnauthorizedError,
  type BudgetView,
  type UsageReport,
} from "../../lib/api";

/* ------------------------------------------------------------------
 * Billing & usage — wired to the control plane. On mount we resolve the
 * tenant (getMe) then fetch the usage ledger (getUsage) and the budget
 * view (getBudget) concurrently. The ledger stores tokens + cost only
 * (no prompt/completion text) — that's by design, so this screen shows
 * spend, tokens, a spend-by-model breakdown and the budget caps vs the
 * live month-to-date spend.
 *
 * The mock plan/spend-cap/invoices that used to live here had no backing
 * endpoint, so they're gone — every number below is real.
 * ---------------------------------------------------------------- */

const cardStyle: CSSProperties = {
  background: "var(--card)",
  border: "1px solid var(--line)",
  borderRadius: 12,
  boxShadow: "var(--shadow-card)",
};

/** Per-model accent colors, cycled for the spend-by-model bars. */
const MODEL_COLORS = [
  "var(--node-agent)",
  "var(--state-info)",
  "var(--node-trigger)",
  "var(--state-done)",
  "var(--brand)",
];

function usd(n: number): string {
  const small = n > 0 && n < 1;
  return `$${n.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: small ? 4 : 2,
  })}`;
}

function tokens(n: number): string {
  return n.toLocaleString();
}

/** Clamp a percentage to [0, 100] (over-cap bars shouldn't overflow visually). */
function clampPct(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(100, n);
}

type Load =
  | { kind: "loading" }
  | { kind: "unauthorized" }
  | { kind: "error"; message: string }
  | {
      kind: "ready";
      tenantId: string;
      usage: UsageReport;
      budget: BudgetView | null;
    };

export function Billing() {
  const [state, setState] = useState<Load>({ kind: "loading" });

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const me = await api.getMe();
        // Usage is primary; a missing/unset budget (404 → generic Error) must
        // degrade to a "no budget set" card rather than nuke the whole page.
        // A 401 from either call still means "sign in", so re-throw it.
        const [usage, budget] = await Promise.all([
          api.getUsage(me.tenantId),
          api.getBudget(me.tenantId).catch((e: unknown) => {
            if (e instanceof UnauthorizedError) throw e;
            return null;
          }),
        ]);
        if (!live) return;
        setState({ kind: "ready", tenantId: me.tenantId, usage, budget });
      } catch (e) {
        if (!live) return;
        if (e instanceof UnauthorizedError) {
          setState({ kind: "unauthorized" });
        } else {
          setState({
            kind: "error",
            message: e instanceof Error ? e.message : "Failed to load billing",
          });
        }
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  return (
    <div style={{ padding: "22px 28px 40px", maxWidth: 1080 }}>
      {/* heading */}
      <div style={{ marginBottom: 18 }}>
        <div
          style={{
            fontSize: 21,
            fontWeight: 700,
            color: "var(--ink)",
            letterSpacing: "-0.01em",
          }}
        >
          Billing &amp; usage
        </div>
        <div style={{ fontSize: 12.5, color: "var(--ink-2)", marginTop: 2 }}>
          Spend, tokens, budget caps and usage by model — from the usage ledger.
        </div>
      </div>

      {state.kind === "loading" && <Notice>Loading billing…</Notice>}

      {state.kind === "unauthorized" && (
        <Notice>Sign in to view billing</Notice>
      )}

      {state.kind === "error" && (
        <Notice tone="error">
          Couldn&apos;t load billing — {state.message}
        </Notice>
      )}

      {state.kind === "ready" && (
        <Ready usage={state.usage} budget={state.budget} />
      )}
    </div>
  );
}

function Ready({
  usage,
  budget,
}: {
  usage: UsageReport;
  budget: BudgetView | null;
}) {
  const hasUsage = usage.totalCostUsd > 0 || usage.totalTokens > 0;
  const byModel = [...usage.byModel].sort((a, b) => b.costUsd - a.costUsd);

  return (
    <>
      {/* headline stats */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3,1fr)",
          gap: 14,
          marginBottom: 16,
        }}
      >
        <Stat label="Total spend" value={usd(usage.totalCostUsd)} />
        <Stat label="Total tokens" value={tokens(usage.totalTokens)} />
        <Stat
          label="Models used"
          value={usage.byModel.length.toLocaleString()}
        />
      </div>

      {/* budget + spend by model */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1.1fr",
          gap: 16,
          marginBottom: 16,
        }}
      >
        <BudgetCard budget={budget} />
        <SpendByModelCard
          rows={byModel}
          totalCostUsd={usage.totalCostUsd}
          hasUsage={hasUsage}
        />
      </div>
    </>
  );
}

/* ---------------- budget ---------------- */

function BudgetCard({ budget }: { budget: BudgetView | null }) {
  if (!budget) {
    return (
      <Card pad={false} style={{ padding: 20 }}>
        <CardTitle>Budget</CardTitle>
        <CardSub>Caps pause or downgrade runs automatically.</CardSub>
        <div
          style={{
            marginTop: 16,
            fontSize: 12.5,
            color: "var(--ink-2)",
          }}
        >
          No budget configured for this tenant yet.
        </div>
      </Card>
    );
  }

  const pct = clampPct((budget.mtdSpendUsd / budget.monthlyCapUsd) * 100);
  const over = budget.remainingUsd < 0;
  const near = !over && pct >= 80;
  const barColor = over
    ? "var(--state-error)"
    : near
      ? "var(--state-paused)"
      : "linear-gradient(90deg,var(--brand-2),var(--brand))";

  return (
    <Card pad={false} style={{ padding: 20 }}>
      <CardTitle>Budget</CardTitle>
      <CardSub>
        {budget.onBudgetExceeded === "downgrade"
          ? `Over cap, runs downgrade${budget.fallbackModel ? ` to ${budget.fallbackModel}` : ""}.`
          : "Runs are rejected once the monthly cap is hit."}
      </CardSub>

      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          fontSize: 12,
          marginTop: 16,
          marginBottom: 7,
        }}
      >
        <span style={{ color: "var(--ink-2)" }}>Spent this month</span>
        <span className="mono" style={{ color: "var(--ink)" }}>
          {usd(budget.mtdSpendUsd)} / {usd(budget.monthlyCapUsd)}
        </span>
      </div>
      <ProgressBar value={pct} color={barColor} />
      <div
        className="mono"
        style={{
          marginTop: 8,
          fontSize: 10.5,
          color: over ? "var(--state-error)" : "var(--ink-3)",
        }}
      >
        {over
          ? `${usd(-budget.remainingUsd)} over cap · ${pct.toFixed(0)}% used`
          : `${usd(budget.remainingUsd)} remaining · ${pct.toFixed(0)}% used`}
      </div>

      {/* caps + policy */}
      <div
        style={{
          marginTop: 16,
          paddingTop: 15,
          borderTop: "1px solid var(--line)",
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 14,
        }}
      >
        <KeyVal
          label="Per-execution cap"
          value={usd(budget.perExecutionCapUsd)}
        />
        <KeyVal
          label="Max steps / run"
          value={budget.maxStepsPerRun.toLocaleString()}
        />
        <KeyVal label="On exceeded" value={budget.onBudgetExceeded} />
        <KeyVal label="Fallback model" value={budget.fallbackModel ?? "—"} />
      </div>
    </Card>
  );
}

/* ---------------- spend by model ---------------- */

function SpendByModelCard({
  rows,
  totalCostUsd,
  hasUsage,
}: {
  rows: UsageReport["byModel"];
  totalCostUsd: number;
  hasUsage: boolean;
}) {
  return (
    <Card pad={false} style={{ padding: 20 }}>
      <CardTitle>Spend by model</CardTitle>
      <CardSub>{`This tenant · ${usd(totalCostUsd)} total`}</CardSub>

      {!hasUsage || rows.length === 0 ? (
        <div style={{ marginTop: 16, fontSize: 12.5, color: "var(--ink-2)" }}>
          No usage recorded yet.
        </div>
      ) : (
        <div
          style={{
            marginTop: 16,
            display: "flex",
            flexDirection: "column",
            gap: 14,
          }}
        >
          {rows.map((m, i) => {
            const pct =
              totalCostUsd > 0 ? clampPct((m.costUsd / totalCostUsd) * 100) : 0;
            return (
              <div key={m.model}>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    fontSize: 12,
                    marginBottom: 5,
                  }}
                >
                  <span style={{ color: "var(--ink)", fontWeight: 500 }}>
                    {m.model}
                  </span>
                  <span className="mono" style={{ color: "var(--ink-2)" }}>
                    {usd(m.costUsd)}
                  </span>
                </div>
                <ProgressBar
                  value={pct}
                  color={MODEL_COLORS[i % MODEL_COLORS.length]}
                />
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

/* ---------------- presentational helpers ---------------- */

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ ...cardStyle, padding: "15px 16px" }}>
      <div
        style={{
          fontSize: 10,
          fontWeight: 600,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: "var(--ink-3)",
        }}
      >
        {label}
      </div>
      <div
        className="mono"
        style={{
          fontSize: 24,
          fontWeight: 700,
          color: "var(--ink)",
          marginTop: 8,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {value}
      </div>
    </div>
  );
}

function KeyVal({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: "var(--ink-3)" }}>{label}</div>
      <div
        className="mono"
        style={{
          fontSize: 13,
          fontWeight: 600,
          color: "var(--ink)",
          marginTop: 2,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {value}
      </div>
    </div>
  );
}

function CardTitle({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        fontSize: 13,
        fontWeight: 600,
        color: "var(--ink)",
        marginBottom: 4,
      }}
    >
      {children}
    </div>
  );
}

function CardSub({ children }: { children: ReactNode }) {
  return (
    <div style={{ fontSize: 11.5, color: "var(--ink-3)" }}>{children}</div>
  );
}

function Notice({ children, tone }: { children: ReactNode; tone?: "error" }) {
  return (
    <div
      style={{
        ...cardStyle,
        padding: "28px 20px",
        textAlign: "center",
        fontSize: 13,
        color: tone === "error" ? "var(--state-error)" : "var(--ink-2)",
      }}
    >
      {children}
    </div>
  );
}
