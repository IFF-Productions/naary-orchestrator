import { useEffect, useState } from "react";
import { Button, Card, Icon, StatusPill } from "../../components";
import {
  api,
  type GraphSummary,
  type ScheduleRow,
  UnauthorizedError,
} from "../../lib/api";

/** A few friendly cron presets (value = cron expression). */
const PRESETS: { label: string; cron: string }[] = [
  { label: "Every hour", cron: "0 * * * *" },
  { label: "Daily 9am", cron: "0 9 * * *" },
  { label: "Weekdays 9am", cron: "0 9 * * 1-5" },
  { label: "Every Monday 8am", cron: "0 8 * * 1" },
];

const COLS = "1.4fr 1fr 1.1fr 0.7fr 1.2fr";

function when(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function Schedules() {
  const [tenant, setTenant] = useState<string | null>(null);
  const [rows, setRows] = useState<ScheduleRow[] | null>(null);
  const [graphs, setGraphs] = useState<GraphSummary[]>([]);
  const [workflowKey, setWorkflowKey] = useState("");
  const [cron, setCron] = useState("0 9 * * 1-5");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load(tenantId: string): Promise<void> {
    setRows(await api.listSchedules(tenantId));
  }

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const me = await api.getMe();
        if (!live) return;
        setTenant(me.tenantId);
        const [gs] = await Promise.all([api.listGraphs(), load(me.tenantId)]);
        if (!live) return;
        setGraphs(gs);
        if (gs[0]) setWorkflowKey(gs[0].workflowKey);
      } catch (e) {
        if (live)
          setError(
            e instanceof UnauthorizedError
              ? "Not authenticated — sign in (or set an API token)."
              : "Could not reach the control plane.",
          );
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  async function create(): Promise<void> {
    if (!tenant || !workflowKey || !cron.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.createSchedule(tenant, { workflowKey, cron: cron.trim() });
      await load(tenant);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create schedule.");
    } finally {
      setBusy(false);
    }
  }

  async function act(fn: () => Promise<void>): Promise<void> {
    if (!tenant) return;
    setError(null);
    try {
      await fn();
      await load(tenant);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed.");
    }
  }

  return (
    <div style={{ padding: "22px 28px 40px", maxWidth: 1100 }}>
      <div style={{ marginBottom: 16 }}>
        <div
          style={{ fontSize: 21, fontWeight: 700, letterSpacing: "-0.01em" }}
        >
          Schedules
        </div>
        <div style={{ fontSize: 12.5, color: "var(--ink-2)", marginTop: 2 }}>
          Run a saved workflow on a recurring cron (durable Temporal Schedules).
        </div>
      </div>

      {error && (
        <div
          style={{
            marginBottom: 14,
            padding: "9px 12px",
            borderRadius: 8,
            background: "var(--error-soft)",
            border:
              "1px solid color-mix(in srgb, var(--state-error) 40%, transparent)",
            color: "var(--state-error)",
            fontSize: 12,
          }}
        >
          {error}
        </div>
      )}

      {/* create */}
      <Card style={{ padding: 16, marginBottom: 18 }}>
        <strong style={{ fontSize: 14 }}>New schedule</strong>
        <div
          style={{
            display: "flex",
            gap: 10,
            alignItems: "flex-end",
            marginTop: 12,
            flexWrap: "wrap",
          }}
        >
          <label style={{ fontSize: 12, color: "var(--ink-2)" }}>
            Workflow
            <select
              value={workflowKey}
              onChange={(e) => setWorkflowKey(e.target.value)}
              style={{
                ...field,
                display: "block",
                marginTop: 4,
                minWidth: 200,
              }}
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
          </label>
          <label style={{ fontSize: 12, color: "var(--ink-2)" }}>
            Cron
            <input
              value={cron}
              onChange={(e) => setCron(e.target.value)}
              className="mono"
              style={{ ...field, display: "block", marginTop: 4, width: 160 }}
              placeholder="0 9 * * 1-5"
            />
          </label>
          <Button
            variant="primary"
            icon="plus"
            onClick={create}
            disabled={busy || !workflowKey}
          >
            {busy ? "Creating…" : "Create"}
          </Button>
        </div>
        <div
          style={{ display: "flex", gap: 6, marginTop: 10, flexWrap: "wrap" }}
        >
          {PRESETS.map((p) => (
            <button
              key={p.cron}
              type="button"
              onClick={() => setCron(p.cron)}
              className="mono"
              style={{
                fontSize: 10.5,
                cursor: "pointer",
                border: `1px solid ${cron === p.cron ? "var(--brand)" : "var(--line-2)"}`,
                color: cron === p.cron ? "var(--brand)" : "var(--ink-2)",
                background: "var(--card)",
                padding: "3px 9px",
                borderRadius: 6,
              }}
            >
              {p.label}
            </button>
          ))}
        </div>
      </Card>

      {/* list */}
      <Card pad={false} style={{ overflow: "hidden" }}>
        <div
          className="mono"
          style={{
            display: "grid",
            gridTemplateColumns: COLS,
            gap: 10,
            padding: "10px 18px",
            borderBottom: "1px solid var(--line)",
            fontSize: 9.5,
            fontWeight: 600,
            letterSpacing: "0.08em",
            color: "var(--ink-3)",
            textTransform: "uppercase",
          }}
        >
          <span>Workflow</span>
          <span>Cron</span>
          <span>Next run</span>
          <span>Status</span>
          <span />
        </div>

        {rows === null && !error && (
          <div style={{ padding: 18, fontSize: 12.5, color: "var(--ink-3)" }}>
            Loading…
          </div>
        )}
        {rows?.length === 0 && (
          <div style={{ padding: 18, fontSize: 12.5, color: "var(--ink-2)" }}>
            No schedules yet — create one above.
          </div>
        )}
        {rows?.map((r) => (
          <div
            key={r.id}
            data-testid="schedule-row"
            style={{
              display: "grid",
              gridTemplateColumns: COLS,
              gap: 10,
              padding: "12px 18px",
              borderBottom: "1px solid var(--line)",
              alignItems: "center",
            }}
          >
            <span style={{ fontSize: 12.5, fontWeight: 500 }}>
              {r.workflowKey}
            </span>
            <span
              className="mono"
              style={{ fontSize: 11.5, color: "var(--ink-2)" }}
            >
              {r.cron}
            </span>
            <span
              className="mono"
              style={{ fontSize: 11, color: "var(--ink-3)" }}
            >
              {r.paused ? "paused" : when(r.nextRunAt)}
            </span>
            <span>
              <StatusPill
                state={r.paused ? "paused" : "running"}
                label={r.paused ? "Paused" : "Active"}
              />
            </span>
            <span
              style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}
            >
              <Button
                variant="secondary"
                onClick={() => act(() => api.runScheduleNow(tenant!, r.id))}
                title="Run now"
              >
                Run now
              </Button>
              <Button
                variant="secondary"
                onClick={() =>
                  act(() => api.setSchedulePaused(tenant!, r.id, !r.paused))
                }
              >
                {r.paused ? "Resume" : "Pause"}
              </Button>
              <Button
                variant="secondary"
                iconOnly
                icon="x"
                aria-label="Delete schedule"
                onClick={() => act(() => api.deleteSchedule(tenant!, r.id))}
              />
            </span>
          </div>
        ))}
      </Card>
    </div>
  );
}

const field: React.CSSProperties = {
  padding: "7px 9px",
  borderRadius: 7,
  border: "1px solid var(--line-2)",
  background: "var(--card)",
  color: "var(--ink)",
  fontSize: 13,
};
