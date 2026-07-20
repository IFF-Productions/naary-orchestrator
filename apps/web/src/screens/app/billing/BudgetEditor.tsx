/**
 * Budget editor dialog — the "Raise budget" / "Edit policy" affordance. Writes
 * the REAL policy via PUT /tenants/:id/budget (SetBudgetDto): monthly cap,
 * per-run cap, step limit, on-exceeded action (+ fallback model for downgrade).
 * The caller refetches the budget view on save.
 */
import { useEffect, useState } from "react";
import { Button, Dialog } from "../../../components";
import { api, type BudgetView } from "../../../lib/api";

/** Parse a positive dollar/step figure; null = invalid. */
function positive(v: string): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function BudgetEditor({
  open,
  onClose,
  tenantId,
  budget,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  tenantId: string;
  /** Current config (null = creating the first budget). */
  budget: BudgetView | null;
  onSaved: () => void | Promise<void>;
}) {
  const [monthly, setMonthly] = useState("");
  const [perRun, setPerRun] = useState("");
  const [maxSteps, setMaxSteps] = useState("");
  const [action, setAction] = useState<"reject" | "downgrade" | "pause">(
    "reject",
  );
  const [fallback, setFallback] = useState("");
  const [alertPct, setAlertPct] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-seed the form each time the dialog opens (budget may have refreshed).
  useEffect(() => {
    if (!open) return;
    setMonthly(budget ? String(budget.monthlyCapUsd) : "");
    setPerRun(budget ? String(budget.perExecutionCapUsd) : "");
    setMaxSteps(budget ? String(budget.maxStepsPerRun) : "");
    setAction(budget?.onBudgetExceeded ?? "reject");
    setFallback(budget?.fallbackModel ?? "");
    setAlertPct(
      budget?.alertThresholdPct != null ? String(budget.alertThresholdPct) : "",
    );
    setError(null);
  }, [open, budget]);

  const monthlyN = positive(monthly);
  const perRunN = positive(perRun);
  const maxStepsN = maxSteps.trim() === "" ? undefined : positive(maxSteps);
  // Alert threshold: blank = no alert; otherwise a whole percent 1-100.
  const alertRaw = alertPct.trim() === "" ? undefined : positive(alertPct);
  const alertN =
    alertRaw === undefined
      ? undefined
      : alertRaw !== null && alertRaw <= 100
        ? Math.round(alertRaw)
        : null;
  const valid =
    monthlyN !== null &&
    perRunN !== null &&
    maxStepsN !== null &&
    alertN !== null; // null only when non-empty AND invalid

  async function save(): Promise<void> {
    if (!valid || monthlyN === null || perRunN === null) return;
    setBusy(true);
    setError(null);
    try {
      await api.setBudget(tenantId, {
        monthlyCapUsd: monthlyN,
        perExecutionCapUsd: perRunN,
        ...(maxStepsN !== undefined && maxStepsN !== null
          ? { maxStepsPerRun: Math.round(maxStepsN) }
          : {}),
        onBudgetExceeded: action,
        fallbackModel:
          action === "downgrade" && fallback.trim() !== ""
            ? fallback.trim()
            : null,
        alertThresholdPct: alertN ?? null,
      });
      await onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the budget.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={budget ? "Edit budget & policy" : "Set a budget"}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => void save()}
            disabled={busy || !valid}
            loading={busy}
          >
            {busy ? "Saving…" : "Save budget"}
          </Button>
        </>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {error && (
          <div
            style={{
              padding: "8px 11px",
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

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 12,
          }}
        >
          <div>
            <label className="field-label" htmlFor="budget-monthly">
              Monthly cap (USD)
            </label>
            <input
              id="budget-monthly"
              className="input mono"
              inputMode="decimal"
              value={monthly}
              onChange={(e) => setMonthly(e.target.value)}
              placeholder="100"
              style={{ width: "100%", marginTop: 6 }}
            />
          </div>
          <div>
            <label className="field-label" htmlFor="budget-perrun">
              Per-run cap (USD)
            </label>
            <input
              id="budget-perrun"
              className="input mono"
              inputMode="decimal"
              value={perRun}
              onChange={(e) => setPerRun(e.target.value)}
              placeholder="0.50"
              style={{ width: "100%", marginTop: 6 }}
            />
          </div>
        </div>

        <div>
          <label className="field-label" htmlFor="budget-steps">
            Max agent steps per run
          </label>
          <input
            id="budget-steps"
            className="input mono"
            inputMode="numeric"
            value={maxSteps}
            onChange={(e) => setMaxSteps(e.target.value)}
            placeholder="50 (server default when blank)"
            style={{ width: "100%", marginTop: 6 }}
          />
        </div>

        <div>
          <label className="field-label" htmlFor="budget-action">
            When the monthly cap is hit
          </label>
          <select
            id="budget-action"
            className="input"
            value={action}
            onChange={(e) =>
              setAction(
                e.target.value === "downgrade"
                  ? "downgrade"
                  : e.target.value === "pause"
                    ? "pause"
                    : "reject",
              )
            }
            style={{ width: "100%", marginTop: 6 }}
          >
            <option value="reject">
              Reject — stop new runs, halt agent calls
            </option>
            <option value="downgrade">
              Downgrade — swap to a cheaper fallback model
            </option>
            <option value="pause">
              Pause — park runs until the cap is raised or the month resets
            </option>
          </select>
        </div>

        {action === "downgrade" && (
          <div>
            <label className="field-label" htmlFor="budget-fallback">
              Fallback model
            </label>
            <input
              id="budget-fallback"
              className="input mono"
              value={fallback}
              onChange={(e) => setFallback(e.target.value)}
              placeholder="claude-3-5-haiku"
              style={{ width: "100%", marginTop: 6 }}
            />
          </div>
        )}

        <div>
          <label className="field-label" htmlFor="budget-alert">
            Alert threshold (% of monthly cap)
          </label>
          <input
            id="budget-alert"
            className="input mono"
            inputMode="numeric"
            value={alertPct}
            onChange={(e) => setAlertPct(e.target.value)}
            placeholder="80 (blank = no alert)"
            style={{ width: "100%", marginTop: 6 }}
          />
          <div
            style={{
              fontSize: "var(--text-xs)",
              color: "var(--ink-3)",
              marginTop: 5,
            }}
          >
            Crossing it notifies your channels that have the budget-alert event
            enabled — at most once per calendar month.
          </div>
        </div>

        <div style={{ fontSize: "var(--text-xs)", color: "var(--ink-3)" }}>
          {action === "pause"
            ? "Caps apply live, per run. Over the monthly cap, runs pause as " +
              '"awaiting budget" and resume automatically when you raise the ' +
              "cap or the month rolls over."
            : action === "downgrade"
              ? "Caps apply live, per run — over the monthly cap, agent calls " +
                "swap to the fallback model instead of stopping."
              : "Caps apply live, per run — the per-run cap and step limit stop " +
                "a single run; the monthly cap governs the workspace."}
        </div>
      </div>
    </Dialog>
  );
}
