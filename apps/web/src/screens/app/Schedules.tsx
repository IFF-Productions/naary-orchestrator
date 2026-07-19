/**
 * Schedules (redesign, "Naary Schedules.dc.html") — time-triggered workflows in the
 * active environment (the shell's env switcher scopes the list; the API resolves env
 * from the request header).
 *
 * - "Next to fire" banner: the soonest-firing ACTIVE schedule with a live countdown,
 *   plus ACTIVE / PAUSED / RUNS-24H stats.
 * - Next fire = Temporal's `nextRunAt` when the API returns it; otherwise computed
 *   client-side from the cron (UTC) via ./schedules/cron — see that module.
 * - Last run = the workflow's most recent run from the Runs list (any trigger — the
 *   API doesn't distinguish scheduled from manual runs).
 * - Pause/resume is the design's pill switch, wired to the real pause machinery;
 *   paused rows dim. Run-now + delete keep the old screen's capabilities.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Button,
  EmptyState,
  Icon,
  Skeleton,
  Switch,
  Toast,
} from "../../components";
import {
  api,
  type Environment,
  type GraphSummary,
  type RunSummary,
  type ScheduleRow,
  UnauthorizedError,
} from "../../lib/api";
import { runStatusUi } from "../../lib/run-status";
import { useActiveEnvironment } from "../../lib/useActiveEnvironment";
import { envAccent } from "../../workspace/EnvironmentSwitcher";
import {
  absolute,
  ago,
  countdown,
  humanizeCron,
  nextFire,
} from "./schedules/cron";
import { NewScheduleDialog } from "./schedules/NewScheduleDialog";

const COLS = "2fr 1.2fr 1.1fr 1.2fr 0.7fr 1fr";

/** The Runs list caps at this many recent rows — if it's saturated, 24h counts are a floor. */
const RUNS_LIST_CAP = 50;

/** StatusPill state → dot color token, for the last-run glow dot. */
const DOT: Record<string, string> = {
  running: "var(--state-running)",
  paused: "var(--state-paused)",
  done: "var(--state-done)",
  error: "var(--state-error)",
  idle: "var(--ink-3)",
};

interface ToastItem {
  id: number;
  kind: "info" | "done" | "error";
  text: string;
}

export function Schedules() {
  const activeEnv = useActiveEnvironment();
  const [tenant, setTenant] = useState<string | null>(null);
  const [rows, setRows] = useState<ScheduleRow[] | null>(null);
  const [graphs, setGraphs] = useState<GraphSummary[]>([]);
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [envs, setEnvs] = useState<Environment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(() => new Set());
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  // Ticks every 30s so countdowns stay fresh without refetching.
  const [now, setNow] = useState(() => new Date());

  const timeouts = useRef<ReturnType<typeof setTimeout>[]>([]);
  const toastId = useRef(0);
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => {
      clearInterval(t);
      for (const h of timeouts.current) clearTimeout(h);
    };
  }, []);

  const toast = useCallback((kind: ToastItem["kind"], text: string) => {
    const id = ++toastId.current;
    setToasts((ts) => [...ts, { id, kind, text }]);
    timeouts.current.push(
      setTimeout(() => setToasts((ts) => ts.filter((t) => t.id !== id)), 2600),
    );
  }, []);

  const load = useCallback(async () => {
    try {
      const me = await api.getMe();
      setTenant(me.tenantId);
      // Schedules + workflows are the screen; runs/envs only enrich it — their
      // failure degrades the last-run column + env chip, not the whole screen.
      const [schedules, gs] = await Promise.all([
        api.listSchedules(me.tenantId),
        api.listGraphs(),
      ]);
      setRows(schedules);
      setGraphs(gs);
      setError(null);
      api
        .listRuns()
        .then(setRuns)
        .catch(() => setRuns(null));
      api
        .listEnvironments(me.tenantId)
        .then(setEnvs)
        .catch(() => setEnvs([]));
    } catch (e) {
      setError(
        e instanceof UnauthorizedError
          ? "Not authenticated — sign in (or set an API token)."
          : "Could not reach the control plane.",
      );
    }
  }, []);

  // Env switch rescopes the list (the API reads the active env from the header).
  useEffect(() => {
    setRows(null);
    setRuns(null);
    void load();
  }, [load, activeEnv]);

  /* ---------- derivations ---------- */

  const nameOf = (key: string): string =>
    graphs.find((g) => g.workflowKey === key)?.name ?? key;

  /** Next fire: Temporal's nextRunAt when present, else computed from the cron (UTC). */
  const fireAt = (r: ScheduleRow): Date | null => {
    if (r.paused) return null;
    if (r.nextRunAt) return new Date(r.nextRunAt);
    return nextFire(r.cron, now);
  };

  const list = rows ?? [];
  const active = list.filter((r) => !r.paused);
  const pausedCount = list.length - active.length;

  const soonest = active
    .map((r) => ({ r, at: fireAt(r) }))
    .filter((x): x is { r: ScheduleRow; at: Date } => x.at !== null)
    .sort((a, b) => a.at.getTime() - b.at.getTime())[0];

  // Runs in the last 24h for scheduled workflows. The Runs list is capped, so if it
  // came back saturated and even its oldest row is <24h old, the count is a floor.
  const scheduledKeys = new Set(list.map((r) => r.workflowKey));
  const dayAgo = now.getTime() - 24 * 3600_000;
  const runs24 =
    runs === null
      ? null
      : runs.filter(
          (x) =>
            x.workflowKey !== null &&
            scheduledKeys.has(x.workflowKey) &&
            new Date(x.startedAt).getTime() >= dayAgo,
        ).length;
  const runs24Floor =
    runs !== null &&
    runs.length >= RUNS_LIST_CAP &&
    runs.every((x) => new Date(x.startedAt).getTime() >= dayAgo);

  /** The workflow's most recent run (any trigger), for the last-run column. */
  const lastRunOf = (key: string): RunSummary | null => {
    if (runs === null) return null;
    let best: RunSummary | null = null;
    for (const x of runs) {
      if (x.workflowKey !== key) continue;
      if (!best || new Date(x.startedAt) > new Date(best.startedAt)) best = x;
    }
    return best;
  };

  // The env every row lives in = the shell's active env (the list is env-scoped);
  // resolve its display name + accent, falling back to the workspace default env.
  const envObj =
    envs.find((e) => e.slug === activeEnv || e.id === activeEnv) ??
    (activeEnv === null ? envs.find((e) => e.isDefault) : undefined);

  /* ---------- actions ---------- */

  async function togglePause(r: ScheduleRow): Promise<void> {
    if (!tenant || busyIds.has(r.id)) return;
    const paused = !r.paused;
    setBusyIds((s) => new Set(s).add(r.id));
    // Optimistic flip (nextRunAt cleared — Temporal recomputes; the cron fallback covers the gap).
    setRows(
      (prev) =>
        prev?.map((x) =>
          x.id === r.id ? { ...x, paused, nextRunAt: null } : x,
        ) ?? null,
    );
    try {
      await api.setSchedulePaused(tenant, r.id, paused);
      toast(
        paused ? "info" : "done",
        `${paused ? "Paused" : "Resumed"} “${nameOf(r.workflowKey)}”`,
      );
      const fresh = await api.listSchedules(tenant);
      setRows(fresh);
    } catch {
      setRows((prev) => prev?.map((x) => (x.id === r.id ? r : x)) ?? null);
      toast("error", `Could not ${paused ? "pause" : "resume"} the schedule`);
    } finally {
      setBusyIds((s) => {
        const n = new Set(s);
        n.delete(r.id);
        return n;
      });
    }
  }

  async function runNow(r: ScheduleRow): Promise<void> {
    if (!tenant) return;
    try {
      await api.runScheduleNow(tenant, r.id);
      toast("done", `Started “${nameOf(r.workflowKey)}” — see Runs`);
    } catch {
      toast("error", "Could not trigger the schedule");
    }
  }

  async function remove(r: ScheduleRow): Promise<void> {
    if (!tenant) return;
    try {
      await api.deleteSchedule(tenant, r.id);
      setRows((prev) => prev?.filter((x) => x.id !== r.id) ?? null);
      toast("info", `Deleted the “${nameOf(r.workflowKey)}” schedule`);
    } catch {
      toast("error", "Could not delete the schedule");
    }
  }

  /* ---------- render ---------- */

  return (
    <div
      style={{
        padding: "24px 28px 40px",
        maxWidth: 1200,
        margin: "0 auto",
        animation: "naaryFadeUp .25s ease",
      }}
    >
      {/* header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          marginBottom: 16,
          flexWrap: "wrap",
        }}
      >
        <div>
          <div
            style={{
              fontSize: "var(--text-title)",
              fontWeight: "var(--weight-bold)",
              letterSpacing: "-0.01em",
              color: "var(--ink)",
            }}
          >
            Schedules
          </div>
          <div
            style={{
              fontSize: "var(--text-sm)",
              color: "var(--ink-2)",
              marginTop: 2,
            }}
          >
            Time-triggered workflows
            {rows !== null &&
              ` · ${active.length} active · ${pausedCount} paused`}
          </div>
        </div>
        <Button
          variant="primary"
          icon="plus"
          onClick={() => setDialogOpen(true)}
        >
          New schedule
        </Button>
      </div>

      {error && (
        <div
          style={{
            marginBottom: 14,
            padding: "8px 12px",
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

      {/* next-to-fire banner */}
      <div
        style={{
          border: "1px solid var(--line-mid)",
          background:
            "radial-gradient(120% 200% at 0% 0%, var(--grad-a), var(--panel) 60%)",
          borderRadius: "var(--radius-lg)",
          padding: "16px 20px",
          display: "flex",
          alignItems: "center",
          gap: 15,
          marginBottom: 16,
          flexWrap: "wrap",
        }}
      >
        <div
          style={{
            width: 42,
            height: 42,
            flex: "none",
            borderRadius: 11,
            border: "1px solid var(--node-trigger)",
            color: "var(--node-trigger)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Icon name="clock" size={21} />
        </div>
        <div style={{ flex: 1, minWidth: 180 }}>
          <div
            className="mono"
            style={{
              fontSize: "var(--text-2xs)",
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              color: "var(--ink-3)",
            }}
          >
            Next to fire
          </div>
          <div
            style={{
              fontSize: 15,
              fontWeight: "var(--weight-bold)",
              color: "var(--ink)",
              marginTop: 2,
            }}
          >
            {rows === null ? (
              <Skeleton width={180} height={16} />
            ) : soonest ? (
              <>
                {nameOf(soonest.r.workflowKey)}{" "}
                <span
                  style={{
                    fontSize: "var(--text-sm)",
                    fontWeight: "var(--weight-medium)",
                    color: "var(--ink-2)",
                  }}
                >
                  · fires {countdown(soonest.at, now) ?? "any moment"}
                </span>
              </>
            ) : (
              "Nothing scheduled"
            )}
          </div>
        </div>
        <div style={{ display: "flex", gap: 22 }}>
          {(
            [
              ["ACTIVE", rows === null ? "…" : String(active.length)],
              ["PAUSED", rows === null ? "…" : String(pausedCount)],
              ...(runs24 !== null
                ? [["RUNS 24H", `${runs24}${runs24Floor ? "+" : ""}`]]
                : []),
            ] as [string, string][]
          ).map(([label, value]) => (
            <div key={label}>
              <div
                className="mono"
                style={{ fontSize: "var(--text-2xs)", color: "var(--ink-3)" }}
              >
                {label}
              </div>
              <div
                style={{
                  fontSize: 16,
                  fontWeight: "var(--weight-semibold)",
                  color: "var(--ink)",
                  marginTop: 2,
                }}
              >
                {value}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* table */}
      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        <div
          className="mono"
          style={{
            display: "grid",
            gridTemplateColumns: COLS,
            gap: 10,
            padding: "11px 18px",
            borderBottom: "1px solid var(--line)",
            background: "var(--card-2)",
            fontSize: "var(--text-2xs)",
            fontWeight: "var(--weight-semibold)",
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: "var(--ink-3)",
          }}
        >
          <span>Schedule</span>
          <span>Cadence</span>
          <span>Next fire</span>
          <span>Last run</span>
          <span>Env</span>
          <span />
        </div>

        {rows === null &&
          !error &&
          Array.from({ length: 4 }).map((_, i) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length skeleton placeholder
              key={i}
              style={{
                display: "grid",
                gridTemplateColumns: COLS,
                gap: 10,
                padding: "13px 18px",
                borderBottom: "1px solid var(--line)",
                alignItems: "center",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <Skeleton width={34} height={34} radius={9} />
                <Skeleton width="60%" />
              </div>
              <Skeleton width="70%" />
              <Skeleton width="55%" />
              <Skeleton width="65%" />
              <Skeleton width={52} height={18} radius={10} />
              <span />
            </div>
          ))}

        {rows?.length === 0 && (
          <EmptyState
            icon="clock"
            title="No schedules yet"
            body="Run a saved workflow on a recurring cron. Schedules are durable Temporal Schedules — fires missed during downtime catch up on recovery."
            action={
              <Button
                variant="primary"
                icon="plus"
                onClick={() => setDialogOpen(true)}
              >
                New schedule
              </Button>
            }
          />
        )}

        {rows?.map((r) => {
          const at = fireAt(r);
          const last = lastRunOf(r.workflowKey);
          const lastUi = last ? runStatusUi(last.status) : null;
          const dot = lastUi ? (DOT[lastUi.state] ?? DOT.idle) : null;
          const cadence = humanizeCron(r.cron);
          return (
            <div
              key={r.id}
              data-testid="schedule-row"
              className="run-row"
              style={{
                display: "grid",
                gridTemplateColumns: COLS,
                gap: 10,
                padding: "13px 18px",
                borderBottom: "1px solid var(--line)",
                alignItems: "center",
                opacity: r.paused ? 0.62 : 1,
                transition: "opacity 150ms ease",
              }}
            >
              {/* schedule: icon tile + name + mono cron */}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  minWidth: 0,
                }}
              >
                <span
                  style={{
                    width: 34,
                    height: 34,
                    flex: "none",
                    borderRadius: 9,
                    border: "1px solid var(--node-trigger)",
                    color: "var(--node-trigger)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <Icon name="clock" size={16} />
                </span>
                <div style={{ minWidth: 0 }}>
                  <div
                    style={{
                      fontSize: "var(--text-body)",
                      fontWeight: "var(--weight-semibold)",
                      color: "var(--ink)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {nameOf(r.workflowKey)}
                  </div>
                  <div
                    className="mono"
                    style={{
                      fontSize: "var(--text-2xs)",
                      color: "var(--ink-3)",
                      marginTop: 1,
                    }}
                  >
                    {r.cron}
                  </div>
                </div>
              </div>

              {/* cadence (humanized) + the cron's clock zone */}
              <div
                style={{ fontSize: "var(--text-xs)", color: "var(--ink-soft)" }}
              >
                {cadence === "Custom" ? "Custom cadence" : cadence}
                <div
                  style={{
                    fontSize: "var(--text-2xs)",
                    color: "var(--ink-3)",
                    marginTop: 1,
                  }}
                >
                  UTC
                </div>
              </div>

              {/* next fire: countdown + absolute, or "— paused" */}
              <div style={{ fontSize: "var(--text-xs)" }}>
                {r.paused ? (
                  <span style={{ color: "var(--ink-3)" }}>— paused</span>
                ) : at ? (
                  <>
                    <span
                      style={{
                        color: "var(--ink)",
                        fontWeight: "var(--weight-medium)",
                      }}
                    >
                      {countdown(at, now) ?? "any moment"}
                    </span>
                    <div
                      style={{
                        fontSize: "var(--text-2xs)",
                        color: "var(--ink-3)",
                        marginTop: 1,
                      }}
                    >
                      {absolute(at, now)}
                    </div>
                  </>
                ) : (
                  <span style={{ color: "var(--ink-3)" }}>—</span>
                )}
              </div>

              {/* last run: glow dot + status + age (from the Runs list) */}
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                {last && lastUi && dot ? (
                  <>
                    <span
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: "50%",
                        flex: "none",
                        background: dot,
                        boxShadow: `0 0 7px ${dot}`,
                      }}
                    />
                    <div>
                      <div
                        style={{
                          fontSize: "var(--text-xs)",
                          color: "var(--ink-soft)",
                        }}
                      >
                        {lastUi.label}
                      </div>
                      <div
                        style={{
                          fontSize: "var(--text-2xs)",
                          color: "var(--ink-3)",
                        }}
                      >
                        {ago(last.startedAt, now)}
                      </div>
                    </div>
                  </>
                ) : (
                  <span
                    style={{
                      fontSize: "var(--text-xs)",
                      color: "var(--ink-3)",
                    }}
                  >
                    —
                  </span>
                )}
              </div>

              {/* env chip — the whole list is scoped to the shell's active env */}
              <div>
                {envObj ? (
                  <span
                    className="mono"
                    style={{
                      fontSize: "var(--text-2xs)",
                      fontWeight: "var(--weight-semibold)",
                      color: envAccent(envObj),
                      border: `1px solid ${envAccent(envObj)}`,
                      borderRadius: 20,
                      padding: "2px 8px",
                    }}
                  >
                    {envObj.name}
                  </span>
                ) : (
                  <span
                    style={{
                      fontSize: "var(--text-xs)",
                      color: "var(--ink-3)",
                    }}
                  >
                    —
                  </span>
                )}
              </div>

              {/* actions: run now · delete · pause/resume switch */}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "flex-end",
                  gap: 6,
                }}
              >
                <Button
                  size="sm"
                  variant="ghost"
                  icon="play"
                  iconOnly
                  title="Run now"
                  aria-label={`Run ${nameOf(r.workflowKey)} now`}
                  onClick={() => void runNow(r)}
                />
                <Button
                  size="sm"
                  variant="ghost"
                  icon="trash"
                  iconOnly
                  title="Delete schedule"
                  aria-label={`Delete the ${nameOf(r.workflowKey)} schedule`}
                  onClick={() => void remove(r)}
                />
                <span
                  title={r.paused ? "Resume schedule" : "Pause schedule"}
                  style={{
                    display: "inline-flex",
                    opacity: busyIds.has(r.id) ? 0.5 : 1,
                    pointerEvents: busyIds.has(r.id) ? "none" : undefined,
                  }}
                >
                  <Switch
                    checked={!r.paused}
                    aria-label={`${r.paused ? "Resume" : "Pause"} the ${nameOf(r.workflowKey)} schedule`}
                    onChange={() => void togglePause(r)}
                  />
                </span>
              </div>
            </div>
          );
        })}
      </div>

      {/* durability note — Temporal Schedules catch up missed fires */}
      <div
        style={{
          fontSize: "var(--text-xs)",
          color: "var(--ink-2)",
          marginTop: 14,
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <Icon name="clock" size={14} style={{ color: "var(--ink-3)" }} />
        Times shown in your local zone. Missed fires (downtime) are queued and
        run on recovery — durable by default.
      </div>

      <NewScheduleDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        tenantId={tenant}
        graphs={graphs}
        onCreated={async (name) => {
          toast("done", `Scheduled “${name}”`);
          if (tenant) setRows(await api.listSchedules(tenant));
        }}
      />

      {/* toasts */}
      {toasts.length > 0 && (
        <div
          style={{
            position: "fixed",
            right: 24,
            bottom: 22,
            display: "flex",
            flexDirection: "column",
            alignItems: "flex-end",
            gap: 9,
            zIndex: 60,
          }}
        >
          {/* the shared Toast (.toast) animates its own entrance */}
          {toasts.map((t) => (
            <div key={t.id}>
              <Toast
                kind={t.kind}
                onDismiss={() =>
                  setToasts((ts) => ts.filter((x) => x.id !== t.id))
                }
              >
                {t.text}
              </Toast>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
