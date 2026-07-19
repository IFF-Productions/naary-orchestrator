/**
 * "New schedule" dialog — the existing create flow (workflow + cron + friendly
 * presets) restyled for the redesign. Creates via the same API the old screen
 * used; the caller reloads the list and toasts on success.
 */
import { useState } from "react";
import { Button, Dialog } from "../../../components";
import { api, type GraphSummary } from "../../../lib/api";
import { humanizeCron, nextFire } from "./cron";

/** Friendly cron presets (times are UTC — how Temporal runs the cron). */
export const PRESETS: { label: string; cron: string }[] = [
  { label: "Every hour", cron: "0 * * * *" },
  { label: "Daily 9am", cron: "0 9 * * *" },
  { label: "Weekdays 9am", cron: "0 9 * * 1-5" },
  { label: "Every Monday 8am", cron: "0 8 * * 1" },
];

export function NewScheduleDialog({
  open,
  onClose,
  tenantId,
  graphs,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  tenantId: string | null;
  graphs: GraphSummary[];
  onCreated: (workflowName: string) => void | Promise<void>;
}) {
  const [workflowKey, setWorkflowKey] = useState("");
  const [cron, setCron] = useState("0 9 * * 1-5");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedKey = workflowKey || graphs[0]?.workflowKey || "";
  const cadence = humanizeCron(cron);
  const parses = nextFire(cron) !== null;

  async function create(): Promise<void> {
    if (!tenantId || !selectedKey || !cron.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.createSchedule(tenantId, {
        workflowKey: selectedKey,
        cron: cron.trim(),
      });
      const g = graphs.find((x) => x.workflowKey === selectedKey);
      await onCreated(g?.name ?? selectedKey);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create schedule.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New schedule"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            icon="plus"
            onClick={() => void create()}
            disabled={busy || !selectedKey || !cron.trim()}
            loading={busy}
          >
            {busy ? "Creating…" : "Create schedule"}
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

        <div>
          <label className="field-label" htmlFor="sched-workflow">
            Workflow
          </label>
          <select
            id="sched-workflow"
            className="input"
            value={selectedKey}
            onChange={(e) => setWorkflowKey(e.target.value)}
            style={{ width: "100%", marginTop: 6 }}
          >
            {graphs.length === 0 && (
              <option value="">(no saved workflows)</option>
            )}
            {graphs.map((g) => (
              <option key={g.workflowKey} value={g.workflowKey}>
                {g.name} ({g.workflowKey})
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="field-label" htmlFor="sched-cron">
            Cron expression
          </label>
          <input
            id="sched-cron"
            className="input mono"
            value={cron}
            onChange={(e) => setCron(e.target.value)}
            placeholder="0 9 * * 1-5"
            style={{ width: "100%", marginTop: 6 }}
          />
          <div
            style={{
              marginTop: 6,
              fontSize: "var(--text-xs)",
              color: parses ? "var(--ink-2)" : "var(--state-paused)",
            }}
          >
            {parses
              ? `${cadence === "Custom" ? "Custom cadence" : cadence} · UTC`
              : "Unrecognized cron — Temporal will validate on create."}
          </div>
        </div>

        <div>
          <div className="field-label" style={{ marginBottom: 6 }}>
            Presets
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {PRESETS.map((p) => {
              const active = cron === p.cron;
              return (
                <button
                  key={p.cron}
                  type="button"
                  onClick={() => setCron(p.cron)}
                  className="mono"
                  style={{
                    fontSize: "var(--text-2xs)",
                    cursor: "pointer",
                    border: `1px solid ${active ? "var(--brand)" : "var(--line-2)"}`,
                    color: active ? "var(--brand)" : "var(--ink-2)",
                    background: active ? "var(--brand-soft)" : "var(--card)",
                    padding: "4px 10px",
                    borderRadius: 20,
                    transition: "border-color 140ms ease, color 140ms ease",
                  }}
                >
                  {p.label}
                </button>
              );
            })}
          </div>
        </div>

        <div
          style={{
            fontSize: "var(--text-xs)",
            color: "var(--ink-3)",
            display: "flex",
            alignItems: "center",
            gap: 7,
          }}
        >
          Runs in the active environment. Cron times are UTC; the table shows
          fire times in your local zone.
        </div>
      </div>
    </Dialog>
  );
}
